import { Router, Request, Response } from 'express';
import { SmartThingsHAPServer } from '@/hap/HAPServer';
import { logger } from '@/utils/logger';

export function createHomeKitRoutes(hapServer: SmartThingsHAPServer): Router {
  const router = Router();

  router.get('/pairing', (req: Request, res: Response) => {
    try {
      const qrCode = hapServer.getQrCode();
      const pairingCode = hapServer.getPairingCode();
      const isPaired = hapServer.isPaired();

      res.json({
        qrCode,
        pairingCode,
        isPaired,
        instructions: {
          homekit: [
            'Open the Home app on your iOS device',
            'Tap the + button to add a new accessory',
            'Choose "Add Accessory"',
            'Scan the QR code below or enter the setup code',
            'Follow the on-screen instructions to complete pairing'
          ]
        }
      });
    } catch (error) {
      logger.error({ err: error }, 'Error getting HomeKit pairing info');
      res.status(500).json({ error: 'Failed to get pairing information' });
    }
  });

  router.get('/status', (req: Request, res: Response) => {
    try {
      const qrCode = hapServer.getQrCode();
      const pairingCode = hapServer.getPairingCode();

      res.json({
        running: qrCode !== null,
        qrCode,
        pairingCode,
      });
    } catch (error) {
      logger.error({ err: error }, 'Error getting HomeKit status');
      res.status(500).json({ error: 'Failed to get HomeKit status' });
    }
  });

  router.post('/reset-pairing', async (req: Request, res: Response) => {
    try {
      logger.info('Pairing reset requested via API');
      await hapServer.resetPairing();
      res.json({
        success: true,
        message: 'HomeKit pairing reset initiated. The bridge will restart shortly.'
      });
    } catch (error) {
      logger.error({ err: error }, 'Error resetting HomeKit pairing');
      res.status(500).json({ error: 'Failed to reset HomeKit pairing' });
    }
  });

  return router;
}