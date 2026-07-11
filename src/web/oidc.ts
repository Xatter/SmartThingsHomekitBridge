import { NextFunction, Request, Response, Router } from 'express';
import { Issuer, generators } from 'openid-client';
import type { Client } from 'openid-client';
import { logger } from '@/utils/logger';

// -----------------------------------------------------------------------
// Session shape
// -----------------------------------------------------------------------
//
// Augment express-session's SessionData so the rest of the codebase gets
// typed access to the fields this module reads/writes. This declaration
// merges globally with the express-session module regardless of which file
// declares it, as long as this file is part of the TS program.
declare module 'express-session' {
  interface SessionData {
    /** One-time PKCE/state/nonce values for an in-flight OIDC auth code flow. */
    oidc?: {
      codeVerifier: string;
      state: string;
      nonce: string;
    };
    /** Path to return to after a successful login. */
    returnTo?: string;
    /** Set once the OIDC callback succeeds. Presence == "authenticated". */
    user?: {
      sub: string;
      email?: string;
      name?: string;
      authAt: number;
    };
  }
}

// -----------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------

const DEFAULT_ISSUER = 'https://sso.revealedpreferences.com';
const DEFAULT_REDIRECT_URI = 'https://pa-hvac.revealedpreferences.com/signin-oidc';
const DEFAULT_POST_LOGOUT_REDIRECT_URI = 'https://pa-hvac.revealedpreferences.com/';

export interface InitOidcOptions {
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  /** Total number of discovery attempts before giving up. Default 4. */
  retries?: number;
  /** Base delay (ms) for exponential backoff between attempts. Default 1000. */
  retryDelayMs?: number;
  /** Cap (ms) on the backoff delay. Default 8000. */
  maxRetryDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -----------------------------------------------------------------------
// Module state
// -----------------------------------------------------------------------
//
// `cachedClient` is the single source of truth for "is OIDC ready". It is
// intentionally a plain module-level variable (not e.g. computed from env on
// every request) because building a Client requires an async discovery round
// trip - it cannot be done synchronously inside requireAuth. Every code path
// that flips this from null -> Client is funneled through initOidc() below,
// and requireAuth ONLY ever treats a non-null client as "initialized".
let cachedClient: Client | null = null;
let cachedRedirectUri: string | null = null;
let backgroundRetryHandle: NodeJS.Timeout | null = null;

/** Returns the initialized client, or null if OIDC hasn't (yet, or no longer) initialized. */
export function getOidcClient(): Client | null {
  return cachedClient;
}

/** True once initOidc() has completed successfully at least once (and hasn't been reset). */
export function isOidcReady(): boolean {
  return cachedClient !== null;
}

// OIDC_ENABLED is a security-critical toggle: when it reads as "disabled",
// requireAuth passes EVERYTHING through. A loose `=== 'true'` check would
// silently treat any typo (`True`, `1`, `"true "` with a stray space, etc.)
// as disabled and expose the whole UI + API unauthenticated. So we parse it
// fail-safe: a small allowlist of affirmative values enables auth, a small
// allowlist of negative values (plus unset) disables it, and ANYTHING else
// throws loudly rather than defaulting to the dangerous "open" direction.
const OIDC_ENABLED_TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const OIDC_ENABLED_FALSE_VALUES = new Set(['', 'false', '0', 'no', 'off']);

/**
 * Reads OIDC_ENABLED directly so callers always see the live value (tests
 * flip it per-case). Parsed fail-safe (see above): unknown values THROW so
 * a mistyped enable flag crashes startup instead of silently failing open.
 */
export function isOidcEnabled(): boolean {
  const raw = (process.env.OIDC_ENABLED ?? '').trim().toLowerCase();
  if (OIDC_ENABLED_TRUE_VALUES.has(raw)) {
    return true;
  }
  if (OIDC_ENABLED_FALSE_VALUES.has(raw)) {
    return false;
  }
  throw new Error(
    `Invalid OIDC_ENABLED value: ${JSON.stringify(process.env.OIDC_ENABLED)}. ` +
      `Use one of true/1/yes/on to enable SSO, or false/0/no/off (or leave it unset) to ` +
      `disable it. Refusing to start with an ambiguous value rather than risk exposing the ` +
      `web UI/API unauthenticated (fail closed).`
  );
}

/**
 * Test-only reset hook. Clears cached client/config and cancels any pending
 * background retry so tests don't leak state or timers across cases.
 */
export function __resetOidcStateForTests(): void {
  cachedClient = null;
  cachedRedirectUri = null;
  stopOidcBackgroundRetry();
}

// -----------------------------------------------------------------------
// Discovery + client construction
// -----------------------------------------------------------------------

/**
 * Performs OIDC discovery against OIDC_ISSUER and builds a confidential
 * client, retrying a few times with exponential backoff since discovery
 * happens at process startup when the SSO provider may not be reachable yet
 * (e.g. both containers restarting together).
 *
 * On success, caches the client so getOidcClient()/requireAuth see it
 * immediately. On failure (after exhausting retries), throws - callers MUST
 * NOT interpret a thrown error as "allow access"; see requireAuth below.
 */
export async function initOidc(options: InitOidcOptions = {}): Promise<Client> {
  const issuerUrl = options.issuer ?? process.env.OIDC_ISSUER ?? DEFAULT_ISSUER;
  const clientId = options.clientId ?? process.env.OIDC_CLIENT_ID ?? '';
  const clientSecret = options.clientSecret ?? process.env.OIDC_CLIENT_SECRET;
  const redirectUri = options.redirectUri ?? process.env.OIDC_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;
  const retries = options.retries ?? 4;
  const baseDelayMs = options.retryDelayMs ?? 1000;
  const maxDelayMs = options.maxRetryDelayMs ?? 8000;

  if (!clientId) {
    throw new Error('OIDC_CLIENT_ID is not set; cannot initialize the OIDC client');
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const issuer = await Issuer.discover(issuerUrl);
      const client = new issuer.Client({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: [redirectUri],
        response_types: ['code'],
      });

      cachedClient = client;
      cachedRedirectUri = redirectUri;
      logger.info({ issuer: issuerUrl, clientId }, '✅ OIDC discovery + client initialization succeeded');
      return client;
    } catch (err) {
      lastErr = err;
      logger.warn(
        { err, attempt, retries, issuer: issuerUrl },
        '⚠️  OIDC discovery/init attempt failed'
      );
      if (attempt < retries) {
        const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
        await sleep(delay);
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Schedules a background retry loop that keeps calling initOidc() (one
 * attempt per tick) until it succeeds, so the bridge recovers automatically
 * once the SSO provider comes back - without anyone needing to restart the
 * container. No-ops if a retry is already scheduled or the client is already
 * initialized.
 */
export function scheduleOidcBackgroundRetry(
  options: InitOidcOptions = {},
  intervalMs = 30_000
): void {
  if (backgroundRetryHandle || cachedClient) {
    return;
  }

  const tick = async (): Promise<void> => {
    backgroundRetryHandle = null;
    if (cachedClient) {
      return;
    }
    try {
      await initOidc({ ...options, retries: 1 });
      logger.info('✅ OIDC recovered via background retry; web UI/API auth is active again');
    } catch (err) {
      logger.warn(
        { err },
        '⚠️  OIDC background retry failed; will retry again shortly. Web UI/API remain locked (fail closed).'
      );
      backgroundRetryHandle = setTimeout(tick, intervalMs);
      backgroundRetryHandle.unref?.();
    }
  };

  backgroundRetryHandle = setTimeout(tick, intervalMs);
  backgroundRetryHandle.unref?.();
}

export function stopOidcBackgroundRetry(): void {
  if (backgroundRetryHandle) {
    clearTimeout(backgroundRetryHandle);
    backgroundRetryHandle = null;
  }
}

/**
 * Env-driven startup entry point. Call once during server startup.
 *
 * - If OIDC_ENABLED !== 'true', this is a no-op (dev/local mode unchanged).
 * - If enabled and discovery fails after retries, this logs a clear error
 *   and schedules a background retry - it deliberately does NOT throw, so a
 *   down SSO provider never crashes the process or the HAP/HomeKit bridge.
 *   requireAuth stays fail-closed the entire time (see below).
 *
 * `overrides` is only intended for tests that need fast/short retry timing;
 * production startup (server.ts) always calls this with no arguments, which
 * reads OIDC_ISSUER/OIDC_CLIENT_ID/etc. straight from the environment.
 */
export async function bootstrapOidc(overrides: InitOidcOptions = {}): Promise<void> {
  if (!isOidcEnabled()) {
    logger.debug('OIDC_ENABLED is not "true"; web auth disabled (dev/local mode)');
    return;
  }

  try {
    await initOidc(overrides);
    logger.info('🔐 OIDC ready; web UI/API now require SSO login');
  } catch (err) {
    logger.error(
      { err },
      '❌ OIDC failed to initialize at startup. The web UI/API will DENY ALL requests ' +
        '(fail closed) until SSO becomes reachable. The HomeKit bridge itself is unaffected ' +
        'and keeps running. Retrying discovery in the background.'
    );
    scheduleOidcBackgroundRetry(overrides);
  }
}

// -----------------------------------------------------------------------
// requireAuth
// -----------------------------------------------------------------------

// Paths reachable without an authenticated session. Nothing else is exempt:
// the static UI and every /api/* route (including the SmartThings OAuth
// routes under /api/auth) sit behind requireAuth.
const EXEMPT_PATHS = new Set([
  '/api/health',
  '/login',
  '/signin-oidc',
  '/logout',
  '/signout-callback-oidc',
]);

function wantsHtml(req: Request): boolean {
  const accept = req.get('Accept') || req.get('accept') || '';
  return accept.includes('text/html');
}

/**
 * The auth gate for the whole web app. Must be registered after the session
 * middleware and before express.static()/the API route mounts so it covers
 * every request.
 *
 * Decision table (see inline comments at each branch for the "why"):
 *  1. OIDC_ENABLED !== 'true'          -> pass through (dev/local mode).
 *  2. enabled, exempt path             -> pass through.
 *  3. enabled, client not initialized  -> 503, DENY. Never fall through to allow.
 *  4. enabled, initialized, session ok -> pass through.
 *  5. enabled, initialized, no session -> redirect to /login (HTML GET) or 401 JSON (else).
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isOidcEnabled()) {
    next();
    return;
  }

  // Normalize case the same way apiMutationGuard does: Express 4's default
  // case-insensitive routing means /API/health and /Login would otherwise
  // reach handlers that this middleware doesn't recognize as exempt. Since
  // the fallback behavior below is "deny", getting this wrong can only make
  // things MORE restrictive, never less - but normalizing keeps intentional
  // exemptions (like the Docker healthcheck) working regardless of case.
  const normalizedPath = req.path.toLowerCase();
  if (EXEMPT_PATHS.has(normalizedPath)) {
    next();
    return;
  }

  // CRITICAL fail-closed branch: if OIDC is turned on but the client never
  // finished initializing (discovery failed/still retrying, or it dropped
  // out after an earlier success was somehow cleared), there is NO
  // authenticated identity provider to check sessions against. Do not let a
  // broken SSO integration silently become "open to the internet" - deny
  // every non-exempt request until initOidc() succeeds.
  const client = getOidcClient();
  if (!client) {
    logger.warn({ path: req.path }, '🔒 Denying request: OIDC is enabled but not initialized (fail closed)');
    if (wantsHtml(req)) {
      res.status(503).send('Single sign-on is temporarily unavailable. Please try again shortly.');
    } else {
      res.status(503).json({ error: 'Authentication service unavailable' });
    }
    return;
  }

  if (req.session?.user) {
    next();
    return;
  }

  // Navigational GET (a browser loading a page) gets bounced through the
  // login flow; everything else (API/XHR calls, non-GET requests) gets a
  // 401 the frontend JS can react to instead of following a redirect into
  // an HTML login page.
  if (req.method === 'GET' && wantsHtml(req)) {
    if (req.session) {
      req.session.returnTo = req.originalUrl;
    }
    res.redirect('/login');
    return;
  }

  res.status(401).json({ error: 'Authentication required' });
}

// -----------------------------------------------------------------------
// Router: /login, /signin-oidc, /logout, /signout-callback-oidc
// -----------------------------------------------------------------------

// Throwaway origin used to resolve the (supposedly relative) returnTo value.
// If resolution lands on any other origin, the value was not actually
// same-site and must be rejected.
const RETURN_TO_PLACEHOLDER_ORIGIN = 'http://placeholder.invalid';

// Paths we must never redirect *back* into after login: doing so would
// bounce the freshly-authenticated user straight into the login/logout flow
// again (redirect loop). Compared case-insensitively.
const RETURN_TO_FORBIDDEN_PATHS = new Set([
  '/login',
  '/signin-oidc',
  '/logout',
  '/signout-callback-oidc',
]);

/**
 * Validates the post-login redirect target. This value is attacker-influenced
 * (it comes from `?returnTo=` and from a stored session field), so a weak
 * check here is a classic open-redirect: an attacker gets the victim to start
 * at /login?returnTo=<evil>, the victim completes the REAL SSO login, and the
 * callback then bounces them to <evil>.
 *
 * Only a genuine same-site absolute PATH (e.g. "/devices?foo=bar") is allowed;
 * everything else coerces to "/". Notably rejected:
 *  - absolute URLs ("https://evil.com") and protocol-relative ("//evil.com")
 *  - backslash smuggling ("/\\evil.com", "/\\/evil.com") which browsers
 *    normalize to "//evil.com" -> protocol-relative navigation to evil.com
 *  - percent-encoded slashes/backslashes (%2f, %5c) that a browser or proxy
 *    may later decode back into path separators
 *  - control characters (CR/LF/TAB) usable for header/redirect smuggling
 *  - redirect loops back into the auth routes themselves
 */
function sanitizeReturnTo(value: unknown): string {
  const fallback = '/';

  if (typeof value !== 'string' || value.length === 0) {
    return fallback;
  }

  // Must be an absolute-path reference on our own origin.
  if (!value.startsWith('/')) {
    return fallback;
  }

  // Reject protocol-relative ("//host") and backslash-smuggled variants
  // ("/\\host", which user agents normalize into "//host") up front. The
  // second character being '/' or '\\' is the tell.
  const second = value[1];
  if (second === '/' || second === '\\') {
    return fallback;
  }

  // Any backslash anywhere is suspicious (path-separator confusion across
  // browsers/proxies); relative app paths never legitimately contain one.
  if (value.includes('\\')) {
    return fallback;
  }

  // Control chars (incl. CR/LF/TAB) enable header/redirect smuggling.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return fallback;
  }

  // Encoded slashes/backslashes can be decoded downstream into separators
  // that reconstitute a protocol-relative or cross-origin target.
  if (/%2f|%5c/i.test(value)) {
    return fallback;
  }

  // Belt-and-suspenders: resolve against a throwaway origin. Anything that
  // escapes to another origin (absolute URL, sneaky host) is rejected. Using
  // the WHATWG URL parser here catches cases the string checks above might
  // miss, since it normalizes the value the same way a browser would.
  let resolved: URL;
  try {
    resolved = new URL(value, RETURN_TO_PLACEHOLDER_ORIGIN);
  } catch {
    return fallback;
  }
  if (resolved.origin !== RETURN_TO_PLACEHOLDER_ORIGIN) {
    return fallback;
  }

  // Don't bounce back into the login/logout flow (redirect loop).
  if (RETURN_TO_FORBIDDEN_PATHS.has(resolved.pathname.toLowerCase())) {
    return fallback;
  }

  const out = resolved.pathname + resolved.search + resolved.hash;

  // Final backstop: the WHATWG URL parser collapses dot-segments
  // ("/.//host", "/..//host", "/%2e//host", "/foo/../..//host", ...) down to
  // a pathname that itself STARTS with "//" (or "/\\") - i.e. a
  // protocol-relative reference - while still reporting the placeholder
  // origin, so the origin check above passes. Returning that verbatim would
  // let the browser treat "//evil.com" as cross-origin. Reject any result
  // that is itself protocol-relative, regardless of how the parser got
  // there or how the input was encoded (%2e etc.).
  if (out.startsWith('//') || out.startsWith('/\\')) {
    return fallback;
  }

  // Return the relative path (+ query + hash) only - never the absolute
  // placeholder URL - so the browser navigates within our own origin.
  return out;
}

export function createOidcRouter(): Router {
  const router = Router();

  router.get('/login', (req: Request, res: Response) => {
    const client = getOidcClient();
    if (!client || !cachedRedirectUri) {
      res.status(503).send('Single sign-on is temporarily unavailable. Please try again shortly.');
      return;
    }

    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    const state = generators.state();
    const nonce = generators.nonce();

    req.session.oidc = { codeVerifier, state, nonce };
    req.session.returnTo = sanitizeReturnTo(req.query.returnTo ?? req.session.returnTo);

    const authorizationUrl = client.authorizationUrl({
      scope: 'openid email profile',
      redirect_uri: cachedRedirectUri,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    res.redirect(authorizationUrl);
  });

  router.get('/signin-oidc', async (req: Request, res: Response) => {
    const client = getOidcClient();
    const pending = req.session.oidc;

    if (!client || !cachedRedirectUri) {
      res.status(503).send('Single sign-on is temporarily unavailable. Please try again shortly.');
      return;
    }

    if (!pending) {
      logger.warn('OIDC callback received without a pending auth request in the session');
      res.status(400).send('Your sign-in session expired or was invalid. Please try logging in again.');
      return;
    }

    try {
      const params = client.callbackParams(req);
      const tokenSet = await client.callback(cachedRedirectUri, params, {
        code_verifier: pending.codeVerifier,
        state: pending.state,
        nonce: pending.nonce,
      });

      const claims = tokenSet.claims();
      const returnTo = sanitizeReturnTo(req.session.returnTo);

      // Regenerate the session id before establishing the authenticated
      // session, to prevent session fixation: an attacker who got the
      // victim to adopt a pre-auth session id (shared kiosk, injected
      // cookie, etc.) must not inherit an authenticated session once that
      // victim logs in. regenerate() wipes the pre-auth `oidc`/`returnTo`
      // scratch data along with the old id, so `user` is set fresh below.
      req.session.regenerate((err) => {
        if (err) {
          logger.error({ err }, 'Failed to regenerate session after OIDC login');
          res.status(500).send('Login failed. Please try again.');
          return;
        }

        req.session.user = {
          sub: claims.sub,
          email: claims.email,
          name: claims.name,
          authAt: Date.now(),
        };

        req.session.save((saveErr) => {
          if (saveErr) {
            logger.error({ err: saveErr }, 'Failed to save session after OIDC login');
            res.status(500).send('Login failed. Please try again.');
            return;
          }
          res.redirect(returnTo);
        });
      });
    } catch (err) {
      // Covers state/nonce mismatch (RPError), an error response from the
      // IdP (OPError), and any token-exchange failure. No session is
      // established in any of these cases.
      logger.error({ err }, '❌ OIDC callback failed (state/nonce/code validation or token exchange)');
      res.status(401).send('Sign-in failed. Please try again.');
    }
  });

  router.get('/logout', (req: Request, res: Response) => {
    const client = getOidcClient();
    const postLogoutRedirectUri =
      process.env.OIDC_POST_LOGOUT_REDIRECT_URI || DEFAULT_POST_LOGOUT_REDIRECT_URI;

    req.session.destroy((err) => {
      if (err) {
        logger.error({ err }, 'Failed to destroy session on logout');
      }

      if (client) {
        const endSessionUrl = client.endSessionUrl({
          post_logout_redirect_uri: postLogoutRedirectUri,
        });
        res.redirect(endSessionUrl);
      } else {
        // OIDC isn't initialized (or got disabled) - nothing to end-session
        // against, just land back on the app.
        res.redirect('/');
      }
    });
  });

  router.get('/signout-callback-oidc', (_req: Request, res: Response) => {
    res.redirect('/');
  });

  return router;
}
