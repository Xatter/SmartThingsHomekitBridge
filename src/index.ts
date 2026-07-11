import dotenv from 'dotenv';
import * as cron from 'node-cron';
import { SmartThingsAuthentication } from '@/auth/SmartThingsAuthentication';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { Coordinator } from '@/coordinator/Coordinator';
import { SmartThingsHAPServer } from '@/hap/HAPServer';
import { WebServer } from '@/web/server';
import { logger } from '@/utils/logger';
import { ConfigLoader } from '@/config/BridgeConfig';
import { DeviceInclusionManager } from '@/config/DeviceInclusionManager';
import { PluginManager } from '@/plugins';

dotenv.config();

// Several code paths intentionally fire-and-forget promises, so a rejection
// here doesn't necessarily mean the process is in a bad state - just log it.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, '⚠️  Unhandled promise rejection');
});

// An uncaught exception means we're in an unknown state - log and exit
// rather than risk continuing with corrupted in-memory state.
process.on('uncaughtException', (error) => {
  logger.error({ err: error }, '❌ Uncaught exception, exiting');
  process.exit(1);
});

async function startup(): Promise<void> {
  logger.info('🚀 Starting SmartThings HomeKit Bridge...');

  try {
    // Load configuration
    logger.info('📋 Loading configuration...');
    const configLoader = new ConfigLoader(logger);
    const configPath = process.env.CONFIG_PATH || './config.json';
    const config = await configLoader.load(configPath);

    logger.info({
      clientId: config.smartthings.clientId ? 'Set' : 'Missing',
      clientSecret: config.smartthings.clientSecret ? 'Set' : 'Missing',
      redirectUri: config.smartthings.redirectUri || 'Not configured'
    }, 'Configuration loaded');

    const tokenPath = config.smartthings.tokenPath;
    const statePath = process.env.DEVICE_STATE_PATH || './data/device_state.json';
    const webPort = config.web.port;
    const hapPort = config.bridge.port;
    const hapPincode = config.bridge.pincode;
    const pollInterval = config.polling.devicePollInterval;
    const persistPath = config.bridge.persistPath || process.env.HAP_PERSIST_PATH || './persist';
    const dataPath = './data';

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

    const hapServer = new SmartThingsHAPServer(hapPort, hapPincode);

    // Initialize plugin manager
    logger.info('🔌 Initializing plugin manager...');

    // Create a temporary coordinator for device access (chicken-egg problem)
    // We'll set up the full integration after all components are created
    let coordinator: Coordinator;

    const pluginManager = new PluginManager(
      logger,
      config,
      smartThingsAPI,
      hapServer,
      () => coordinator?.getDevices() || [],
      (deviceId: string) => coordinator?.getDevice(deviceId),
      persistPath,
      dataPath
    );

    await pluginManager.loadPlugins();
    await pluginManager.initializePlugins();

    // Initialize device inclusion manager
    logger.info('📋 Initializing device inclusion manager...');
    const inclusionManager = new DeviceInclusionManager(dataPath, logger);
    await inclusionManager.load();

    // Now create the coordinator with plugin support
    coordinator = new Coordinator(
      smartThingsAPI,
      hapServer,
      pluginManager,
      inclusionManager,
      statePath,
      pollInterval
    );

    const webServer = new WebServer(webPort);

    const onAuthSuccess = async () => {
      logger.info('✅ SmartThings authentication successful, reloading devices...');
      try {
        await coordinator.reloadDevices();
      } catch (error) {
        logger.error({ err: error }, '❌ Error reloading devices after auth');
      }
    };

    webServer.setupRoutes(
      smartThingsAuth,
      smartThingsAPI,
      coordinator,
      hapServer,
      onAuthSuccess,
      pluginManager, // Pass plugin manager for plugin routes
      inclusionManager // Pass inclusion manager for device routes
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

    logger.info('🔌 Starting plugins...');
    await pluginManager.startPlugins();

    logger.info('🌐 Starting web server...');
    await webServer.start();

    logger.info({ webPort, hapPort }, '✅ SmartThings HomeKit Bridge is running!');
    logger.info({ pluginCount: pluginManager.getPlugins().length }, '🔌 Plugins loaded');

    // Log loaded plugins
    for (const loaded of pluginManager.getPlugins()) {
      logger.info({
        name: loaded.plugin.name,
        version: loaded.plugin.version,
        source: loaded.metadata.source
      }, `  - ${loaded.plugin.name} v${loaded.plugin.version}`);
    }

    if (hapServer.getQrCode()) {
      logger.info({
        qrCode: 'Available in web interface',
        setupCode: hapServer.getPairingCode()
      }, '🔗 HomeKit Pairing Information');
    }

    let isShuttingDown = false;

    const gracefulShutdown = async (signal: string) => {
      if (isShuttingDown) {
        logger.warn({ signal }, '⚠️  Shutdown already in progress, ignoring duplicate signal');
        return;
      }
      isShuttingDown = true;

      logger.info({ signal }, '🛑 Received signal, shutting down gracefully...');

      // Failsafe: if shutdown hangs, force exit rather than leaving the process stuck
      const shutdownDeadline = setTimeout(() => {
        logger.error('❌ Graceful shutdown exceeded 10s deadline, forcing exit');
        process.exit(1);
      }, 10_000);
      shutdownDeadline.unref();

      try {
        tokenRefreshTask.stop();
        await pluginManager.stopPlugins();
        coordinator.stop();
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
