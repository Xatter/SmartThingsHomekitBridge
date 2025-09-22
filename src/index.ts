import dotenv from 'dotenv';
import path from 'path';
import { SmartThingsAuthentication } from '@/auth/SmartThingsAuthentication';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { LightingMonitor } from '@/monitoring/LightingMonitor';
import { Coordinator } from '@/coordinator/Coordinator';
import { MatterServer } from '@/matter/MatterServer';
import { WebServer } from '@/web/server';

dotenv.config();

async function startup(): Promise<void> {
  console.log('🚀 Starting SmartThings Matter Bridge...');

  // Debug environment variables
  console.log('Environment check:');
  console.log('- SMARTTHINGS_CLIENT_ID:', process.env.SMARTTHINGS_CLIENT_ID ? '✅ Set' : '❌ Missing');
  console.log('- SMARTTHINGS_CLIENT_SECRET:', process.env.SMARTTHINGS_CLIENT_SECRET ? '✅ Set' : '❌ Missing');
  console.log('- SMARTTHINGS_REDIRECT_URI:', process.env.SMARTTHINGS_REDIRECT_URI || '❌ Missing');

  const tokenPath = process.env.AUTH_TOKEN_PATH || './data/smartthings_token.json';
  const statePath = process.env.DEVICE_STATE_PATH || './data/device_state.json';
  const webPort = parseInt(process.env.WEB_PORT || '3000');
  const matterPort = parseInt(process.env.MATTER_PORT || '5540');
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

    const matterServer = new MatterServer(matterPort);

    const coordinator = new Coordinator(
      smartThingsAPI,
      lightingMonitor,
      matterServer,
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
      matterServer,
      onAuthSuccess
    );

    if (!smartThingsAPI.hasAuth()) {
      console.log('⚠️  No SmartThings authentication found');
      console.log(`🌐 Please visit http://localhost:${webPort} to authenticate with SmartThings`);
    } else {
      console.log('✅ SmartThings authentication found');
    }

    console.log('🔧 Initializing coordinator...');
    await coordinator.initialize();

    console.log('⚡ Starting Matter server...');
    await matterServer.initialize(coordinator);

    console.log('🌐 Starting web server...');
    await webServer.start();

    if (smartThingsAPI.hasAuth()) {
      console.log('🔍 Starting lighting monitor...');
      lightingMonitor.start();
    }

    console.log('✅ SmartThings Matter Bridge is running!');
    console.log('');
    console.log('📱 Web Interface: http://localhost:' + webPort);
    console.log('🏠 Matter Server: Port ' + matterPort);
    console.log('');

    if (matterServer.getQrCode()) {
      console.log('🔗 Matter Pairing Information:');
      console.log('   QR Code: Available in web interface');
      console.log('   Manual Code:', matterServer.getPairingCode());
    }

    const gracefulShutdown = async (signal: string) => {
      console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);

      try {
        coordinator.stop();
        lightingMonitor.stop();
        await matterServer.stop();
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
    console.error('❌ Failed to start SmartThings Matter Bridge:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  startup().catch((error) => {
    console.error('❌ Startup error:', error);
    process.exit(1);
  });
}