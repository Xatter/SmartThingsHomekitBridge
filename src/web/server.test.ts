/**
 * WebServer wiring tests.
 *
 * These verify the *pipeline order* added for OIDC (session hardening,
 * trust proxy, and requireAuth sitting between session and express.static /
 * the API route mounts) using a real HTTP server on an ephemeral port. The
 * requireAuth decision table itself (fail-closed on uninitialized OIDC,
 * exempt paths, redirect vs 401, etc.) is unit-tested exhaustively in
 * oidc.test.ts - this file only proves the middleware is actually mounted
 * in the right place in server.ts.
 *
 * openid-client is mocked so nothing here makes a real network call; we
 * deliberately bypass WebServer.start() (which calls bootstrapOidc()) and
 * instead drive the OIDC client's initialized/uninitialized state directly
 * via oidc.ts's test hooks, so these tests stay fast and deterministic.
 */

import http from 'http';
import { AddressInfo } from 'net';
import { WebServer } from './server';
import { __resetOidcStateForTests, initOidc } from './oidc';

jest.mock('openid-client', () => ({
  Issuer: { discover: jest.fn() },
  generators: {
    codeVerifier: jest.fn(() => 'v'),
    codeChallenge: jest.fn(() => 'c'),
    state: jest.fn(() => 's'),
    nonce: jest.fn(() => 'n'),
  },
}));

const ORIGINAL_ENV = { ...process.env };

function startEphemeral(webServer: WebServer): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = webServer.getApp().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function buildWebServer(): WebServer {
  const webServer = new WebServer(0);
  webServer.setupRoutes(
    {} as any, // auth - unused by the routes these tests exercise
    { hasAuth: () => false } as any, // api
    {} as any, // coordinator
    { getQrCode: () => null } as any // hapServer
  );
  return webServer;
}

beforeEach(() => {
  __resetOidcStateForTests();
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('WebServer app configuration', () => {
  test('enables case-sensitive routing and trust proxy (required for secure cookies behind nginx)', () => {
    const webServer = buildWebServer();
    const app = webServer.getApp();

    expect(app.get('case sensitive routing')).toBe(true);
    expect(app.get('trust proxy')).toBe(1);
  });
});

describe('session cookie hardening', () => {
  // /api/health never touches req.session, and express-session (saveUninitialized:
  // false) only sends Set-Cookie once something writes to the session. The
  // SmartThings OAuth start route (GET /api/auth/smartthings) does write
  // (oauthState) and redirects, so it's used here purely as "a route that
  // touches the session" - redirect is captured manually so the test never
  // actually follows it out to api.smartthings.com.
  test('cookie is HttpOnly, SameSite=Lax, and NOT Secure by default (dev/local http)', async () => {
    delete process.env.OIDC_ENABLED;
    delete process.env.SESSION_COOKIE_SECURE;
    const webServer = buildWebServer();
    const { server, baseUrl } = await startEphemeral(webServer);

    try {
      const res = await fetch(`${baseUrl}/api/auth/smartthings`, { redirect: 'manual' });
      const setCookie = res.headers.get('set-cookie') || '';
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Lax/i);
      expect(setCookie).not.toMatch(/Secure/i);
    } finally {
      await stopServer(server);
    }
  });

  test('SESSION_COOKIE_SECURE=true + trust proxy honors X-Forwarded-Proto: https and sets Secure', async () => {
    // With cookie.secure=true, express-session only actually sends the
    // cookie when it considers the request secure - over plain HTTP that's
    // never true, so this simulates gimli's nginx terminating TLS and
    // forwarding proto via X-Forwarded-Proto (which `trust proxy` makes
    // Express honor for req.secure).
    delete process.env.OIDC_ENABLED;
    process.env.SESSION_COOKIE_SECURE = 'true';
    const webServer = buildWebServer();
    const { server, baseUrl } = await startEphemeral(webServer);

    try {
      const res = await fetch(`${baseUrl}/api/auth/smartthings`, {
        redirect: 'manual',
        headers: { 'X-Forwarded-Proto': 'https' },
      });
      const setCookie = res.headers.get('set-cookie') || '';
      expect(setCookie).toMatch(/Secure/i);
    } finally {
      await stopServer(server);
    }
  });

  test('SESSION_COOKIE_SECURE=true over a connection NOT recognized as secure: cookie is withheld entirely', async () => {
    // This is express-session's own (stricter) behavior: rather than send a
    // Secure cookie over what it thinks is a plain-HTTP connection (which
    // browsers would just silently drop anyway), it withholds the
    // Set-Cookie header altogether. Documented here as an explicit
    // assertion so a future change in this area doesn't go unnoticed.
    delete process.env.OIDC_ENABLED;
    process.env.SESSION_COOKIE_SECURE = 'true';
    const webServer = buildWebServer();
    const { server, baseUrl } = await startEphemeral(webServer);

    try {
      const res = await fetch(`${baseUrl}/api/auth/smartthings`, { redirect: 'manual' });
      const setCookie = res.headers.get('set-cookie') || '';
      expect(setCookie).toBe('');
    } finally {
      await stopServer(server);
    }
  });
});

describe('requireAuth is wired in ahead of express.static and the API mounts', () => {
  test('OIDC disabled: static UI and /api/health both serve normally (unchanged dev/local behavior)', async () => {
    delete process.env.OIDC_ENABLED;
    const webServer = buildWebServer();
    const { server, baseUrl } = await startEphemeral(webServer);

    try {
      const home = await fetch(`${baseUrl}/`);
      expect(home.status).toBe(200);

      const health = await fetch(`${baseUrl}/api/health`);
      expect(health.status).toBe(200);
    } finally {
      await stopServer(server);
    }
  });

  test('OIDC enabled but uninitialized: /api/health (exempt) still serves, but the UI and API are denied', async () => {
    process.env.OIDC_ENABLED = 'true';
    const webServer = buildWebServer();
    const { server, baseUrl } = await startEphemeral(webServer);

    try {
      const health = await fetch(`${baseUrl}/api/health`);
      expect(health.status).toBe(200);

      // Static index.html would normally be a 200 from express.static/the
      // catch-all - if requireAuth weren't mounted ahead of them, this
      // would leak through as 200 instead of being denied.
      const home = await fetch(`${baseUrl}/`, { headers: { Accept: 'text/html' } });
      expect(home.status).not.toBe(200);

      // Uninitialized OIDC always denies with 503 (fail closed) regardless
      // of Accept header - 401 is only for the "initialized, no session"
      // case (see oidc.test.ts for that decision-table coverage).
      const api = await fetch(`${baseUrl}/api/plugins`, { headers: { Accept: 'application/json' } });
      expect(api.status).toBe(503);
    } finally {
      await stopServer(server);
    }
  });

  test('OIDC enabled and initialized: unauthenticated navigation is redirected to /login', async () => {
    process.env.OIDC_ENABLED = 'true';
    const { Issuer } = require('openid-client');
    const mockClient = {
      authorizationUrl: jest.fn(),
      callbackParams: jest.fn(),
      callback: jest.fn(),
      endSessionUrl: jest.fn(),
    };
    (Issuer.discover as jest.Mock).mockResolvedValueOnce({
      Client: jest.fn().mockImplementation(() => mockClient),
    });
    await initOidc({
      issuer: 'https://sso.test.example',
      clientId: 'test-client',
      redirectUri: 'https://app.test.example/signin-oidc',
    });

    const webServer = buildWebServer();
    const { server, baseUrl } = await startEphemeral(webServer);

    try {
      const home = await fetch(`${baseUrl}/`, {
        headers: { Accept: 'text/html' },
        redirect: 'manual',
      });
      expect(home.status).toBe(302);
      expect(home.headers.get('location')).toBe('/login');

      // /login itself must stay reachable (it's exempt) even though nobody
      // is authenticated yet - otherwise nobody could ever log in.
      const login = await fetch(`${baseUrl}/login`, { redirect: 'manual' });
      expect(login.status).not.toBe(401);
      expect(login.status).not.toBe(503);
    } finally {
      await stopServer(server);
    }
  });
});
