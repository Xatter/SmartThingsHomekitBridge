import * as cron from 'node-cron';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';

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
    console.log(`LightingMonitor set to monitor ${deviceIds.length} devices:`, deviceIds);
  }

  start(): void {
    if (this.task) {
      this.stop();
    }

    if (this.monitoredDevices.length === 0) {
      console.log('LightingMonitor: No devices to monitor');
      return;
    }

    console.log(`Starting LightingMonitor with interval: ${this.interval}`);

    this.task = cron.schedule(this.interval, async () => {
      console.log(`[${new Date().toISOString()}] LightingMonitor cron triggered`);
      await this.checkAndTurnOffLights();
    }, {
      scheduled: false,
      timezone: 'UTC'
    });

    this.task.start();
    console.log(`LightingMonitor started with cron pattern: ${this.interval}`);
  }

  stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
      console.log('LightingMonitor stopped');
    }
  }

  private async checkAndTurnOffLights(): Promise<void> {
    if (!this.api.hasAuth()) {
      console.warn('LightingMonitor: No SmartThings authentication available');
      return;
    }

    console.log(`LightingMonitor: Checking ${this.monitoredDevices.length} devices for lights`);

    const promises = this.monitoredDevices.map(async (deviceId) => {
      try {
        const deviceState = await this.api.getDeviceStatus(deviceId);

        if (!deviceState) {
          console.warn(`LightingMonitor: Could not get status for device ${deviceId}`);
          return;
        }

        if (deviceState.lightOn) {
          console.log(`LightingMonitor: Light is ON for device ${deviceState.name} (${deviceId}), turning off`);
          const success = await this.api.turnLightOff(deviceId);

          if (success) {
            console.log(`LightingMonitor: Successfully turned off light for ${deviceState.name}`);
          } else {
            console.error(`LightingMonitor: Failed to turn off light for ${deviceState.name}`);
          }
        } else {
          console.log(`LightingMonitor: Light is already OFF for device ${deviceState.name} (${deviceId})`);
        }
      } catch (error) {
        console.error(`LightingMonitor: Error checking device ${deviceId}:`, error);
      }
    });

    await Promise.allSettled(promises);
  }

  async checkDevice(deviceId: string): Promise<boolean> {
    try {
      const deviceState = await this.api.getDeviceStatus(deviceId);

      if (!deviceState) {
        console.warn(`LightingMonitor: Could not get status for device ${deviceId}`);
        return false;
      }

      if (deviceState.lightOn) {
        console.log(`LightingMonitor: Manual check - Light is ON for device ${deviceState.name} (${deviceId}), turning off`);
        const success = await this.api.turnLightOff(deviceId);

        if (success) {
          console.log(`LightingMonitor: Successfully turned off light for ${deviceState.name}`);
          return true;
        } else {
          console.error(`LightingMonitor: Failed to turn off light for ${deviceState.name}`);
          return false;
        }
      } else {
        console.log(`LightingMonitor: Manual check - Light is already OFF for device ${deviceState.name} (${deviceId})`);
        return true;
      }
    } catch (error) {
      console.error(`LightingMonitor: Error in manual check for device ${deviceId}:`, error);
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