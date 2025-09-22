import dotenv from 'dotenv';
import path from 'path';
import { SmartThingsAuthentication } from '@/auth/SmartThingsAuthentication';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { LightingMonitor } from '@/monitoring/LightingMonitor';
import { Coordinator } from '@/coordinator/Coordinator';
import { SmartThingsHAPServer } from '@/hap/HAPServer';
import { WebServer } from '@/web/server';

dotenv.config();

async function startup(): Promise<void> {
  console.log('🚀 Starting SmartThings HomeKit Bridge...');

  // Debug environment variables
  console.log('Environment check:');
  console.log('- SMARTTHINGS_CLIENT_ID:', process.env.SMARTTHINGS_CLIENT_ID ? '✅ Set' : '❌ Missing');
  console.log('- SMARTTHINGS_CLIENT_SECRET:', process.env.SMARTTHINGS_CLIENT_SECRET ? '✅ Set' : '❌ Missing');
  console.log('- SMARTTHINGS_REDIRECT_URI:', process.env.SMARTTHINGS_REDIRECT_URI || '❌ Missing');

  const tokenPath = process.env.AUTH_TOKEN_PATH || './data/smartthings_token.json';
  const statePath = process.env.DEVICE_STATE_PATH || './data/device_state.json';
  const webPort = parseInt(process.env.WEB_PORT || '3000');
  const hapPort = parseInt(process.env.HAP_PORT || '51826');
  const hapPincode = process.env.HAP_PINCODE || '942-37-286';
  const lightingInterval = parseInt(process.env.LIGHTING_CHECK_INTERVAL || '60');
  const pollInterval = parseInt(process.env.DEVICE_POLL_INTERVAL || '300');

  if (!process.env.SMARTTHINGS_CLIENT_ID || !process.env.SMARTTHINGS_CLIENT_SECRET) {
    console.error('❌ Missing required environment variables:');
    console.error('   SMARTTHINGS_CLIENT_ID and SMARTTHINGS_CLIENT_SECRET must be set');
    console.error('   Copy .env.example to .env and fill in your SmartThings OAuth credentials');
    process.exit(1);
  }

  try {
    console.log('📦 Initializing services...');

    const smartThingsAuth = new SmartThingsAuthentication(tokenPath);
    await smartThingsAuth.load();

    const smartThingsAPI = new SmartThingsAPI(smartThingsAuth);

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
      console.log('✅ SmartThings authentication successful, reloading devices...');
      try {
        await coordinator.reloadDevices();
        lightingMonitor.start();
      } catch (error) {
        console.error('❌ Error reloading devices after auth:', error);
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
      console.log('⚠️  No SmartThings authentication found');
      console.log(`🌐 Please visit http://localhost:${webPort} to authenticate with SmartThings`);
    } else {
      console.log('✅ SmartThings authentication found');
    }

    console.log('⚡ Starting HAP server...');
    await hapServer.initialize(coordinator);
    await hapServer.start();

    console.log('🔧 Initializing coordinator...');
    await coordinator.initialize();

    console.log('🌐 Starting web server...');
    await webServer.start();

    if (smartThingsAPI.hasAuth()) {
      console.log('🔍 Starting lighting monitor...');
      lightingMonitor.start();
    }

    console.log('✅ SmartThings HomeKit Bridge is running!');
    console.log('');
    console.log('📱 Web Interface: http://localhost:' + webPort);
    console.log('🏠 HomeKit Bridge: Port ' + hapPort);
    console.log('');

    if (hapServer.getQrCode()) {
      console.log('🔗 HomeKit Pairing Information:');
      console.log('   QR Code: Available in web interface');
      console.log('   Setup Code:', hapServer.getPairingCode());
    }

    const gracefulShutdown = async (signal: string) => {
      console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);

      try {
        coordinator.stop();
        lightingMonitor.stop();
        await hapServer.stop();
        await webServer.stop();

        console.log('✅ Graceful shutdown complete');
        process.exit(0);
      } catch (error) {
        console.error('❌ Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  } catch (error) {
    console.error('❌ Failed to start SmartThings HomeKit Bridge:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  startup().catch((error) => {
    console.error('❌ Startup error:', error);
    process.exit(1);
  });
}