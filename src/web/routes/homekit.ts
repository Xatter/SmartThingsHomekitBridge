import { Router, Request, Response } from 'express';
import { SmartThingsHAPServer } from '@/hap/HAPServer';

export function createHomeKitRoutes(hapServer: SmartThingsHAPServer): Router {
  const router = Router();

  router.get('/pairing', (req: Request, res: Response) => {
    try {
      const qrCode = hapServer.getQrCode();
      const pairingCode = hapServer.getPairingCode();

      res.json({
        qrCode,
        pairingCode,
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
      console.error('Error getting HomeKit pairing info:', error);
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
      console.error('Error getting HomeKit status:', error);
      res.status(500).json({ error: 'Failed to get HomeKit status' });
    }
  });

  return router;
}