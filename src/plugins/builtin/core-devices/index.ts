import { Plugin, PluginContext } from '../../types';
import { UnifiedDevice } from '@/types';

/**
 * Core Devices Plugin
 *
 * This plugin provides basic passthrough support for common SmartThings device types:
 * - Lights (on/off, brightness)
 * - Switches
 * - Outlets
 * - Sensors (contact, motion, temperature)
 *
 * It serves as a baseline implementation showing how plugins can map
 * SmartThings devices to HomeKit accessories.
 */
class CoreDevicesPlugin implements Plugin {
  name = 'core-devices';
  version = '1.0.0';
  description = 'Basic support for lights, switches, outlets, and sensors';

  private context!: PluginContext;

  async init(context: PluginContext): Promise<void> {
    this.context = context;
    this.context.logger.info('Core Devices plugin initialized');
  }

  async start(): Promise<void> {
    this.context.logger.info('Core Devices plugin started');
  }

  async stop(): Promise<void> {
    this.context.logger.info('Core Devices plugin stopped');
  }

  /**
   * This plugin handles non-thermostat devices
   */
  shouldHandleDevice(device: UnifiedDevice): boolean {
    // For now, we'll handle devices that aren't thermostats
    // In the future, we can check specific capabilities
    const isThermostat = device.capabilities?.some(
      cap => cap.id === 'thermostatMode' || cap.id === 'thermostatHeatingSetpoint'
    );
    return !isThermostat;
  }

  /**
   * Basic state passthrough - no modification needed for simple devices
   */
  async beforeSetSmartThingsState(device: UnifiedDevice, state: any): Promise<any | null> {
    // Allow state change to pass through
    return state;
  }

  async beforeSetHomeKitState(device: UnifiedDevice, state: any): Promise<any | null> {
    // Allow state change to pass through
    return state;
  }

  async afterDeviceUpdate(device: UnifiedDevice, newState: any, oldState: any): Promise<void> {
    // Log device updates for debugging
    this.context.logger.debug(
      { deviceId: device.deviceId, deviceName: device.label, newState, oldState },
      'Device updated'
    );
  }
}

// Export the plugin instance
export default new CoreDevicesPlugin();
