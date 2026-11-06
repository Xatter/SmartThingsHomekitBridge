import * as fs from 'fs';
import { DeviceState, SmartThingsDevice, ThermostatCapabilities, UnifiedDevice } from '@/types';
import { logger } from '@/utils/logger';
import { withRetry } from '@/utils/retry';
import { CapabilityCommand } from './DeviceBackend';

/**
 * How long (ms) to wait on any single Home Assistant request.
 */
const HA_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Entity mapping for one physical unit: the historical SmartThings device ID
 * (kept as the stable key for persisted state and HomeKit accessory UUIDs)
 * mapped to the Home Assistant entities that now drive it.
 */
export interface HAEntityMapping {
  /** HA climate entity that controls the unit. */
  entity_id: string;
  /** HA switch for the unit's display light (optional). */
  light_switch?: string;
  /** SmartThings-era device name — PRESERVED so HomeKit accessory naming is unchanged. */
  name: string;
  /** SmartThings-era label. */
  label: string;
}

export interface HomeAssistantAPIOptions {
  /** Base URL, e.g. http://192.168.2.2:8123 */
  url: string;
  /** Long-lived access token. */
  token: string;
  /** SmartThings deviceId -> HA entities. */
  entityMap: Record<string, HAEntityMapping>;
}

/**
 * Local device backend: drives the mini splits through the PA Home Assistant
 * instance (REST API) instead of the SmartThings cloud.
 *
 * The climate entities belong to the samsung_ac_local integration, which
 * speaks DTLS/CoAP to the units directly on the LAN. Native values are in the
 * unit's configured scale (°F for these units) — no conversion here.
 *
 * SmartThings capability commands are translated:
 *   switch on/off                              -> climate turn_on/turn_off
 *   airConditionerMode setAirConditionerMode   -> climate set_hvac_mode
 *   thermostatMode setThermostatMode           -> climate set_hvac_mode
 *   thermostatCoolingSetpoint setCoolingSetpoint
 *   thermostatHeatingSetpoint setHeatingSetpoint -> climate set_temperature
 *   execute ['mode/vs/0', {options: ['Light_On'|'Light_Off']}]
 *                                              -> display-light switch
 *      (Samsung's naming is inverted: Light_On turns the display OFF.)
 */
export class HomeAssistantAPI {
  private readonly options: HomeAssistantAPIOptions;

  constructor(options: HomeAssistantAPIOptions) {
    this.options = {
      ...options,
      url: options.url.replace(/\/+$/, ''),
    };
    logger.info(
      { url: this.options.url, units: Object.keys(this.options.entityMap).length },
      'Home Assistant backend initialized'
    );
  }

  /**
   * Builds the backend from environment variables. Returns null when any of
   * HA_URL / HA_TOKEN / HA_ENTITY_MAP (or HA_ENTITY_MAP_FILE) is missing.
   */
  static fromEnv(): HomeAssistantAPI | null {
    const url = process.env.HA_URL;
    const token = process.env.HA_TOKEN;
    if (!url || !token) {
      return null;
    }

    let entityMap: Record<string, HAEntityMapping> = {};
    if (process.env.HA_ENTITY_MAP) {
      entityMap = JSON.parse(process.env.HA_ENTITY_MAP);
    } else if (process.env.HA_ENTITY_MAP_FILE) {
      entityMap = JSON.parse(fs.readFileSync(process.env.HA_ENTITY_MAP_FILE, 'utf-8'));
    }
    if (!entityMap || Object.keys(entityMap).length === 0) {
      logger.warn('HA_ENTITY_MAP is empty - no devices to expose');
      return null;
    }

    return new HomeAssistantAPI({ url, token, entityMap });
  }

  hasAuth(): boolean {
    return Boolean(this.options.token && Object.keys(this.options.entityMap).length > 0);
  }

  /** Number of mapped units (for startup logging). */
  getUnitCount(): number {
    return Object.keys(this.options.entityMap).length;
  }

  private requireEntity(deviceId: string): HAEntityMapping {
    const mapping = this.options.entityMap[deviceId];
    if (!mapping) {
      throw new Error(`No HA entity mapping for device ${deviceId}`);
    }
    return mapping;
  }

  private async request<T = any>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.options.url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
      signal: AbortSignal.timeout(HA_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HA ${init?.method || 'GET'} ${path} -> ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  private async getService(path: string, data: Record<string, unknown>): Promise<void> {
    await withRetry(
      () => this.request(`/api/services/${path}`, { method: 'POST', body: JSON.stringify(data) }),
      { maxRetries: 3, operationName: `HA service ${path}` }
    );
  }

  /**
   * HA reports temperatures in the unit's configured display scale. A missing
   * or non-numeric reading surfaces as undefined rather than 0 (0°F is a real
   * temperature - same reasoning as SmartThingsAPI.parseOptionalNumber).
   */
  private parseOptionalNumber(value: unknown): number | undefined {
    if (value === null || value === undefined) {
      return undefined;
    }
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  /**
   * HA hvac_mode -> bridge mode. dry (and Samsung's wind) behave as cooling
   * for this bridge's purposes - mirrors SmartThingsAPI's mode collapsing.
   */
  private toBridgeMode(haMode: string): 'heat' | 'cool' | 'auto' | 'off' {
    if (haMode === 'off') return 'off';
    if (haMode === 'heat') return 'heat';
    if (haMode === 'auto') return 'auto';
    return 'cool';
  }

  /**
   * Bridge/SmartThings mode -> HA hvac_mode. 'off' is handled by callers as a
   * power-off (the integration has no 'off' hvac_mode).
   */
  private toHaHvacMode(mode: string): string {
    if (mode === 'wind') {
      logger.warn({ mode }, 'HA backend: wind mode requested; HA has no wind hvac_mode, using cool');
      return 'cool';
    }
    return mode;
  }

  /**
   * Fixed Samsung-AC capability shape: the bridge's command routing keys off
   * airConditionerMode-without-thermostatMode (Samsung path) and the
   * single-register thermostatCoolingSetpoint path - both must hold.
   */
  private samsungCapabilities(): Array<{ id: string; version: number }> {
    return [
      { id: 'switch', version: 1 },
      { id: 'airConditionerMode', version: 1 },
      { id: 'airConditionerFanMode', version: 1 },
      { id: 'temperatureMeasurement', version: 1 },
      { id: 'relativeHumidityMeasurement', version: 1 },
      { id: 'thermostatCoolingSetpoint', version: 1 },
      { id: 'samsungce.airConditionerLighting', version: 1 },
    ];
  }

  private extractThermostatCapabilities(): ThermostatCapabilities {
    const capabilityIds = this.samsungCapabilities().map((c) => c.id);
    return {
      temperatureMeasurement: capabilityIds.includes('temperatureMeasurement'),
      thermostat: false,
      thermostatCoolingSetpoint: capabilityIds.includes('thermostatCoolingSetpoint'),
      thermostatHeatingSetpoint: false,
      thermostatMode: false,
      thermostatOperatingState: false,
      switch: true,
      airConditionerMode: true,
      airConditionerFanMode: true,
      customThermostatSetpointControl: false,
    };
  }

  private buildDevice(deviceId: string, mapping: HAEntityMapping): SmartThingsDevice {
    const capabilities = this.samsungCapabilities();
    return {
      deviceId,
      name: mapping.name,
      label: mapping.label,
      manufacturerName: 'Samsung Electronics',
      presentationId: '',
      deviceTypeName: 'Samsung-Room-Air-Conditioner',
      capabilities,
      components: [{ id: 'main', capabilities }],
    };
  }

  async getAllDevices(): Promise<SmartThingsDevice[]> {
    return Object.entries(this.options.entityMap).map(([deviceId, mapping]) =>
      this.buildDevice(deviceId, mapping)
    );
  }

  async getFilteredDevices(): Promise<SmartThingsDevice[]> {
    // Every mapped device is a Samsung AC - nothing to filter out.
    return this.getAllDevices();
  }

  async getDeviceStatus(deviceId: string): Promise<DeviceState | null> {
    if (!this.hasAuth()) {
      return null;
    }

    try {
      const mapping = this.requireEntity(deviceId);

      const st = await withRetry(
        () => this.request<any>(`/api/states/${mapping.entity_id}`),
        { maxRetries: 2, operationName: `HA state ${mapping.entity_id}` }
      );
      const attrs = st?.attributes || {};

      // attrs.temperature is the TARGET setpoint; attrs.current_temperature
      // is the room reading. Mapping the wrong one makes every unit read its
      // own setpoint (caught live: all four units reported 72°F).
      const setpoint = this.parseOptionalNumber(attrs.temperature);
      const temperature = this.parseOptionalNumber(attrs.current_temperature);

      // hvac_mode 'off' means powered off; dry/wind collapse to cool (mirrors
      // SmartThingsAPI's mode handling for Samsung ACs).
      let mode = this.toBridgeMode(st?.state || 'off');
      const switchState: 'on' | 'off' = st?.state === 'off' ? 'off' : 'on';

      // Display-light state is best-effort: the integration's switch reports
      // 'unknown' until it has been toggled at least once.
      let lightOn = false;
      if (mapping.light_switch) {
        const ls = await this.request<any>(`/api/states/${mapping.light_switch}`).catch(() => null);
        lightOn = ls?.state === 'on';
      }

      return {
        id: deviceId,
        name: mapping.name,
        temperatureSetpoint: setpoint,
        currentTemperature: temperature,
        mode,
        lightOn,
        lastUpdated: new Date(),
        heatingSetpoint: undefined,
        coolingSetpoint: setpoint,
        switchState,
        humidity: this.parseOptionalNumber(attrs.current_humidity),
      };
    } catch (error) {
      logger.error({ deviceId, err: error }, 'Error getting device status from Home Assistant');
      return null;
    }
  }

  async setTemperature(deviceId: string, temperature: number, _mode: 'heat' | 'cool'): Promise<boolean> {
    try {
      const mapping = this.requireEntity(deviceId);
      // Single-register unit: one setpoint regardless of mode.
      await this.getService('climate/set_temperature', {
        entity_id: mapping.entity_id,
        temperature,
      });
      await this.displayLightOffBestEffort(mapping);
      return true;
    } catch (error) {
      logger.error({ deviceId, err: error }, 'Error setting temperature via Home Assistant');
      return false;
    }
  }

  async setMode(deviceId: string, mode: 'heat' | 'cool' | 'auto' | 'off'): Promise<boolean> {
    try {
      const mapping = this.requireEntity(deviceId);
      if (mode === 'off') {
        await this.getService('climate/turn_off', { entity_id: mapping.entity_id });
      } else {
        await this.getService('climate/turn_on', { entity_id: mapping.entity_id });
        await this.getService('climate/set_hvac_mode', {
          entity_id: mapping.entity_id,
          hvac_mode: this.toHaHvacMode(mode),
        });
      }
      await this.displayLightOffBestEffort(mapping);
      return true;
    } catch (error) {
      logger.error({ deviceId, mode, err: error }, 'Error setting mode via Home Assistant');
      return false;
    }
  }

  async turnLightOff(deviceId: string): Promise<boolean> {
    try {
      const mapping = this.requireEntity(deviceId);
      if (!mapping.light_switch) return false;
      await this.getService('switch/turn_off', { entity_id: mapping.light_switch });
      return true;
    } catch (error) {
      logger.error({ deviceId, err: error }, 'Error turning display light off');
      return false;
    }
  }

  async turnLightOn(deviceId: string): Promise<boolean> {
    try {
      const mapping = this.requireEntity(deviceId);
      if (!mapping.light_switch) return false;
      await this.getService('switch/turn_on', { entity_id: mapping.light_switch });
      return true;
    } catch (error) {
      logger.error({ deviceId, err: error }, 'Error turning display light on');
      return false;
    }
  }

  async setLightingLevel(
    deviceId: string,
    level: 'on' | 'dim' | 'bright' | 'off' | 'smart' | 'high' | 'low'
  ): Promise<boolean> {
    // The integration exposes the display light as a plain switch; only
    // on/off are representable.
    if (level === 'off') {
      return this.turnLightOff(deviceId);
    }
    return this.turnLightOn(deviceId);
  }

  async getDevices(pairedDeviceIds: string[] = []): Promise<UnifiedDevice[]> {
    const allDevices = await this.getAllDevices();
    const thermostatCapabilities = this.extractThermostatCapabilities();

    const devices = await Promise.all(
      allDevices.map(async (device) => {
        const isPaired = pairedDeviceIds.includes(device.deviceId);

        let currentState: DeviceState | undefined;
        if (isPaired) {
          try {
            currentState = (await this.getDeviceStatus(device.deviceId)) || undefined;
          } catch (error) {
            logger.error({ deviceId: device.deviceId, err: error }, 'Error getting state for device');
          }
        }

        return {
          ...device,
          thermostatCapabilities,
          currentState,
          isPaired,
        } as UnifiedDevice;
      })
    );

    return devices;
  }

  async executeCommands(deviceId: string, commands: CapabilityCommand[]): Promise<void> {
    const mapping = this.requireEntity(deviceId);

    const describeCommand = (cmd: CapabilityCommand): string =>
      `${cmd.component}/${cmd.capability}/${cmd.command}`;

    const succeeded: string[] = [];

    for (const cmd of commands) {
      const description = describeCommand(cmd);
      try {
        await withRetry(
          () => this.translateAndExecute(mapping, cmd),
          { maxRetries: 3, initialDelayMs: 1000, operationName: `HA command ${description}` }
        );
        succeeded.push(description);
        logger.debug({ deviceId, command: cmd }, 'Executed command via Home Assistant');
      } catch (error) {
        const message = succeeded.length > 0
          ? `Command batch partially failed for device ${deviceId}: succeeded=[${succeeded.join(', ')}], failed=${description}. Device may be left in an inconsistent state.`
          : `Command batch failed for device ${deviceId}: failed=${description} (no prior commands in this batch succeeded).`;
        logger.error({ err: error, deviceId, commands, succeeded, failed: description }, 'Error executing commands');
        throw new Error(message, { cause: error });
      }
    }
  }

  /**
   * Translates one SmartThings-style capability command into HA service
   * calls. Unknown capabilities are logged and skipped (not errors) so new
   * SmartThings capability types degrade gracefully.
   */
  private async translateAndExecute(
    mapping: HAEntityMapping,
    cmd: CapabilityCommand
  ): Promise<void> {
    switch (cmd.capability) {
      case 'switch': {
        if (cmd.command === 'on' || cmd.command === 'off') {
          const service = cmd.command === 'on' ? 'climate/turn_on' : 'climate/turn_off';
          await this.request(`/api/services/${service}`, {
            method: 'POST',
            body: JSON.stringify({ entity_id: mapping.entity_id }),
          });
          return;
        }
        break;
      }
      case 'airConditionerMode':
      case 'thermostatMode': {
        if (
          cmd.command === 'setAirConditionerMode' ||
          cmd.command === 'setThermostatMode'
        ) {
          const mode = String(cmd.arguments?.[0] ?? '');
          if (mode === 'off') {
            await this.request('/api/services/climate/turn_off', {
              method: 'POST',
              body: JSON.stringify({ entity_id: mapping.entity_id }),
            });
            return;
          }
          await this.request('/api/services/climate/set_hvac_mode', {
            method: 'POST',
            body: JSON.stringify({
              entity_id: mapping.entity_id,
              hvac_mode: this.toHaHvacMode(mode),
            }),
          });
          return;
        }
        break;
      }
      case 'thermostatCoolingSetpoint':
      case 'thermostatHeatingSetpoint': {
        if (cmd.command === 'setCoolingSetpoint' || cmd.command === 'setHeatingSetpoint') {
          const temperature = Number(cmd.arguments?.[0]);
          await this.request('/api/services/climate/set_temperature', {
            method: 'POST',
            body: JSON.stringify({ entity_id: mapping.entity_id, temperature }),
          });
          return;
        }
        break;
      }
      case 'execute': {
        // Samsung display-light commands ride the generic execute capability:
        //   ['mode/vs/0', {'x.com.samsung.da.options': ['Light_On'|'Light_Off']}]
        // Samsung's naming is inverted: Light_On turns the display OFF.
        const args = cmd.arguments || [];
        const options = args?.[1]?.['x.com.samsung.da.options'];
        if (Array.isArray(options) && mapping.light_switch) {
          if (options.includes('Light_On')) {
            await this.request('/api/services/switch/turn_off', {
              method: 'POST',
              body: JSON.stringify({ entity_id: mapping.light_switch }),
            });
            return;
          }
          if (options.includes('Light_Off')) {
            await this.request('/api/services/switch/turn_on', {
              method: 'POST',
              body: JSON.stringify({ entity_id: mapping.light_switch }),
            });
            return;
          }
        }
        break;
      }
    }

    logger.warn(
      { capability: cmd.capability, command: cmd.command },
      'HA backend: unsupported capability command, ignoring'
    );
  }

  private async displayLightOffBestEffort(mapping: HAEntityMapping): Promise<void> {
    if (!mapping.light_switch) return;
    try {
      await this.getService('switch/turn_off', { entity_id: mapping.light_switch });
    } catch (error) {
      // Best-effort, exactly like SmartThingsAPI.turnOffLightSilently.
      logger.debug({ err: error, light_switch: mapping.light_switch }, 'Display light off (best effort) failed');
    }
  }
}
