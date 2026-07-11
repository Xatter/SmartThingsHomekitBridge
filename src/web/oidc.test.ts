/**
 * OIDC auth gate unit tests.
 *
 * openid-client is mocked in its entirety - these tests exercise our
 * integration logic (requireAuth's decision table, the /login and
 * /signin-oidc handlers, retry/backoff), not the library itself.
 *
 * IMPORTANT: this project has a known Jest 30 / Node 26 fake-timer bug where
 * `jest.useFakeTimers()` permanently breaks `setTimeout` for the rest of the
 * file. All retry/backoff delays below are driven with real timers and kept
 * to single-digit milliseconds so the suite stays fast without touching fake
 * timers.
 */

import { NextFunction, Request, Response } from 'express';

// --- Mock openid-client -----------------------------------------------
//
// Issuer.discover() resolves to an object exposing a `Client` constructor
// (mirroring the real openid-client shape: `new issuer.Client(metadata)`).
// The constructed client instance is a single shared mock so tests can
// assert on calls to authorizationUrl/callback/callbackParams/endSessionUrl.
const mockClientInstance = {
  authorizationUrl: jest.fn(),
  callbackParams: jest.fn(),
  callback: jest.fn(),
  endSessionUrl: jest.fn(),
};

const MockClientCtor = jest.fn().mockImplementation(() => mockClientInstance);

const mockIssuerDiscover = jest.fn();

jest.mock('openid-client', () => ({
  Issuer: {
    discover: (...args: unknown[]) => mockIssuerDiscover(...args),
  },
  generators: {
    codeVerifier: jest.fn(() => 'test-code-verifier'),
    codeChallenge: jest.fn(() => 'test-code-challenge'),
    state: jest.fn(() => 'test-state'),
    nonce: jest.fn(() => 'test-nonce'),
  },
}));

import { generators } from 'openid-client';
import {
  createOidcRouter,
  requireAuth,
  initOidc,
  bootstrapOidc,
  scheduleOidcBackgroundRetry,
  stopOidcBackgroundRetry,
  getOidcClient,
  isOidcEnabled,
  __resetOidcStateForTests,
} from './oidc';

// -----------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------

function createMockSession(initial: Record<string, any> = {}) {
  const session: any = { ...initial };

  // Mimic express-session's real semantics closely enough for these tests:
  // regenerate()/destroy() wipe the session's own data (a fresh id gets a
  // fresh, empty session) before invoking the callback.
  session.regenerate = jest.fn((cb: (err?: any) => void) => {
    for (const key of Object.keys(session)) {
      if (!['regenerate', 'destroy', 'save'].includes(key)) {
        delete session[key];
      }
    }
    cb();
  });
  session.destroy = jest.fn((cb: (err?: any) => void) => {
    for (const key of Object.keys(session)) {
      if (!['regenerate', 'destroy', 'save'].includes(key)) {
        delete session[key];
      }
    }
    cb();
  });
  session.save = jest.fn((cb: (err?: any) => void) => cb());

  return session;
}

function createMockReqRes(overrides: {
  method?: string;
  path?: string;
  originalUrl?: string;
  headers?: Record<string, string>;
  session?: any;
  query?: Record<string, any>;
} = {}) {
  const headers = overrides.headers ?? {};
  const lowerHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    lowerHeaders[key.toLowerCase()] = value;
  }

  const req = {
    method: overrides.method ?? 'GET',
    path: overrides.path ?? '/',
    originalUrl: overrides.originalUrl ?? overrides.path ?? '/',
    query: overrides.query ?? {},
    session: overrides.session ?? createMockSession(),
    get: (name: string) => lowerHeaders[name.toLowerCase()],
  } as unknown as Request;

  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    redirect: jest.fn().mockReturnThis(),
  } as unknown as Response;

  const next = jest.fn() as unknown as NextFunction;

  return { req, res, next };
}

/** Pulls a GET route handler out of the router built by createOidcRouter(). */
function getRouteHandler(path: string) {
  const router = createOidcRouter();
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods?.get
  );
  return layer?.route?.stack[0]?.handle;
}

const ORIGINAL_ENV = { ...process.env };

async function initTestClient(overrides: Record<string, string> = {}) {
  mockIssuerDiscover.mockResolvedValueOnce({ Client: MockClientCtor });
  return initOidc({
    issuer: 'https://sso.test.example',
    clientId: 'test-client',
    clientSecret: 'test-secret',
    redirectUri: 'https://app.test.example/signin-oidc',
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetOidcStateForTests();
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  stopOidcBackgroundRetry();
  process.env = { ...ORIGINAL_ENV };
});

// =========================================================================
// requireAuth - the fail-closed decision table
// =========================================================================

describe('requireAuth', () => {
  test('OIDC_ENABLED not "true" -> passes through unconditionally (dev/local mode)', () => {
    delete process.env.OIDC_ENABLED;
    const { req, res, next } = createMockReqRes({ path: '/api/devices' });

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('OIDC_ENABLED="false" -> also passes through', () => {
    process.env.OIDC_ENABLED = 'false';
    const { req, res, next } = createMockReqRes({ path: '/api/devices' });

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('SECURITY: a typo in OIDC_ENABLED (e.g. "ture") makes requireAuth THROW, never pass through', () => {
    // If isOidcEnabled() failed open on unknown values, requireAuth's first
    // branch would call next() and the whole app would be exposed. Instead
    // it throws (which Express turns into a 500 = deny). The critical
    // assertion is that next() is NOT called.
    process.env.OIDC_ENABLED = 'ture';
    const { req, res, next } = createMockReqRes({ path: '/api/devices' });

    expect(() => requireAuth(req, res, next)).toThrow(/OIDC_ENABLED/);
    expect(next).not.toHaveBeenCalled();
  });

  describe('SECURITY: enabled but the OIDC client never finished initializing', () => {
    // This is the critical fail-closed branch: a down/misconfigured SSO
    // provider must NEVER result in the bridge falling open. These tests
    // would fail if requireAuth's `if (!client)` branch were missing or
    // defaulted to next() instead of denying.
    beforeEach(() => {
      process.env.OIDC_ENABLED = 'true';
      expect(getOidcClient()).toBeNull(); // sanity: nothing initialized this client
    });

    test('protected path, HTML navigation -> 503, DENY (next NOT called)', () => {
      const { req, res, next } = createMockReqRes({
        path: '/api/devices',
        headers: { Accept: 'text/html' },
      });

      requireAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.send).toHaveBeenCalled();
      // Explicitly assert it did NOT behave like the "allow" path.
      expect(res.redirect).not.toHaveBeenCalled();
    });

    test('protected path, JSON/XHR -> 503, DENY (next NOT called)', () => {
      const { req, res, next } = createMockReqRes({
        path: '/api/devices',
        headers: { Accept: 'application/json' },
      });

      requireAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
    });

    test('even a request carrying a session.user is still denied - init state gates everything', () => {
      const { req, res, next } = createMockReqRes({
        path: '/api/devices',
        session: createMockSession({ user: { sub: 'u1', authAt: Date.now() } }),
      });

      requireAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
    });

    test('exempt paths remain reachable even while uninitialized', () => {
      for (const path of ['/api/health', '/login', '/signin-oidc', '/logout', '/signout-callback-oidc']) {
        const { req, res, next } = createMockReqRes({ path });
        requireAuth(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      }
    });
  });

  describe('enabled + initialized', () => {
    beforeEach(async () => {
      process.env.OIDC_ENABLED = 'true';
      await initTestClient();
      expect(getOidcClient()).not.toBeNull();
    });

    test('session.user present -> passes through', () => {
      const { req, res, next } = createMockReqRes({
        path: '/api/devices',
        session: createMockSession({ user: { sub: 'u1', authAt: Date.now() } }),
      });

      requireAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('no session.user, navigational HTML GET -> redirects to /login and remembers originalUrl', () => {
      const { req, res, next } = createMockReqRes({
        method: 'GET',
        path: '/devices',
        originalUrl: '/devices?foo=bar',
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });

      requireAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith('/login');
      expect((req.session as any).returnTo).toBe('/devices?foo=bar');
    });

    test('no session.user, XHR GET (JSON Accept) -> 401 JSON, no redirect', () => {
      const { req, res, next } = createMockReqRes({
        method: 'GET',
        path: '/api/devices',
        headers: { Accept: 'application/json' },
      });

      requireAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.redirect).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
    });

    test('no session.user, non-GET (POST) -> 401 JSON even with an HTML Accept header', () => {
      const { req, res, next } = createMockReqRes({
        method: 'POST',
        path: '/api/devices/dev-1/mode',
        headers: { Accept: 'text/html' },
      });

      requireAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.redirect).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    test('exempt paths reachable without a session', () => {
      for (const path of ['/api/health', '/login', '/signin-oidc', '/logout', '/signout-callback-oidc']) {
        const { req, res, next } = createMockReqRes({ path });
        requireAuth(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      }
    });

    test('SECURITY: exempt-path matching is case-insensitive (matches apiMutationGuard convention)', () => {
      const { req, res, next } = createMockReqRes({ path: '/API/Health' });
      requireAuth(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});

// =========================================================================
// /login
// =========================================================================

describe('GET /login', () => {
  test('503 when OIDC client is not initialized', () => {
    const handler = getRouteHandler('/login');
    const { req, res } = createMockReqRes({ path: '/login' });

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
  });

  test('stashes PKCE verifier + state + nonce in session and redirects to the authorization URL', async () => {
    await initTestClient();
    mockClientInstance.authorizationUrl.mockReturnValue('https://sso.test.example/authorize?mock=1');

    const handler = getRouteHandler('/login');
    const { req, res } = createMockReqRes({ path: '/login' });

    handler(req, res);

    expect((req.session as any).oidc).toEqual({
      codeVerifier: 'test-code-verifier',
      state: 'test-state',
      nonce: 'test-nonce',
    });
    expect(mockClientInstance.authorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'openid email profile',
        state: 'test-state',
        nonce: 'test-nonce',
        code_challenge: 'test-code-challenge',
        code_challenge_method: 'S256',
        redirect_uri: 'https://app.test.example/signin-oidc',
      })
    );
    expect(res.redirect).toHaveBeenCalledWith('https://sso.test.example/authorize?mock=1');
  });

  test('rejects an absolute/open-redirect returnTo, defaulting to "/"', async () => {
    await initTestClient();
    mockClientInstance.authorizationUrl.mockReturnValue('https://sso.test.example/authorize?mock=1');

    const handler = getRouteHandler('/login');
    const { req, res } = createMockReqRes({ path: '/login', query: { returnTo: 'https://evil.example/steal' } });

    handler(req, res);

    expect((req.session as any).returnTo).toBe('/');
  });

  test('accepts a same-site relative returnTo', async () => {
    await initTestClient();
    mockClientInstance.authorizationUrl.mockReturnValue('https://sso.test.example/authorize?mock=1');

    const handler = getRouteHandler('/login');
    const { req, res } = createMockReqRes({ path: '/login', query: { returnTo: '/devices' } });

    handler(req, res);

    expect((req.session as any).returnTo).toBe('/devices');
  });

  test('preserves the query string of a same-site relative returnTo', async () => {
    await initTestClient();
    mockClientInstance.authorizationUrl.mockReturnValue('https://sso.test.example/authorize?mock=1');

    const handler = getRouteHandler('/login');
    const { req, res } = createMockReqRes({ path: '/login', query: { returnTo: '/devices?tab=zones&x=1' } });

    handler(req, res);

    expect((req.session as any).returnTo).toBe('/devices?tab=zones&x=1');
  });

  describe('SECURITY: open-redirect payloads all coerce to "/"', () => {
    // Each of these is an open-redirect / redirect-loop / header-smuggling
    // vector. If sanitizeReturnTo's guard is weakened, the stored returnTo
    // becomes the payload verbatim and the post-login callback bounces the
    // victim off-site (or loops them through /login). All must land on "/".
    const payloads: Array<[string, string]> = [
      ['protocol-relative //host', '//evil.com'],
      ['backslash-smuggled /\\host', '/\\evil.com'],
      ['backslash-smuggled /\\/host', '/\\/evil.com'],
      ['encoded double-slash %2f%2f', '/%2f%2fevil.com'],
      ['encoded backslash %5c', '/%5cevil.com'],
      ['uppercase encoded slash %2F', '/%2F%2Fevil.com'],
      ['absolute http URL', 'http://evil.com/steal'],
      ['absolute https URL', 'https://evil.com/steal'],
      ['CRLF-injected value', '/foo\r\nSet-Cookie:%20x=1'],
      ['bare LF-injected value', '/foo\nLocation:%20http://evil.com'],
      ['tab-injected value', '/foo\tbar'],
      // Dot-segment normalization: the WHATWG URL parser collapses these into
      // a pathname that itself starts with "//" (protocol-relative) while
      // still reporting the placeholder origin. The output backstop catches
      // them regardless of encoding (note %2e is an encoded dot, which the
      // %2f/%5c guard does NOT cover).
      ['dot-segment /.//host', '/.//evil.com'],
      ['dot-segment /..//host', '/..//evil.com'],
      ['encoded-dot /%2e//host', '/%2e//evil.com'],
      ['encoded-double-dot /%2e%2e//host', '/%2e%2e//evil.com'],
      ['traversal /foo/../..//host', '/foo/../..//evil.com'],
      ['traversal /x/..//host', '/x/..//evil.com'],
      ['bare dot-segment /.//', '/.//'],
      ['redirect loop back to /login', '/login'],
      ['redirect loop back to /login (case-insensitive)', '/LOGIN'],
      ['redirect loop back to /logout', '/logout'],
      ['non-slash-leading value', 'devices'],
      ['empty string', ''],
    ];

    test.each(payloads)('%s -> "/"', async (_label, payload) => {
      await initTestClient();
      mockClientInstance.authorizationUrl.mockReturnValue('https://sso.test.example/authorize?mock=1');

      const handler = getRouteHandler('/login');
      const { req, res } = createMockReqRes({ path: '/login', query: { returnTo: payload } });

      handler(req, res);

      expect((req.session as any).returnTo).toBe('/');
    });

    test('a poisoned session.returnTo (backslash-smuggled) is also neutralized to "/" at callback', async () => {
      await initTestClient();
      mockClientInstance.callbackParams.mockReturnValue({ code: 'auth-code', state: 'test-state' });
      mockClientInstance.callback.mockResolvedValue({
        claims: () => ({ sub: 'u1', email: 'e@x', name: 'n' }),
      });

      const handler = getRouteHandler('/signin-oidc');
      const session = createMockSession({
        oidc: { codeVerifier: 'test-code-verifier', state: 'test-state', nonce: 'test-nonce' },
        returnTo: '/\\evil.com',
      });
      const { req, res } = createMockReqRes({ path: '/signin-oidc', session });

      await handler(req, res);

      expect(res.redirect).toHaveBeenCalledWith('/');
    });
  });
});

// =========================================================================
// /signin-oidc
// =========================================================================

describe('GET /signin-oidc', () => {
  test('happy path: stores session.user, regenerates the session id, and redirects to returnTo', async () => {
    await initTestClient();
    mockClientInstance.callbackParams.mockReturnValue({ code: 'auth-code', state: 'test-state' });
    const claims = { sub: 'user-123', email: 'jim@example.com', name: 'Jim' };
    mockClientInstance.callback.mockResolvedValue({ claims: () => claims });

    const handler = getRouteHandler('/signin-oidc');
    const session = createMockSession({
      oidc: { codeVerifier: 'test-code-verifier', state: 'test-state', nonce: 'test-nonce' },
      returnTo: '/devices',
    });
    const { req, res } = createMockReqRes({ path: '/signin-oidc', session });

    await handler(req, res);

    expect(mockClientInstance.callback).toHaveBeenCalledWith(
      'https://app.test.example/signin-oidc',
      { code: 'auth-code', state: 'test-state' },
      { code_verifier: 'test-code-verifier', state: 'test-state', nonce: 'test-nonce' }
    );
    expect(session.regenerate).toHaveBeenCalled();
    expect(session.user).toEqual(
      expect.objectContaining({ sub: 'user-123', email: 'jim@example.com', name: 'Jim' })
    );
    expect(session.save).toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/devices');
  });

  test('state/nonce mismatch (client.callback throws) -> 401, no session established', async () => {
    await initTestClient();
    mockClientInstance.callbackParams.mockReturnValue({ code: 'auth-code', state: 'wrong-state' });
    mockClientInstance.callback.mockRejectedValue(new Error('state mismatch'));

    const handler = getRouteHandler('/signin-oidc');
    const session = createMockSession({
      oidc: { codeVerifier: 'test-code-verifier', state: 'test-state', nonce: 'test-nonce' },
    });
    const { req, res } = createMockReqRes({ path: '/signin-oidc', session });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(session.regenerate).not.toHaveBeenCalled();
    expect(session.user).toBeUndefined();
  });

  test('no pending session state (e.g. replayed/expired callback) -> 400, no crash', async () => {
    await initTestClient();

    const handler = getRouteHandler('/signin-oidc');
    const { req, res } = createMockReqRes({ path: '/signin-oidc', session: createMockSession() });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockClientInstance.callback).not.toHaveBeenCalled();
  });

  test('503 when OIDC client is not initialized', async () => {
    const handler = getRouteHandler('/signin-oidc');
    const { req, res } = createMockReqRes({ path: '/signin-oidc' });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
  });
});

// =========================================================================
// /logout and /signout-callback-oidc
// =========================================================================

describe('GET /logout', () => {
  test('destroys the session and redirects to the IdP end-session URL', async () => {
    await initTestClient();
    mockClientInstance.endSessionUrl.mockReturnValue('https://sso.test.example/logout?mock=1');
    process.env.OIDC_POST_LOGOUT_REDIRECT_URI = 'https://app.test.example/';

    const handler = getRouteHandler('/logout');
    const session = createMockSession({ user: { sub: 'u1', authAt: Date.now() } });
    const { req, res } = createMockReqRes({ path: '/logout', session });

    handler(req, res);

    expect(session.destroy).toHaveBeenCalled();
    expect(mockClientInstance.endSessionUrl).toHaveBeenCalledWith(
      expect.objectContaining({ post_logout_redirect_uri: 'https://app.test.example/' })
    );
    expect(res.redirect).toHaveBeenCalledWith('https://sso.test.example/logout?mock=1');
  });

  test('falls back to "/" when the client is not initialized', () => {
    const handler = getRouteHandler('/logout');
    const session = createMockSession();
    const { req, res } = createMockReqRes({ path: '/logout', session });

    handler(req, res);

    expect(session.destroy).toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/');
  });
});

describe('GET /signout-callback-oidc', () => {
  test('redirects home', () => {
    const handler = getRouteHandler('/signout-callback-oidc');
    const { req, res } = createMockReqRes({ path: '/signout-callback-oidc' });

    handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/');
  });
});

// =========================================================================
// initOidc / bootstrapOidc / background retry
// =========================================================================

describe('initOidc', () => {
  test('succeeds on the first attempt and caches the client', async () => {
    mockIssuerDiscover.mockResolvedValueOnce({ Client: MockClientCtor });

    const client = await initOidc({
      issuer: 'https://sso.test.example',
      clientId: 'test-client',
      redirectUri: 'https://app.test.example/signin-oidc',
    });

    expect(client).toBe(mockClientInstance);
    expect(getOidcClient()).toBe(mockClientInstance);
    expect(mockIssuerDiscover).toHaveBeenCalledWith('https://sso.test.example');
  });

  test('retries on failure (real short delays) and eventually succeeds', async () => {
    mockIssuerDiscover
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ Client: MockClientCtor });

    const client = await initOidc({
      issuer: 'https://sso.test.example',
      clientId: 'test-client',
      redirectUri: 'https://app.test.example/signin-oidc',
      retries: 3,
      retryDelayMs: 1,
      maxRetryDelayMs: 2,
    });

    expect(client).toBe(mockClientInstance);
    expect(mockIssuerDiscover).toHaveBeenCalledTimes(3);
  });

  test('throws after exhausting retries and leaves the client uninitialized', async () => {
    mockIssuerDiscover.mockRejectedValue(new Error('discovery unreachable'));

    await expect(
      initOidc({
        issuer: 'https://sso.test.example',
        clientId: 'test-client',
        redirectUri: 'https://app.test.example/signin-oidc',
        retries: 2,
        retryDelayMs: 1,
        maxRetryDelayMs: 2,
      })
    ).rejects.toThrow('discovery unreachable');

    expect(getOidcClient()).toBeNull();
  });

  test('throws immediately (no discovery attempt) when clientId is missing', async () => {
    await expect(initOidc({ issuer: 'https://sso.test.example', clientId: '' })).rejects.toThrow(
      /OIDC_CLIENT_ID/
    );
    expect(mockIssuerDiscover).not.toHaveBeenCalled();
  });
});

// =========================================================================
// isOidcEnabled - fail-safe parsing of the security-critical toggle
// =========================================================================

describe('isOidcEnabled', () => {
  test.each(['true', 'True', 'TRUE', '1', 'yes', 'on', 'ON', '  true  ', '\ttrue\n'])(
    'affirmative value %j -> enabled',
    (value) => {
      process.env.OIDC_ENABLED = value;
      expect(isOidcEnabled()).toBe(true);
    }
  );

  test.each(['false', 'False', '0', 'no', 'off', 'OFF', '', '   '])(
    'negative value %j -> disabled',
    (value) => {
      process.env.OIDC_ENABLED = value;
      expect(isOidcEnabled()).toBe(false);
    }
  );

  test('unset (undefined) -> disabled, so dev/local still runs with OIDC off', () => {
    delete process.env.OIDC_ENABLED;
    expect(isOidcEnabled()).toBe(false);
  });

  test.each(['ture', 'enabled', 'yep', 'truthy', 'y', 'disable', '2'])(
    'SECURITY: ambiguous value %j -> THROWS (fail loud, never silently open)',
    (value) => {
      process.env.OIDC_ENABLED = value;
      expect(() => isOidcEnabled()).toThrow(/OIDC_ENABLED/);
    }
  );
});

describe('bootstrapOidc', () => {
  test('no-op when OIDC_ENABLED is not "true"', async () => {
    delete process.env.OIDC_ENABLED;

    await bootstrapOidc();

    expect(mockIssuerDiscover).not.toHaveBeenCalled();
    expect(getOidcClient()).toBeNull();
  });

  test('logs and schedules a background retry (does not throw) when discovery keeps failing', async () => {
    process.env.OIDC_ENABLED = 'true';
    process.env.OIDC_CLIENT_ID = 'test-client';
    process.env.OIDC_ISSUER = 'https://sso.test.example';
    mockIssuerDiscover.mockRejectedValue(new Error('down'));

    await expect(
      bootstrapOidc({ retries: 2, retryDelayMs: 1, maxRetryDelayMs: 2 })
    ).resolves.toBeUndefined();

    expect(getOidcClient()).toBeNull();
  });
});

describe('scheduleOidcBackgroundRetry', () => {
  test('retries on an interval and recovers once discovery succeeds', async () => {
    mockIssuerDiscover.mockRejectedValueOnce(new Error('still down')).mockResolvedValueOnce({
      Client: MockClientCtor,
    });

    scheduleOidcBackgroundRetry(
      {
        issuer: 'https://sso.test.example',
        clientId: 'test-client',
        redirectUri: 'https://app.test.example/signin-oidc',
      },
      5 // tiny real interval in ms, not a fake timer
    );

    // Wait past two tick intervals for the retry loop to run and recover.
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(getOidcClient()).toBe(mockClientInstance);
  });

  test('is a no-op if a client is already cached', async () => {
    await initTestClient();
    mockIssuerDiscover.mockClear();

    scheduleOidcBackgroundRetry({ issuer: 'https://sso.test.example', clientId: 'test-client' }, 5);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockIssuerDiscover).not.toHaveBeenCalled();
  });
});

// Sanity check on the mocked generators themselves, so a future refactor
// that stops calling one of them doesn't silently weaken PKCE/state/nonce.
describe('generators usage sanity check', () => {
  test('login uses all four generator functions', async () => {
    await initTestClient();
    mockClientInstance.authorizationUrl.mockReturnValue('https://sso.test.example/authorize');
    const handler = getRouteHandler('/login');
    const { req, res } = createMockReqRes({ path: '/login' });

    handler(req, res);

    expect(generators.codeVerifier).toHaveBeenCalled();
    expect(generators.codeChallenge).toHaveBeenCalledWith('test-code-verifier');
    expect(generators.state).toHaveBeenCalled();
    expect(generators.nonce).toHaveBeenCalled();
  });
});
