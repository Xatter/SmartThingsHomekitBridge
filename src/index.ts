import dotenv from 'dotenv';
import * as cron from 'node-cron';
import { SmartThingsAuthentication } from '@/auth/SmartThingsAuthentication';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { LightingMonitor } from '@/monitoring/LightingMonitor';
import { Coordinator } from '@/coordinator/Coordinator';
import { SmartThingsHAPServer } from '@/hap/HAPServer';
import { WebServer } from '@/web/server';
import { logger } from '@/utils/logger';
import { ConfigLoader } from '@/config/BridgeConfig';
import { PluginManager } from '@/plugins';

dotenv.config();

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
    const lightingInterval = config.polling.lightingCheckInterval;
    const pollInterval = config.polling.devicePollInterval;
    const persistPath = config.bridge.persistPath;

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
      persistPath
    );

    await pluginManager.loadPlugins();
    await pluginManager.initializePlugins();

    // Now create the coordinator with plugin support
    coordinator = new Coordinator(
      smartThingsAPI,
      lightingMonitor,
      hapServer,
      pluginManager,
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
      onAuthSuccess,
      pluginManager // Pass plugin manager for plugin routes
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

    // The lighting monitor will be started automatically when devices are set via setDevices()
    // in the coordinator's reloadDevices() method
    logger.info('🔍 Lighting monitor will start automatically when devices are loaded');

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

    const gracefulShutdown = async (signal: string) => {
      logger.info({ signal }, '🛑 Received signal, shutting down gracefully...');

      try {
        tokenRefreshTask.stop();
        await pluginManager.stopPlugins();
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
