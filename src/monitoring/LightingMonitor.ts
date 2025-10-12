import * as cron from 'node-cron';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { logger } from '@/utils/logger';

export class LightingMonitor {
  private readonly api: SmartThingsAPI;
  private monitoredDevices: string[] = [];
  private task: cron.ScheduledTask | null = null;
  private readonly interval: string;

  constructor(api: SmartThingsAPI, intervalSeconds: number = 60) {
    this.api = api;
    this.interval = this.convertSecondsToInterval(intervalSeconds);
  }

  private convertSecondsToInterval(seconds: number): string {
    if (seconds >= 60 && seconds % 60 === 0) {
      const minutes = seconds / 60;
      return `*/${minutes} * * * *`;
    }
    return `*/${seconds} * * * * *`;
  }

  setDevices(deviceIds: string[]): void {
    this.monitoredDevices = [...deviceIds];
    logger.info({ count: deviceIds.length, deviceIds }, 'LightingMonitor set to monitor devices');

    // If we now have devices and the monitor was previously started but stopped due to no devices,
    // or if the task exists but needs to restart with new devices, restart it
    if (deviceIds.length > 0) {
      logger.debug('LightingMonitor: Devices updated, restarting monitor');
      this.start();
    } else if (this.task) {
      logger.info('LightingMonitor: No devices to monitor, stopping monitor');
      this.stop();
    }
  }

  start(): void {
    logger.debug('LightingMonitor: start() method called');

    if (this.task) {
      logger.debug('LightingMonitor: Stopping existing task before starting new one');
      this.stop();
    }

    if (this.monitoredDevices.length === 0) {
      logger.info('LightingMonitor: No devices to monitor');
      return;
    }

    logger.info({ interval: this.interval, deviceCount: this.monitoredDevices.length }, 'Starting LightingMonitor');

    this.task = cron.schedule(this.interval, async () => {
      logger.debug('LightingMonitor cron triggered');
      await this.checkAndTurnOffLights();
    }, {
      scheduled: false,
      timezone: 'UTC'
    });

    this.task.start();
    logger.info({ cronPattern: this.interval }, 'LightingMonitor started');

    // Immediately run a check on start
    logger.debug('LightingMonitor: Running initial light check');
    this.checkAndTurnOffLights().catch(error => {
      logger.error({ err: error }, 'LightingMonitor: Error in initial light check');
    });
  }

  stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
      logger.info('LightingMonitor stopped');
    }
  }

  private async checkAndTurnOffLights(): Promise<void> {
    if (!this.api.hasAuth()) {
      logger.warn('LightingMonitor: No SmartThings authentication available');
      return;
    }

    logger.debug({ deviceCount: this.monitoredDevices.length }, 'LightingMonitor: Checking devices for lights');

    const promises = this.monitoredDevices.map(async (deviceId) => {
      try {
        const deviceState = await this.api.getDeviceStatus(deviceId);

        if (!deviceState) {
          logger.warn({ deviceId }, 'LightingMonitor: Could not get status for device');
          return;
        }

        if (deviceState.lightOn) {
          logger.info({ deviceId, deviceName: deviceState.name }, 'LightingMonitor: Light is ON, turning off');
          const success = await this.api.turnLightOff(deviceId);

          if (success) {
            logger.info({ deviceName: deviceState.name }, 'LightingMonitor: Successfully turned off light');
          } else {
            logger.error({ deviceName: deviceState.name }, 'LightingMonitor: Failed to turn off light');
          }
        } else {
          logger.debug({ deviceId, deviceName: deviceState.name }, 'LightingMonitor: Light is already OFF');
        }
      } catch (error) {
        logger.error({ err: error, deviceId }, 'LightingMonitor: Error checking device');
      }
    });

    await Promise.allSettled(promises);
  }

  async checkDevice(deviceId: string): Promise<boolean> {
    try {
      const deviceState = await this.api.getDeviceStatus(deviceId);

      if (!deviceState) {
        logger.warn({ deviceId }, 'LightingMonitor: Could not get status for device');
        return false;
      }

      if (deviceState.lightOn) {
        logger.info({ deviceId, deviceName: deviceState.name }, 'LightingMonitor: Manual check - Light is ON, turning off');
        const success = await this.api.turnLightOff(deviceId);

        if (success) {
          logger.info({ deviceName: deviceState.name }, 'LightingMonitor: Successfully turned off light');
          return true;
        } else {
          logger.error({ deviceName: deviceState.name }, 'LightingMonitor: Failed to turn off light');
          return false;
        }
      } else {
        logger.debug({ deviceId, deviceName: deviceState.name }, 'LightingMonitor: Manual check - Light is already OFF');
        return true;
      }
    } catch (error) {
      logger.error({ err: error, deviceId }, 'LightingMonitor: Error in manual check for device');
      return false;
    }
  }

  getMonitoredDevices(): string[] {
    return [...this.monitoredDevices];
  }

  isRunning(): boolean {
    return this.task !== null;
  }
}