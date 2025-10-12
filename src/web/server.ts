import express from 'express';
import cors from 'cors';
import session from 'express-session';
import path from 'path';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { SmartThingsAuthentication } from '@/auth/SmartThingsAuthentication';
import { Coordinator } from '@/coordinator/Coordinator';
import { SmartThingsHAPServer } from '@/hap/HAPServer';
import { createAuthRoutes } from './routes/auth';
import { createDevicesRoutes } from './routes/devices';
import { createHomeKitRoutes } from './routes/homekit';
import { logger } from '@/utils/logger';

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
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    this.app.use(session({
      secret: process.env.SESSION_SECRET || 'your-secret-key',
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
    onAuthSuccess?: () => void
  ): void {
    this.app.use('/api/auth', createAuthRoutes(auth, onAuthSuccess));
    this.app.use('/api/devices', createDevicesRoutes(api, coordinator));
    this.app.use('/api/homekit', createHomeKitRoutes(hapServer));

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