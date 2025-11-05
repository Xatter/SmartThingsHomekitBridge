import * as cron from 'node-cron';
import { Plugin, PluginContext, PluginWebRoute } from '../../types';
import { UnifiedDevice } from '@/types';
import { Request, Response } from 'express';
import { isThermostatLikeDevice } from '@/utils/deviceUtils';

/**
 * Lighting Monitor Plugin
 *
 * Automatically monitors and turns off AC display lights on a schedule.
 * This is useful for devices where the display light stays on after use
 * and needs to be automatically disabled to save energy.
 *
 * Features:
 * - Periodic checking on configurable schedule
 * - Automatic light-off when detected as on
 * - Filters to only devices with lighting capability
 * - Manual check endpoint for on-demand control
 */
class LightingMonitorPlugin implements Plugin {
  name = 'lighting-monitor';
  version = '1.0.0';
  description = 'Automatically monitors and turns off AC display lights';

  private context!: PluginContext;
  private task: cron.ScheduledTask | null = null;
  private interval: string;

  constructor() {
    // Default: check every 60 seconds
    this.interval = '*/1 * * * *'; // Every minute
  }

  async init(context: PluginContext): Promise<void> {
    this.context = context;

    // Get interval from config (in seconds)
    const intervalSeconds = this.context.config?.checkInterval || 60;
    this.interval = this.convertSecondsToInterval(intervalSeconds);

    this.context.logger.info(
      { interval: this.interval, intervalSeconds },
      'Lighting Monitor plugin initialized'
    );
  }

  async start(): Promise<void> {
    // Start the periodic check
    this.startMonitoring();
    this.context.logger.info('Lighting Monitor plugin started');
  }

  async stop(): Promise<void> {
    this.stopMonitoring();
    this.context.logger.info('Lighting Monitor plugin stopped');
  }

  /**
   * This plugin handles HVAC devices (AC units and thermostats with lights)
   */
  shouldHandleDevice(device: UnifiedDevice): boolean {
    return isThermostatLikeDevice(device);
  }

  /**
   * Convert seconds to cron interval string
   */
  private convertSecondsToInterval(seconds: number): string {
    if (seconds >= 60 && seconds % 60 === 0) {
      const minutes = seconds / 60;
      return `*/${minutes} * * * *`;
    }
    // Node-cron does not support seconds granularity by default.
    // If a sub-minute interval is requested, log a warning and use every minute.
    if (this.context && this.context.logger) {
      this.context.logger.warn(
        { requestedInterval: seconds },
        'Lighting Monitor: Sub-minute intervals are not supported; using every minute instead.'
      );
    }
    return `* * * * *`; // Every minute
  }

  /**
   * Start the monitoring task
   */
  private startMonitoring(): void {
    if (this.task) {
      this.stopMonitoring();
    }

    this.context.logger.info(
      { interval: this.interval },
      'Starting lighting monitor cron task'
    );

    this.task = cron.schedule(
      this.interval,
      async () => {
        await this.checkAndTurnOffLights();
      },
      {
        scheduled: true,
        timezone: 'UTC',
      }
    );

    // Run initial check
    this.checkAndTurnOffLights().catch(error => {
      this.context.logger.error({ err: error }, 'Error in initial light check');
    });
  }

  /**
   * Stop the monitoring task
   */
  private stopMonitoring(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
      this.context.logger.info('Lighting monitor cron task stopped');
    }
  }

  /**
   * Check all monitored devices and turn off lights
   */
  private async checkAndTurnOffLights(): Promise<void> {
    const devices = this.context.getDevices();

    // Filter to devices this plugin handles
    const monitoredDevices = devices.filter(d => this.shouldHandleDevice(d));

    if (monitoredDevices.length === 0) {
      this.context.logger.debug('No devices to monitor for lighting');
      return;
    }

    this.context.logger.debug(
      { deviceCount: monitoredDevices.length },
      'Checking devices for lights'
    );

    const promises = monitoredDevices.map(async (device) => {
      try {
        // Get fresh device status from SmartThings
        const deviceState = await this.context.getDeviceStatus(device.deviceId);

        if (!deviceState) {
          this.context.logger.warn(
            { deviceId: device.deviceId },
            'Could not get device status'
          );
          return;
        }

        // Check if light is on
        if (deviceState.lightOn) {
          this.context.logger.info(
            { deviceId: device.deviceId, deviceName: deviceState.name },
            'Light is ON, turning off'
          );

          const success = await this.context.turnLightOff(device.deviceId);

          if (success) {
            this.context.logger.info(
              { deviceName: deviceState.name },
              'Successfully turned off light'
            );
          } else {
            this.context.logger.error(
              { deviceName: deviceState.name },
              'Failed to turn off light'
            );
          }
        } else {
          this.context.logger.debug(
            { deviceId: device.deviceId, deviceName: deviceState.name },
            'Light is already OFF'
          );
        }
      } catch (error) {
        this.context.logger.error(
          { err: error, deviceId: device.deviceId },
          'Error checking device lighting'
        );
      }
    });

    await Promise.allSettled(promises);
  }

  /**
   * Manually check a specific device
   */
  private async checkDevice(deviceId: string): Promise<boolean> {
    try {
      const deviceState = await this.context.getDeviceStatus(deviceId);

      if (!deviceState) {
        this.context.logger.warn({ deviceId }, 'Could not get status for device');
        return false;
      }

      if (deviceState.lightOn) {
        this.context.logger.info(
          { deviceId, deviceName: deviceState.name },
          'Manual check - Light is ON, turning off'
        );

        const success = await this.context.turnLightOff(deviceId);

        if (success) {
          this.context.logger.info(
            { deviceName: deviceState.name },
            'Successfully turned off light'
          );
          return true;
        } else {
          this.context.logger.error(
            { deviceName: deviceState.name },
            'Failed to turn off light'
          );
          return false;
        }
      } else {
        this.context.logger.debug(
          { deviceId, deviceName: deviceState.name },
          'Manual check - Light is already OFF'
        );
        return true;
      }
    } catch (error) {
      this.context.logger.error(
        { err: error, deviceId },
        'Error in manual check for device'
      );
      return false;
    }
  }

  /**
   * Provide web routes for manual control
   */
  getWebRoutes(): PluginWebRoute[] {
    return [
      {
        path: '/status',
        method: 'get',
        handler: (req: Request, res: Response) => {
          const devices = this.context.getDevices();
          const monitoredDevices = devices.filter(d => this.shouldHandleDevice(d));

          res.json({
            running: this.task !== null,
            interval: this.interval,
            monitoredDeviceCount: monitoredDevices.length,
            monitoredDevices: monitoredDevices.map(d => ({
              id: d.deviceId,
              name: d.label,
            })),
          });
        },
      },
      {
        path: '/check/:deviceId',
        method: 'get',
        handler: async (req: Request, res: Response) => {
          const { deviceId } = req.params;

          try {
            const success = await this.checkDevice(deviceId);
            res.json({ success, deviceId });
          } catch (error) {
            this.context.logger.error(
              { err: error, deviceId },
              'Error in manual check endpoint'
            );
            res.status(500).json({ error: 'Failed to check device' });
          }
        },
      },
    ];
  }
}

// Export the plugin instance
export default new LightingMonitorPlugin();
