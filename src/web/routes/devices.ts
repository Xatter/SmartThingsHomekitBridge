import { Router, Request, Response } from 'express';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { Coordinator } from '@/coordinator/Coordinator';
import { DeviceInclusionManager } from '@/config/DeviceInclusionManager';
import { logger } from '@/utils/logger';

// Default temperature band margin when heating/cooling setpoints are not available
const DEFAULT_TEMP_BAND_MARGIN = 2; // °F

export function createDevicesRoutes(
  api: SmartThingsAPI,
  coordinator: Coordinator,
  inclusionManager: DeviceInclusionManager
): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    try {
      if (!api.hasAuth()) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      // Get ALL devices from SmartThings (not just paired ones)
      const allDevices = await api.getDevices([]);

      // Add inclusion status and current state to each device
      const devicesWithState = await Promise.all(
        allDevices.map(async (device) => {
          const isIncluded = inclusionManager.isIncluded(device.deviceId);

          // Get current state from coordinator (for included devices) and SmartThings
          let internalState = null;
          let smartThingsState = null;

          if (isIncluded) {
            internalState = coordinator.getDeviceState(device.deviceId);
          }

          // Try to fetch current state from SmartThings for all devices
          try {
            smartThingsState = await api.getDeviceStatus(device.deviceId);
          } catch (error) {
            logger.debug({ deviceId: device.deviceId, err: error }, 'Failed to fetch SmartThings state');
          }

          return {
            ...device,
            included: isIncluded,
            // Include state information if available
            internal: internalState ? {
              mode: internalState.mode,
              currentTemperature: internalState.currentTemperature,
              temperatureSetpoint: internalState.temperatureSetpoint,
              heatingSetpoint: internalState.heatingSetpoint,
              coolingSetpoint: internalState.coolingSetpoint,
              lightOn: internalState.lightOn,
              lastUpdated: internalState.lastUpdated instanceof Date
                ? internalState.lastUpdated.toISOString()
                : new Date(internalState.lastUpdated).toISOString(),
            } : null,
            smartThings: smartThingsState ? {
              mode: smartThingsState.mode,
              currentTemperature: smartThingsState.currentTemperature,
              temperatureSetpoint: smartThingsState.temperatureSetpoint,
              heatingSetpoint: smartThingsState.heatingSetpoint,
              coolingSetpoint: smartThingsState.coolingSetpoint,
              lightOn: smartThingsState.lightOn,
              lastUpdated: smartThingsState.lastUpdated instanceof Date
                ? smartThingsState.lastUpdated.toISOString()
                : new Date(smartThingsState.lastUpdated).toISOString(),
            } : null,
          };
        })
      );

      res.json(devicesWithState);
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

  router.get('/paired', async (req: Request, res: Response) => {
    try {
      const state = coordinator.getState();
      // Auto-mode controller is now in the HVAC plugin
      // Access via /api/plugins/hvac-auto-mode/status instead
      const enrolledDeviceIds: string[] = [];

      // Fetch actual SmartThings API state for all devices
      const devicesWithBothStates = await Promise.all(
        Array.from(state.deviceStates.entries())
          .filter(([deviceId, deviceState]) => !deviceState.name.toLowerCase().includes('ecobee'))
          .map(async ([deviceId, internalState]) => {
            // Fetch actual state from SmartThings API
            let smartThingsState = null;
            if (api.hasAuth()) {
              try {
                smartThingsState = await api.getDeviceStatus(deviceId);
              } catch (error) {
                logger.warn({ deviceId, err: error }, 'Failed to fetch SmartThings state for device');
              }
            }

            return {
              id: deviceId,
              name: internalState.name,
              // Internal state (what HomeKit sees)
              internal: {
                mode: internalState.mode,
                currentTemperature: internalState.currentTemperature,
                temperatureSetpoint: internalState.temperatureSetpoint,
                heatingSetpoint: internalState.heatingSetpoint,
                coolingSetpoint: internalState.coolingSetpoint,
                lightOn: internalState.lightOn,
                lastUpdated: internalState.lastUpdated instanceof Date
                  ? internalState.lastUpdated.toISOString()
                  : new Date(internalState.lastUpdated).toISOString(),
              },
              // Actual SmartThings API state (what the device is really doing)
              smartThings: smartThingsState ? {
                mode: smartThingsState.mode,
                currentTemperature: smartThingsState.currentTemperature,
                temperatureSetpoint: smartThingsState.temperatureSetpoint,
                heatingSetpoint: smartThingsState.heatingSetpoint,
                coolingSetpoint: smartThingsState.coolingSetpoint,
                lightOn: smartThingsState.lightOn,
                lastUpdated: smartThingsState.lastUpdated instanceof Date
                  ? smartThingsState.lastUpdated.toISOString()
                  : new Date(smartThingsState.lastUpdated).toISOString(),
              } : null,
              // Auto mode enrollment status
              isEnrolledInAutoMode: enrolledDeviceIds.includes(deviceId),
            };
          })
      );

      const filteredPairedDevices = state.pairedDevices.filter(deviceId => {
        const deviceState = state.deviceStates.get(deviceId);
        return deviceState && !deviceState.name.toLowerCase().includes('ecobee');
      });

      res.json({
        pairedDevices: filteredPairedDevices,
        deviceStates: devicesWithBothStates,
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

      // Get current device state to determine mode
      const deviceState = coordinator.getDeviceState(deviceId);
      if (!deviceState) {
        return res.status(404).json({ error: 'Device not found' });
      }

      const mode = deviceState.mode === 'auto' ? 'cool' : deviceState.mode;
      if (mode === 'off') {
        return res.status(400).json({ error: 'Cannot set temperature when device is off' });
      }

      const success = await api.setTemperature(deviceId, temperature, mode as 'heat' | 'cool');

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

      const success = await api.setMode(deviceId, mode);

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

  // Include/exclude device endpoints
  router.post('/:deviceId/include', async (req: Request, res: Response) => {
    try {
      const { deviceId } = req.params;
      await inclusionManager.setIncluded(deviceId, true);
      logger.info({ deviceId }, 'Device included (reload required)');
      res.json({
        success: true,
        message: 'Device included. Reload devices to add to HomeKit.',
        reloadRequired: true
      });
    } catch (error) {
      logger.error({ err: error, deviceId: req.params.deviceId }, 'Failed to include device');
      res.status(500).json({ error: 'Failed to include device' });
    }
  });

  router.post('/:deviceId/exclude', async (req: Request, res: Response) => {
    try {
      const { deviceId } = req.params;
      await inclusionManager.setIncluded(deviceId, false);
      logger.info({ deviceId }, 'Device excluded (reload required)');
      res.json({
        success: true,
        message: 'Device excluded. Reload devices to remove from HomeKit.',
        reloadRequired: true
      });
    } catch (error) {
      logger.error({ err: error, deviceId: req.params.deviceId }, 'Failed to exclude device');
      res.status(500).json({ error: 'Failed to exclude device' });
    }
  });

  // Auto-mode routes have been moved to the HVAC plugin
  // Access them at /api/plugins/hvac-auto-mode/status and /api/plugins/hvac-auto-mode/decision
  router.get('/auto-mode/status', (req: Request, res: Response) => {
    res.redirect(307, '/api/plugins/hvac-auto-mode/status');
  });

  router.get('/auto-mode/decision', (req: Request, res: Response) => {
    res.redirect(307, '/api/plugins/hvac-auto-mode/decision');
  });

  return router;
}