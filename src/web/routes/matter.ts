import { Router, Request, Response } from 'express';
import { MatterServer } from '@/matter/MatterServer';

export function createMatterRoutes(matterServer: MatterServer): Router {
  const router = Router();

  router.get('/pairing', (req: Request, res: Response) => {
    try {
      const qrCode = matterServer.getQrCode();
      const pairingCode = matterServer.getPairingCode();

      res.json({
        qrCode,
        pairingCode,
        instructions: {
          homekit: [
            'Open the Home app on your iOS device',
            'Tap the + button to add a new accessory',
            'Choose "Add Accessory"',
            'Scan the QR code below or enter the manual pairing code',
            'Follow the on-screen instructions to complete pairing'
          ],
          general: [
            'Use any Matter-compatible controller',
            'Scan the QR code or enter the manual pairing code',
            'Your thermostats will appear as individual devices'
          ]
        }
      });
    } catch (error) {
      console.error('Error getting Matter pairing info:', error);
      res.status(500).json({ error: 'Failed to get pairing information' });
    }
  });

  router.get('/status', (req: Request, res: Response) => {
    try {
      const qrCode = matterServer.getQrCode();
      const pairingCode = matterServer.getPairingCode();

      res.json({
        running: qrCode !== null,
        qrCode,
        pairingCode,
      });
    } catch (error) {
      console.error('Error getting Matter status:', error);
      res.status(500).json({ error: 'Failed to get Matter status' });
    }
  });

  return router;
}