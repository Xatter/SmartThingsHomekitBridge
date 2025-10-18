import dotenv from 'dotenv';
import path from 'path';
import * as cron from 'node-cron';
import { SmartThingsAuthentication } from '@/auth/SmartThingsAuthentication';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { LightingMonitor } from '@/monitoring/LightingMonitor';
import { Coordinator } from '@/coordinator/Coordinator';
import { SmartThingsHAPServer } from '@/hap/HAPServer';
import { WebServer } from '@/web/server';
import { logger } from '@/utils/logger';

dotenv.config();

async function startup(): Promise<void> {
  logger.info('🚀 Starting SmartThings HomeKit Bridge...');

  // Debug environment variables
  logger.info({
    clientId: process.env.SMARTTHINGS_CLIENT_ID ? 'Set' : 'Missing',
    clientSecret: process.env.SMARTTHINGS_CLIENT_SECRET ? 'Set' : 'Missing',
    redirectUri: process.env.SMARTTHINGS_REDIRECT_URI || 'Missing'
  }, 'Environment check');

  const tokenPath = process.env.AUTH_TOKEN_PATH || './data/smartthings_token.json';
  const statePath = process.env.DEVICE_STATE_PATH || './data/device_state.json';
  const webPort = parseInt(process.env.WEB_PORT || '3000');
  const hapPort = parseInt(process.env.HAP_PORT || '51826');
  const hapPincode = process.env.HAP_PINCODE || '942-37-286';
  const lightingInterval = parseInt(process.env.LIGHTING_CHECK_INTERVAL || '60');
  const pollInterval = parseInt(process.env.DEVICE_POLL_INTERVAL || '300');

  if (!process.env.SMARTTHINGS_CLIENT_ID || !process.env.SMARTTHINGS_CLIENT_SECRET) {
    logger.error('❌ Missing required environment variables: SMARTTHINGS_CLIENT_ID and SMARTTHINGS_CLIENT_SECRET must be set. Copy .env.example to .env and fill in your SmartThings OAuth credentials');
    process.exit(1);
  }

  try {
    logger.info('📦 Initializing services...');

    const smartThingsAuth = new SmartThingsAuthentication(tokenPath);
    await smartThingsAuth.load();

    const smartThingsAPI = new SmartThingsAPI(smartThingsAuth);

    // Schedule proactive token refresh every hour
    logger.info('🔐 Starting proactive token refresh scheduler (runs hourly)');
    const tokenRefreshTask = cron.schedule('0 * * * *', async () => {
      logger.debug('⏰ Running scheduled token refresh check');
      await smartThingsAuth.checkAndRefreshToken();
    }, {
      scheduled: true,
      timezone: 'UTC'
    });

    const lightingMonitor = new LightingMonitor(smartThingsAPI, lightingInterval);

    const hapServer = new SmartThingsHAPServer(hapPort, hapPincode);

    const coordinator = new Coordinator(
      smartThingsAPI,
      lightingMonitor,
      hapServer,
      statePath,
      pollInterval
    );

    const webServer = new WebServer(webPort);

    const onAuthSuccess = async () => {
      logger.info('✅ SmartThings authentication successful, reloading devices...');
      try {
        await coordinator.reloadDevices();
        // LightingMonitor will be started automatically by setDevices() in reloadDevices()
      } catch (error) {
        logger.error({ err: error }, '❌ Error reloading devices after auth');
      }
    };

    webServer.setupRoutes(
      smartThingsAuth,
      smartThingsAPI,
      coordinator,
      hapServer,
      onAuthSuccess
    );

    if (!smartThingsAPI.hasAuth()) {
      logger.warn('⚠️  No SmartThings authentication found');
      logger.info({ url: `http://localhost:${webPort}` }, '🌐 Please visit web interface to authenticate with SmartThings');
    } else {
      logger.info('✅ SmartThings authentication found');
    }

    logger.info('⚡ Starting HAP server...');
    await hapServer.initialize(coordinator);
    await hapServer.start();

    logger.info('🔧 Initializing coordinator...');
    await coordinator.initialize();

    logger.info('🌐 Starting web server...');
    await webServer.start();

    // The lighting monitor will be started automatically when devices are set via setDevices()
    // in the coordinator's reloadDevices() method
    logger.info('🔍 Lighting monitor will start automatically when devices are loaded');

    logger.info({ webPort, hapPort }, '✅ SmartThings HomeKit Bridge is running!');

    if (hapServer.getQrCode()) {
      logger.info({
        qrCode: 'Available in web interface',
        setupCode: hapServer.getPairingCode()
      }, '🔗 HomeKit Pairing Information');
    }

    const gracefulShutdown = async (signal: string) => {
      logger.info({ signal }, '🛑 Received signal, shutting down gracefully...');

      try {
        tokenRefreshTask.stop();
        coordinator.stop();
        lightingMonitor.stop();
        await hapServer.stop();
        await webServer.stop();

        logger.info('✅ Graceful shutdown complete');
        process.exit(0);
      } catch (error) {
        logger.error({ err: error }, '❌ Error during shutdown');
        process.exit(1);
      }
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  } catch (error) {
    logger.error({ err: error }, '❌ Failed to start SmartThings HomeKit Bridge');
    process.exit(1);
  }
}

if (require.main === module) {
  startup().catch((error) => {
    logger.error({ err: error }, '❌ Startup error');
    process.exit(1);
  });
}