import { Plugin, PluginContext, PluginWebRoute } from '../../types';
import { UnifiedDevice } from '@/types';
import { AutoModeController, AutoModeDevice } from './AutoModeController';
import { Request, Response } from 'express';
import { isThermostatLikeDevice } from '@/utils/deviceUtils';

/**
 * HVAC Auto-Mode Plugin
 *
 * Implements intelligent multi-device HVAC coordination for systems with
 * a shared outdoor compressor. When users set thermostats to AUTO mode,
 * this plugin automatically enrolls them and coordinates mode switching
 * (HEAT/COOL/OFF) based on weighted demand calculations.
 *
 * Features:
 * - Proportional demand calculation
 * - Conflict resolution with dominance thresholds
 * - Timing protections (min on/off/lock times)
 * - Flip guard for shoulder season stability
 * - Freeze/high-temp safety overrides
 * - Web dashboard for real-time monitoring
 */
class HVACAutoModePlugin implements Plugin {
  name = 'hvac-auto-mode';
  version = '2.0.0';
  description = 'Intelligent multi-device HVAC auto-mode coordination';

  private context!: PluginContext;
  private controller!: AutoModeController;
  private readonly AUTO_MODE_MARKER = 'auto';

  async init(context: PluginContext): Promise<void> {
    this.context = context;

    // Initialize the auto-mode controller
    this.controller = new AutoModeController(
      'state', // State key for plugin context
      this.context.config // Pass through config from plugin settings
    );

    // Load controller state
    const savedState = await this.context.loadState('state');
    if (savedState) {
      // Restore from plugin state
      Object.assign((this.controller as any).state, savedState);
      this.context.logger.info(
        {
          mode: this.controller.getCurrentMode(),
          enrolledCount: this.controller.getEnrolledDeviceIds().length,
        },
        'Auto-mode controller state restored'
      );
    }

    this.context.logger.info('HVAC Auto-Mode plugin initialized');
  }

  async start(): Promise<void> {
    this.context.logger.info('HVAC Auto-Mode plugin started');
  }

  async stop(): Promise<void> {
    // Save state on shutdown
    const status = this.controller.getStatus();
    await this.context.saveState('state', {
      currentMode: status.currentMode,
      enrolledDeviceIds: status.enrolledDeviceIds,
      timeSinceLastSwitch: status.timeSinceLastSwitch,
    });

    this.context.logger.info('HVAC Auto-Mode plugin stopped');
  }

  /**
   * Handle all thermostat-like devices (thermostats and air conditioners)
   */
  shouldHandleDevice(device: UnifiedDevice): boolean {
    return isThermostatLikeDevice(device);
  }

  /**
   * Intercept HomeKit -> SmartThings state changes
   * Enroll/unenroll devices based on mode changes
   * Handles both thermostatMode (traditional thermostats) and airConditionerMode (Samsung ACs)
   */
  async beforeSetSmartThingsState(device: UnifiedDevice, state: any): Promise<any | null> {
    // Check for mode changes in either thermostatMode or airConditionerMode
    const modeField = state.thermostatMode ? 'thermostatMode' :
                     state.airConditionerMode ? 'airConditionerMode' : null;

    if (modeField) {
      const mode = state[modeField].toLowerCase();

      // Check if switching to AUTO mode (enroll)
      if (mode === this.AUTO_MODE_MARKER) {
        await this.controller.enrollDevice(device.deviceId);
        this.context.logger.info(
          { deviceId: device.deviceId, deviceName: device.label },
          '✅ Device enrolled in auto-mode'
        );

        // Don't send AUTO to SmartThings - keep current mode
        // Let the controller decide the actual mode
        const currentMode = this.controller.getCurrentMode();
        return {
          ...state,
          [modeField]: currentMode,
        };
      }

      // Switching to manual mode (HEAT/COOL/OFF) - unenroll
      if (['heat', 'cool', 'off'].includes(mode)) {
        await this.controller.unenrollDevice(device.deviceId);
        this.context.logger.info(
          { deviceId: device.deviceId, deviceName: device.label, mode },
          '🚫 Device unenrolled from auto-mode'
        );
      }
    }

    return state;
  }

  /**
   * Intercept SmartThings -> HomeKit state changes
   * Display AUTO in HomeKit for enrolled devices
   */
  async beforeSetHomeKitState(device: UnifiedDevice, state: any): Promise<any | null> {
    const enrolledIds = this.controller.getEnrolledDeviceIds();

    if (enrolledIds.includes(device.deviceId)) {
      // Device is enrolled - show AUTO in HomeKit
      return {
        ...state,
        thermostatMode: this.AUTO_MODE_MARKER,
      };
    }

    return state;
  }

  /**
   * Run auto-mode coordination on each poll cycle
   */
  async onPollCycle(devices: UnifiedDevice[]): Promise<void> {
    const enrolledIds = this.controller.getEnrolledDeviceIds();
    if (enrolledIds.length === 0) {
      // No devices enrolled
      return;
    }

    // Build AutoModeDevice array from enrolled devices
    const autoModeDevices: AutoModeDevice[] = [];

    for (const deviceId of enrolledIds) {
      const device = devices.find(d => d.deviceId === deviceId);
      if (!device) {
        this.context.logger.warn(
          { deviceId },
          '⚠️  Enrolled device not found, skipping'
        );
        continue;
      }

      // Validate required fields
      const temp = device.currentTemperature;
      const heatSetpoint = device.heatingSetpoint;
      const coolSetpoint = device.coolingSetpoint;

      if (
        temp === undefined ||
        heatSetpoint === undefined ||
        coolSetpoint === undefined ||
        isNaN(temp) ||
        isNaN(heatSetpoint) ||
        isNaN(coolSetpoint)
      ) {
        this.context.logger.warn(
          { deviceId, deviceName: device.label, temp, heatSetpoint, coolSetpoint },
          '⚠️  Device has invalid temperature data, skipping'
        );
        continue;
      }

      autoModeDevices.push({
        id: deviceId,
        name: device.label,
        currentTemperature: temp,
        lowerBound: heatSetpoint,
        upperBound: coolSetpoint,
        weight: 1.0, // Could be configurable per-device
      });
    }

    if (autoModeDevices.length === 0) {
      this.context.logger.debug('No valid enrolled devices for auto-mode evaluation');
      return;
    }

    // Evaluate controller decision
    const decision = this.controller.evaluate(autoModeDevices);

    this.context.logger.debug(
      {
        mode: decision.mode,
        heatDemand: decision.totalHeatDemand.toFixed(1),
        coolDemand: decision.totalCoolDemand.toFixed(1),
        reason: decision.reason,
        suppressed: decision.switchSuppressed,
      },
      '🤖 Auto-mode evaluation'
    );

    // Apply decision (updates controller state)
    const modeChanged = await this.controller.applyDecision(decision);

    if (modeChanged) {
      // Mode switched - update all enrolled devices in SmartThings
      this.context.logger.info(
        { mode: decision.mode, enrolledCount: autoModeDevices.length },
        '🎯 Applying mode to all enrolled devices'
      );

      for (const device of autoModeDevices) {
        try {
          await this.context.setSmartThingsState(device.id, {
            thermostatMode: decision.mode,
          });
          this.context.logger.debug(
            { deviceId: device.id, deviceName: device.name, mode: decision.mode },
            '✅ Device mode updated'
          );
        } catch (error) {
          this.context.logger.error(
            { err: error, deviceId: device.id, deviceName: device.name },
            '❌ Failed to update device mode'
          );
        }
      }
    }

    // Save controller state after each evaluation
    await this.saveControllerState();
  }

  /**
   * Save controller state to plugin persistence
   */
  private async saveControllerState(): Promise<void> {
    const status = this.controller.getStatus();
    await this.context.saveState('state', {
      currentMode: status.currentMode,
      enrolledDeviceIds: status.enrolledDeviceIds,
      lastSwitchTime: Date.now() - status.timeSinceLastSwitch * 1000,
      ...(this.controller as any).state, // Include all internal state
    });
  }

  /**
   * Provide web routes for the auto-mode dashboard
   */
  getWebRoutes(): PluginWebRoute[] {
    return [
      {
        path: '/status',
        handler: async (req: Request, res: Response) => {
          const status = this.controller.getStatus();
          res.json(status);
        },
      },
      {
        path: '/decision',
        handler: async (req: Request, res: Response) => {
          const devices = this.context.getDevices();
          const enrolledIds = this.controller.getEnrolledDeviceIds();

          const autoModeDevices: AutoModeDevice[] = devices
            .filter(d => enrolledIds.includes(d.deviceId))
            .filter(d =>
              d.currentTemperature !== undefined &&
              d.heatingSetpoint !== undefined &&
              d.coolingSetpoint !== undefined
            )
            .map(d => ({
              id: d.deviceId,
              name: d.label,
              currentTemperature: d.currentTemperature!,
              lowerBound: d.heatingSetpoint!,
              upperBound: d.coolingSetpoint!,
              weight: 1.0,
            }));

          if (autoModeDevices.length === 0) {
            return res.json({
              mode: 'off',
              totalHeatDemand: 0,
              totalCoolDemand: 0,
              deviceDemands: [],
              reason: 'No enrolled devices with valid data',
              switchSuppressed: false,
              secondsUntilSwitchAllowed: 0,
            });
          }

          const decision = this.controller.evaluate(autoModeDevices);
          res.json(decision);
        },
      },
    ];
  }
}

// Export the plugin instance
export default new HVACAutoModePlugin();
