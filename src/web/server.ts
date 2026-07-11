import crypto from 'crypto';
import express, { NextFunction, Request, RequestHandler, Response } from 'express';
import cors from 'cors';
import session from 'express-session';
import path from 'path';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { SmartThingsAuthentication } from '@/auth/SmartThingsAuthentication';
import { Coordinator } from '@/coordinator/Coordinator';
import { SmartThingsHAPServer } from '@/hap/HAPServer';
import { PluginManager } from '@/plugins';
import { DeviceInclusionManager } from '@/config/DeviceInclusionManager';
import { createAuthRoutes } from './routes/auth';
import { createDevicesRoutes } from './routes/devices';
import { createHomeKitRoutes } from './routes/homekit';
import { logger } from '@/utils/logger';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

// OAuth routes reached via a browser top-level redirect (the user's browser
// navigating directly, not a script-issued request). These can't attach
// custom headers, so they must stay exempt from the drive-by guard below.
// Both happen to be GET-only today (and GET is already exempt), but they're
// listed explicitly so a future non-GET OAuth route doesn't silently bypass
// the guard.
const OAUTH_REDIRECT_PATHS = new Set([
  '/api/auth/smartthings',
  '/api/auth/smartthings/callback',
]);

/**
 * Blocks cross-origin "drive-by" mutations: any LAN webpage can issue a
 * simple (no-preflight) cross-origin POST/PUT/DELETE/PATCH with a browser
 * following the user's cookies/network access. Requiring a custom header
 * forces the browser to send a CORS preflight first, which fails unless the
 * origin is explicitly allowlisted via CORS_ALLOWED_ORIGINS.
 *
 * If WEB_API_TOKEN is configured, this also enforces a matching
 * `Authorization: Bearer <token>` header on the same set of requests.
 */
export function apiMutationGuard(req: Request, res: Response, next: NextFunction): void {
  // Express 4 route matching is case-INSENSITIVE by default, so a request to
  // /API/devices/... still reaches the /api/devices/... handlers. The guard
  // must therefore match paths case-insensitively too, otherwise an attacker
  // can bypass both this header check and the WEB_API_TOKEN bearer check
  // simply by upper-casing the path. Normalize once and compare against the
  // (lowercase) prefix and exemption set.
  const normalizedPath = req.path.toLowerCase();
  if (!normalizedPath.startsWith('/api/')) {
    return next();
  }
  if (!MUTATING_METHODS.has(req.method.toUpperCase())) {
    return next();
  }
  if (OAUTH_REDIRECT_PATHS.has(normalizedPath)) {
    return next();
  }

  if (req.get('X-Requested-With') !== 'XMLHttpRequest') {
    res.status(403).json({
      error: 'Missing required X-Requested-With header. This endpoint cannot be called cross-origin.'
    });
    return;
  }

  const requiredToken = process.env.WEB_API_TOKEN;
  if (requiredToken) {
    const authHeader = req.get('Authorization');
    if (!authHeader) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }

    const [scheme, token] = authHeader.split(' ');
    if (scheme !== 'Bearer' || token !== requiredToken) {
      res.status(403).json({ error: 'Invalid API token' });
      return;
    }
  }

  next();
}

/**
 * Wraps a route handler so a rejected returned promise is caught instead of
 * hanging the request. Express 4 does not handle async rejections itself, so
 * a throwing plugin handler would otherwise leave the client waiting forever.
 */
export function wrapAsyncHandler(handler: RequestHandler): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      logger.error({ err }, 'Unhandled error in plugin route handler');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  };
}

/**
 * Restarts the bridge process. Destructive (drops HomeKit/SmartThings
 * connections mid-flight), so it requires an explicit confirmation flag in
 * the body in addition to the drive-by/token guard already applied to all
 * mutating /api requests.
 */
export function handleSystemRestart(req: Request, res: Response): void {
  if (req.body?.confirm !== true) {
    res.status(400).json({
      error: 'Restart requires a confirmation. Send { "confirm": true } in the request body.'
    });
    return;
  }

  logger.info('🔄 Restart requested via API');
  res.json({
    success: true,
    message: 'Restarting bridge...'
  });

  // Trigger graceful shutdown after allowing response to be sent
  setTimeout(() => {
    logger.info('🔄 Initiating graceful shutdown for restart');
    process.kill(process.pid, 'SIGTERM');
  }, 500);
}

export class WebServer {
  private app: express.Application;
  private server: any = null;
  private readonly port: number;

  constructor(port: number = 3000) {
    this.port = port;
    this.app = express();
    this.setupMiddleware();
  }

  private setupMiddleware(): void {
    // Defense in depth: make route matching case-sensitive so /API/... does
    // not alias /api/... at all. The apiMutationGuard below already handles
    // the security concern case-insensitively regardless, but this keeps the
    // routing surface itself unambiguous. The frontend and all internal
    // callers use lowercase /api paths, so this does not affect legit traffic.
    this.app.set('case sensitive routing', true);

    const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS;
    if (allowedOrigins) {
      const origins = allowedOrigins.split(',').map(origin => origin.trim()).filter(Boolean);
      logger.info({ origins }, 'CORS enabled for configured origins');
      this.app.use(cors({ origin: origins }));
    } else {
      logger.debug('CORS_ALLOWED_ORIGINS not set; no CORS headers will be sent (same-origin only)');
    }

    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    this.app.use(apiMutationGuard);

    if (!process.env.WEB_API_TOKEN) {
      logger.warn(
        '⚠️  WEB_API_TOKEN is not set. The control API (device control, restart, HomeKit pairing reset, ' +
        'plugin toggles, etc.) is UNAUTHENTICATED for any device on the LAN. Set WEB_API_TOKEN to require ' +
        'a bearer token on mutating requests.'
      );
    }

    const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
    this.app.use(session({
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false }
    }));

    this.app.use(express.static(path.join(__dirname, '../../public')));

    this.app.use((req, res, next) => {
      logger.debug({ method: req.method, path: req.path }, 'HTTP request');
      next();
    });
  }

  setupRoutes(
    auth: SmartThingsAuthentication,
    api: SmartThingsAPI,
    coordinator: Coordinator,
    hapServer: SmartThingsHAPServer,
    onAuthSuccess?: () => void,
    pluginManager?: PluginManager,
    inclusionManager?: DeviceInclusionManager
  ): void {
    this.app.use('/api/auth', createAuthRoutes(auth, onAuthSuccess));
    if (inclusionManager) {
      this.app.use('/api/devices', createDevicesRoutes(api, coordinator, inclusionManager));
    }
    this.app.use('/api/homekit', createHomeKitRoutes(hapServer));

    // Register plugin routes
    if (pluginManager) {
      const pluginRoutes = pluginManager.getAllWebRoutes();
      for (const [pluginName, routes] of pluginRoutes) {
        const router = express.Router();
        for (const route of routes) {
          router[route.method](route.path, wrapAsyncHandler(route.handler));
        }
        this.app.use(`/api/plugins/${pluginName}`, router);
        logger.info({ plugin: pluginName, routeCount: routes.length }, 'Registered plugin routes');
      }

      // Plugin list endpoint (with enabled and running status)
      this.app.get('/api/plugins', (req, res) => {
        const plugins = pluginManager.getPlugins().map(loaded => ({
          name: loaded.plugin.name,
          version: loaded.plugin.version,
          description: loaded.plugin.description,
          source: loaded.metadata.source,
          enabled: pluginManager.isPluginEnabled(loaded.plugin.name),
          running: pluginManager.isPluginRunning(loaded.plugin.name),
        }));
        res.json(plugins);
      });

      // Enable plugin endpoint (starts at runtime, no restart needed)
      this.app.post('/api/plugins/:name/enable', async (req, res) => {
        try {
          const { name } = req.params;
          await pluginManager.enablePlugin(name);
          logger.info({ plugin: name }, 'Plugin enabled and started');
          res.json({
            success: true,
            message: 'Plugin enabled and started.',
          });
        } catch (error) {
          logger.error({ err: error, plugin: req.params.name }, 'Failed to enable plugin');
          res.status(500).json({ error: 'Failed to enable plugin' });
        }
      });

      // Disable plugin endpoint (stops at runtime, no restart needed)
      this.app.post('/api/plugins/:name/disable', async (req, res) => {
        try {
          const { name } = req.params;
          await pluginManager.disablePlugin(name);
          logger.info({ plugin: name }, 'Plugin disabled and stopped');
          res.json({
            success: true,
            message: 'Plugin disabled and stopped.',
          });
        } catch (error) {
          logger.error({ err: error, plugin: req.params.name }, 'Failed to disable plugin');
          res.status(500).json({ error: 'Failed to disable plugin' });
        }
      });
    }

    this.app.get('/api/health', (req, res) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
          smartthings: api.hasAuth(),
          homekit: hapServer.getQrCode() !== null,
        },
      });
    });

    // System restart endpoint
    this.app.post('/api/system/restart', handleSystemRestart);

    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '../../public/index.html'));
    });

    this.app.get('/devices', (req, res) => {
      res.sendFile(path.join(__dirname, '../../public/index.html'));
    });

    this.app.get('/setup', (req, res) => {
      res.sendFile(path.join(__dirname, '../../public/index.html'));
    });

    this.app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, '../../public/index.html'));
    });

    this.app.use((err: any, req: any, res: any, next: any) => {
      logger.error({ err }, 'Express error');
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, '0.0.0.0', () => {
        logger.info({ port: this.port, url: `http://0.0.0.0:${this.port}` }, 'Web server started');
        resolve();
      });

      this.server.on('error', (error: any) => {
        logger.error({ err: error }, 'Web server error');
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          logger.info('Web server stopped');
          resolve();
        });
      });
    }
  }

  getApp(): express.Application {
    return this.app;
  }
}
