import * as cron from 'node-cron';
import { Plugin, PluginContext, PluginWebRoute } from '../../types';
import { UnifiedDevice, DeviceState } from '@/types';
import { Request, Response } from 'express';
import { isThermostatLikeDevice } from '@/utils/deviceUtils';

/**
 * Auto Mode Monitor Plugin
 *
 * Monitors mini-splits and other HVAC devices for 'auto' mode and
 * automatically corrects them to the appropriate heat/cool mode
 * with a proper temperature setpoint.
 *
 * This is useful because mini-split remotes often send ALL state
 * on every button press, which can inadvertently set devices to
 * auto mode even when that's not desired.
 *
 * Features:
 * - Periodic checking on configurable schedule
 * - Detects devices in 'auto' mode from SmartThings
 * - Determines correct mode (heat/cool) from other devices or temp vs setpoint
 * - Sets both mode AND temperature when correcting
 * - Configurable default temperatures for heat (68°F) and cool (72°F)
 */
class AutoModeMonitorPlugin implements Plugin {
  name = 'auto-mode-monitor';
  version = '1.0.0';
  description = 'Monitors and corrects mini-splits stuck in auto mode';

  private context!: PluginContext;
  private task: cron.ScheduledTask | null = null;
  private interval: string = '*/1 * * * *'; // Default: every minute
  private defaultHeatTemperature: number = 68;
  private defaultCoolTemperature: number = 72;

  async init(context: PluginContext): Promise<void> {
    this.context = context;

    // Get interval from config (in seconds)
    const intervalSeconds = this.context.config?.checkInterval || 60;
    this.interval = this.convertSecondsToInterval(intervalSeconds);

    // Get default temperatures from config
    this.defaultHeatTemperature = this.context.config?.defaultHeatTemperature || 68;
    this.defaultCoolTemperature = this.context.config?.defaultCoolTemperature || 72;

    this.context.logger.info(
      {
        interval: this.interval,
        intervalSeconds,
        defaultHeatTemperature: this.defaultHeatTemperature,
        defaultCoolTemperature: this.defaultCoolTemperature,
      },
      'Auto Mode Monitor plugin initialized'
    );
  }

  async start(): Promise<void> {
    this.startMonitoring();
    this.context.logger.info('Auto Mode Monitor plugin started');
  }

  async stop(): Promise<void> {
    this.stopMonitoring();
    this.context.logger.info('Auto Mode Monitor plugin stopped');
  }

  /**
   * This plugin handles HVAC devices (thermostats and air conditioners)
   */
  shouldHandleDevice(device: UnifiedDevice): boolean {
    return isThermostatLikeDevice(device);
  }

  /**
   * Run auto-mode check on each poll cycle
   */
  async onPollCycle(devices: UnifiedDevice[]): Promise<void> {
    await this.checkAndCorrectAutoMode();
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
        'Auto Mode Monitor: Sub-minute intervals are not supported; using every minute instead.'
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
      'Starting auto mode monitor cron task'
    );

    this.task = cron.schedule(
      this.interval,
      async () => {
        await this.checkAndCorrectAutoMode();
      },
      {
        scheduled: true,
        timezone: 'UTC',
      }
    );

    // Run initial check
    this.checkAndCorrectAutoMode().catch(error => {
      this.context.logger.error({ err: error }, 'Error in initial auto mode check');
    });
  }

  /**
   * Stop the monitoring task
   */
  private stopMonitoring(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
      this.context.logger.info('Auto mode monitor cron task stopped');
    }
  }

  /**
   * Check all devices and correct those in auto mode
   */
  private async checkAndCorrectAutoMode(): Promise<void> {
    const devices = this.context.getDevices();

    // Filter to thermostat-like devices
    const thermostatDevices = devices.filter(d => this.shouldHandleDevice(d));

    if (thermostatDevices.length === 0) {
      this.context.logger.debug('No thermostat devices to monitor');
      return;
    }

    // Get fresh status for all devices
    const deviceStates: Map<string, DeviceState> = new Map();
    for (const device of thermostatDevices) {
      try {
        const state = await this.context.getDeviceStatus(device.deviceId);
        if (state) {
          deviceStates.set(device.deviceId, state);
        }
      } catch (error) {
        this.context.logger.error(
          { err: error, deviceId: device.deviceId },
          'Failed to get device status'
        );
      }
    }

    // Find devices in auto mode
    const devicesInAutoMode: Array<{ device: UnifiedDevice; state: DeviceState }> = [];
    const devicesInOtherModes: Array<{ device: UnifiedDevice; state: DeviceState }> = [];

    for (const device of thermostatDevices) {
      const state = deviceStates.get(device.deviceId);
      if (!state) continue;

      const mode = (state.mode || '').toLowerCase();
      if (mode === 'auto') {
        devicesInAutoMode.push({ device, state });
      } else if (mode === 'heat' || mode === 'cool') {
        devicesInOtherModes.push({ device, state });
      }
    }

    if (devicesInAutoMode.length === 0) {
      this.context.logger.debug('No devices in auto mode');
      return;
    }

    this.context.logger.info(
      { count: devicesInAutoMode.length, devices: devicesInAutoMode.map(d => d.device.label) },
      '⚠️  Detected devices in auto mode - correcting'
    );

    // Determine the target mode based on other devices or temperature heuristic
    const targetMode = this.determineTargetMode(devicesInAutoMode, devicesInOtherModes);

    if (!targetMode) {
      this.context.logger.warn('Could not determine target mode for auto-mode devices');
      return;
    }

    this.context.logger.info(
      { mode: targetMode },
      '🔧 Correcting auto-mode devices'
    );

    // Correct each device
    for (const { device, state } of devicesInAutoMode) {
      try {
        const temperature = this.determineTemperature(targetMode, state);

        const newState: Record<string, any> = {
          thermostatMode: targetMode,
        };

        // Set the appropriate setpoint based on mode
        if (targetMode === 'heat') {
          newState.heatingSetpoint = temperature;
        } else {
          newState.coolingSetpoint = temperature;
        }

        await this.context.setSmartThingsState(device.deviceId, newState);

        this.context.logger.info(
          {
            deviceId: device.deviceId,
            deviceName: device.label,
            mode: targetMode,
            temperature,
          },
          '✅ Corrected device from auto mode'
        );
      } catch (error) {
        this.context.logger.error(
          { err: error, deviceId: device.deviceId, deviceName: device.label },
          '❌ Failed to correct device from auto mode'
        );
      }
    }
  }

  /**
   * Determine the target mode for devices in auto mode.
   *
   * Priority:
   * 1. If any other device is in heat/cool, use that mode
   * 2. Use temperature vs setpoint heuristic
   */
  private determineTargetMode(
    devicesInAutoMode: Array<{ device: UnifiedDevice; state: DeviceState }>,
    devicesInOtherModes: Array<{ device: UnifiedDevice; state: DeviceState }>
  ): 'heat' | 'cool' | null {
    // Check if any other device is actively heating or cooling
    for (const { state } of devicesInOtherModes) {
      const mode = (state.mode || '').toLowerCase();
      if (mode === 'heat' || mode === 'cool') {
        this.context.logger.debug(
          { deviceId: state.id, deviceName: state.name, mode },
          'Using mode from other active device'
        );
        return mode;
      }
    }

    // No other device is active - use temperature vs setpoint heuristic
    const { state } = devicesInAutoMode[0];
    const temp = state.currentTemperature;

    // Use the midpoint of heat/cool setpoints, or default to 70°F
    const heatSetpoint = state.heatingSetpoint ?? this.defaultHeatTemperature;
    const coolSetpoint = state.coolingSetpoint ?? this.defaultCoolTemperature;
    const midpoint = (heatSetpoint + coolSetpoint) / 2;

    if (temp === undefined) {
      this.context.logger.warn(
        { deviceId: state.id, deviceName: state.name },
        'Cannot determine mode: missing temperature data'
      );
      return null;
    }

    // If below midpoint, heat; otherwise cool
    const mode = temp < midpoint ? 'heat' : 'cool';
    this.context.logger.debug(
      { deviceId: state.id, temp, midpoint, mode },
      'Determined mode from temperature vs setpoint heuristic'
    );
    return mode;
  }

  /**
   * Determine the temperature setpoint for a device.
   *
   * Priority:
   * 1. Use device's existing setpoint for the target mode
   * 2. Fall back to default temperature
   */
  private determineTemperature(
    mode: 'heat' | 'cool',
    state: DeviceState
  ): number {
    if (mode === 'heat') {
      return state.heatingSetpoint ?? this.defaultHeatTemperature;
    } else {
      return state.coolingSetpoint ?? this.defaultCoolTemperature;
    }
  }

  /**
   * Manually trigger an auto mode check
   */
  async manualCheck(): Promise<{
    checked: number;
    corrected: string[];
    errors: string[];
  }> {
    const devices = this.context.getDevices();
    const thermostatDevices = devices.filter(d => this.shouldHandleDevice(d));

    const corrected: string[] = [];
    const errors: string[] = [];

    // Get fresh status for all devices
    const deviceStates: Map<string, DeviceState> = new Map();
    for (const device of thermostatDevices) {
      try {
        const state = await this.context.getDeviceStatus(device.deviceId);
        if (state) {
          deviceStates.set(device.deviceId, state);
        }
      } catch (error) {
        errors.push(device.deviceId);
      }
    }

    // Find and correct devices in auto mode
    const devicesInAutoMode: Array<{ device: UnifiedDevice; state: DeviceState }> = [];
    const devicesInOtherModes: Array<{ device: UnifiedDevice; state: DeviceState }> = [];

    for (const device of thermostatDevices) {
      const state = deviceStates.get(device.deviceId);
      if (!state) continue;

      const mode = (state.mode || '').toLowerCase();
      if (mode === 'auto') {
        devicesInAutoMode.push({ device, state });
      } else if (mode === 'heat' || mode === 'cool') {
        devicesInOtherModes.push({ device, state });
      }
    }

    if (devicesInAutoMode.length > 0) {
      const targetMode = this.determineTargetMode(devicesInAutoMode, devicesInOtherModes);

      if (targetMode) {
        for (const { device, state } of devicesInAutoMode) {
          try {
            const temperature = this.determineTemperature(targetMode, state);
            const newState: Record<string, any> = {
              thermostatMode: targetMode,
            };

            if (targetMode === 'heat') {
              newState.heatingSetpoint = temperature;
            } else {
              newState.coolingSetpoint = temperature;
            }

            await this.context.setSmartThingsState(device.deviceId, newState);
            corrected.push(device.deviceId);
          } catch (error) {
            errors.push(device.deviceId);
          }
        }
      }
    }

    return {
      checked: thermostatDevices.length,
      corrected,
      errors,
    };
  }

  /**
   * Provide web routes for status and manual control
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
            defaultHeatTemperature: this.defaultHeatTemperature,
            defaultCoolTemperature: this.defaultCoolTemperature,
            monitoredDeviceCount: monitoredDevices.length,
            monitoredDevices: monitoredDevices.map(d => ({
              id: d.deviceId,
              name: d.label,
              mode: d.mode,
            })),
          });
        },
      },
      {
        path: '/check',
        method: 'post',
        handler: async (req: Request, res: Response) => {
          try {
            const result = await this.manualCheck();
            res.json(result);
          } catch (error) {
            this.context.logger.error(
              { err: error },
              'Error in manual check endpoint'
            );
            res.status(500).json({ error: 'Failed to check devices' });
          }
        },
      },
    ];
  }
}

// Export the plugin instance
export default new AutoModeMonitorPlugin();
