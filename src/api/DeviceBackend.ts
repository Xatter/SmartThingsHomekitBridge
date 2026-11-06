import { DeviceState, SmartThingsDevice, UnifiedDevice } from '@/types';

/**
 * A single SmartThings-style capability command, as built by the Coordinator's
 * handleThermostatEvent, PluginContext.setSmartThingsState, and plugins.
 */
export interface CapabilityCommand {
  component: string;
  capability: string;
  command: string;
  arguments?: any[];
}

/**
 * Device-control backend used by the Coordinator, plugins, and web routes.
 *
 * Two implementations exist:
 *  - SmartThingsAPI   — the original SmartThings cloud backend
 *  - HomeAssistantAPI — local backend that drives the units through the PA
 *                       Home Assistant instance (no cloud, no API plan)
 *
 * Callers stay backend-agnostic. Capability commands are expressed in
 * SmartTerms (switch/airConditionerMode/thermostatCoolingSetpoint/execute...)
 * and each backend translates them to its own protocol. Device IDs remain the
 * historical SmartThings device IDs in both backends so that persisted state
 * (device_state.json, device_inclusion.json) and HomeKit accessory UUIDs stay
 * stable across backend switches.
 */
export interface DeviceBackend {
  /** True when the backend is fully configured and usable. */
  hasAuth(): boolean;

  /** All known devices (SmartThings-shaped metadata). */
  getAllDevices(): Promise<SmartThingsDevice[]>;

  /** Devices filtered to HVAC/thermostat-like ones. */
  getFilteredDevices(): Promise<SmartThingsDevice[]>;

  /** Current state of one device, or null when unavailable. */
  getDeviceStatus(deviceId: string): Promise<DeviceState | null>;

  /** Set a setpoint (°F for the PA units). */
  setTemperature(deviceId: string, temperature: number, mode: 'heat' | 'cool'): Promise<boolean>;

  /** Set operating mode (off routes to power-off for Samsung ACs). */
  setMode(deviceId: string, mode: 'heat' | 'cool' | 'auto' | 'off'): Promise<boolean>;

  /** Turn the unit's display light OFF (Samsung naming is inverted). */
  turnLightOff(deviceId: string): Promise<boolean>;

  /** Turn the unit's display light ON (Samsung naming is inverted). */
  turnLightOn(deviceId: string): Promise<boolean>;

  /** Set display light level. */
  setLightingLevel(
    deviceId: string,
    level: 'on' | 'dim' | 'bright' | 'off' | 'smart' | 'high' | 'low'
  ): Promise<boolean>;

  /** All devices with metadata + state for the paired ones. */
  getDevices(pairedDeviceIds?: string[]): Promise<UnifiedDevice[]>;

  /**
   * Execute a batch of SmartThings-style capability commands. Implementations
   * MUST translate each command to their own protocol and MUST preserve the
   * batch semantics: throw with a descriptive message on failure, noting any
   * commands that already succeeded (partial-failure state).
   */
  executeCommands(deviceId: string, commands: CapabilityCommand[]): Promise<void>;
}
