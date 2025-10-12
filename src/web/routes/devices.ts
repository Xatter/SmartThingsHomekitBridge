import { Router, Request, Response } from 'express';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { Coordinator } from '@/coordinator/Coordinator';
import { logger } from '@/utils/logger';

export function createDevicesRoutes(api: SmartThingsAPI, coordinator: Coordinator): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    try {
      if (!api.hasAuth()) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const devices = await coordinator.getDevices();
      res.json(devices);
    } catch (error) {
      logger.error({ err: error }, 'Error fetching devices');
      res.status(500).json({ error: 'Failed to fetch devices' });
    }
  });

  router.get('/all', async (req: Request, res: Response) => {
    try {
      if (!api.hasAuth()) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const devices = await api.getDevices([]);

      // Add capability analysis for debugging
      const devicesWithAnalysis = devices.map(device => ({
        ...device,
        capabilityIds: device.capabilities.map(cap => cap.id),
        isHVAC: Object.values(device.thermostatCapabilities).some(Boolean)
      }));

      logger.debug({ count: devices.length }, 'Found filtered devices');
      devicesWithAnalysis.forEach(device => {
        logger.debug({
          name: device.name,
          capabilities: device.capabilityIds,
          isHVAC: device.isHVAC,
          isPaired: device.isPaired
        }, `Device: ${device.name}`);
      });

      res.json(devicesWithAnalysis);
    } catch (error) {
      logger.error({ err: error }, 'Error fetching all devices');
      res.status(500).json({ error: 'Failed to fetch all devices' });
    }
  });

  router.get('/paired', (req: Request, res: Response) => {
    try {
      const state = coordinator.getState();
      const pairedDevicesWithState = Array.from(state.deviceStates.entries())
        .filter(([deviceId, deviceState]) => !deviceState.name.toLowerCase().includes('ecobee'))
        .map(([deviceId, deviceState]) => ({
          ...deviceState,
          id: deviceId,
          lastUpdated: deviceState.lastUpdated instanceof Date
            ? deviceState.lastUpdated.toISOString()
            : new Date(deviceState.lastUpdated).toISOString(),
        }));

      const filteredPairedDevices = state.pairedDevices.filter(deviceId => {
        const deviceState = state.deviceStates.get(deviceId);
        return deviceState && !deviceState.name.toLowerCase().includes('ecobee');
      });

      res.json({
        pairedDevices: filteredPairedDevices,
        deviceStates: pairedDevicesWithState,
        averageTemperature: state.averageTemperature,
        currentMode: state.currentMode,
      });
    } catch (error) {
      logger.error({ err: error }, 'Error fetching paired devices');
      res.status(500).json({ error: 'Failed to fetch paired devices' });
    }
  });

  router.get('/:deviceId', async (req: Request, res: Response) => {
    try {
      if (!api.hasAuth()) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const { deviceId } = req.params;
      const deviceState = await api.getDeviceStatus(deviceId);

      if (!deviceState) {
        return res.status(404).json({ error: 'Device not found' });
      }

      res.json({
        ...deviceState,
        lastUpdated: deviceState.lastUpdated instanceof Date 
          ? deviceState.lastUpdated.toISOString() 
          : new Date(deviceState.lastUpdated).toISOString(),
      });
    } catch (error) {
      logger.error({ err: error, deviceId: req.params.deviceId }, 'Error fetching device');
      res.status(500).json({ error: 'Failed to fetch device' });
    }
  });

  router.post('/:deviceId/temperature', async (req: Request, res: Response) => {
    try {
      if (!api.hasAuth()) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const { deviceId } = req.params;
      const { temperature } = req.body;

      if (typeof temperature !== 'number' || temperature < 45 || temperature > 95) {
        return res.status(400).json({ error: 'Invalid temperature value' });
      }

      const success = await coordinator.changeTemperature(deviceId, temperature);

      if (success) {
        res.json({ success: true, temperature });
      } else {
        res.status(500).json({ error: 'Failed to change temperature' });
      }
    } catch (error) {
      logger.error({ err: error, deviceId: req.params.deviceId }, 'Error changing temperature');
      res.status(500).json({ error: 'Failed to change temperature' });
    }
  });

  router.post('/:deviceId/mode', async (req: Request, res: Response) => {
    try {
      if (!api.hasAuth()) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const { deviceId } = req.params;
      const { mode } = req.body;

      if (!['heat', 'cool', 'auto', 'off'].includes(mode)) {
        return res.status(400).json({ error: 'Invalid mode value' });
      }

      const success = await coordinator.changeMode(deviceId, mode);

      if (success) {
        res.json({ success: true, mode });
      } else {
        res.status(500).json({ error: 'Failed to change mode' });
      }
    } catch (error) {
      logger.error({ err: error, deviceId: req.params.deviceId }, 'Error changing mode');
      res.status(500).json({ error: 'Failed to change mode' });
    }
  });

  router.post('/:deviceId/light/on', async (req: Request, res: Response) => {
    try {
      if (!api.hasAuth()) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const { deviceId } = req.params;
      const success = await api.turnLightOn(deviceId);

      if (success) {
        res.json({ success: true, lightOn: true });
      } else {
        res.status(500).json({ error: 'Failed to turn on light' });
      }
    } catch (error) {
      logger.error({ err: error, deviceId: req.params.deviceId }, 'Error turning on light');
      res.status(500).json({ error: 'Failed to turn on light' });
    }
  });

  router.post('/:deviceId/light/off', async (req: Request, res: Response) => {
    try {
      if (!api.hasAuth()) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const { deviceId } = req.params;
      const success = await api.turnLightOff(deviceId);

      if (success) {
        res.json({ success: true, lightOn: false });
      } else {
        res.status(500).json({ error: 'Failed to turn off light' });
      }
    } catch (error) {
      logger.error({ err: error, deviceId: req.params.deviceId }, 'Error turning off light');
      res.status(500).json({ error: 'Failed to turn off light' });
    }
  });

  router.post('/reload', async (req: Request, res: Response) => {
    try {
      if (!api.hasAuth()) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      await coordinator.reloadDevices();
      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Error reloading devices');
      res.status(500).json({ error: 'Failed to reload devices' });
    }
  });

  return router;
}