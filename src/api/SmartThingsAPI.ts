import { SmartThingsClient, BearerTokenAuthenticator } from '@smartthings/core-sdk';
import { SmartThingsAuthentication } from '@/auth/SmartThingsAuthentication';
import { SmartThingsDevice, DeviceState, ThermostatCapabilities, UnifiedDevice } from '@/types';
import { logger } from '@/utils/logger';
import { withRetry } from '@/utils/retry';

/**
 * Maximum time (ms) we'll wait on any single SmartThings API call before treating it
 * as failed. The @smartthings/core-sdk (axios-based) has no built-in request timeout
 * option, so we enforce one ourselves via `withTimeout` around every `client.devices.*`
 * call. Without this, a hung network request would leave `withRetry` (and its callers)
 * waiting forever.
 */
const SMARTTHINGS_REQUEST_TIMEOUT_MS = 15000;

/**
 * API client for interacting with SmartThings devices.
 * Handles authentication, device discovery, and device control.
 */
export class SmartThingsAPI {
  private client: SmartThingsClient | null = null;
  private currentToken: string | null = null;
  private readonly auth: SmartThingsAuthentication;

  /**
   * Creates a new SmartThings API client.
   * @param auth - Authentication manager for OAuth tokens
   */
  constructor(auth: SmartThingsAuthentication) {
    this.auth = auth;
  }

  /**
   * Checks if the API has valid authentication.
   * @returns true if authenticated, false otherwise
   */
  hasAuth(): boolean {
    return this.auth.hasAuth();
  }

  private async getClient(): Promise<SmartThingsClient | null> {
    if (!await this.auth.ensureValidToken()) {
      return null;
    }

    const token = this.auth.getAccessToken();
    if (!token) {
      return null;
    }

    // Invalidate cached client if token has changed
    if (this.currentToken && this.currentToken !== token) {
      logger.info('Access token changed, invalidating client cache');
      this.invalidateClient();
    }

    if (!this.client) {
      logger.debug('Creating new SmartThings API client');
      this.client = new SmartThingsClient(new BearerTokenAuthenticator(token));
      this.currentToken = token;
    }

    return this.client;
  }

  /**
   * Races a SmartThings request against a timeout so a hung/never-resolving request
   * (the SDK has no built-in timeout) can't block callers forever.
   * @param promise - The in-flight SmartThings SDK call
   * @param ms - Timeout in milliseconds
   * @param label - Description used in the timeout error message/logs
   */
  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`${label} timed out after ${ms}ms`) as Error & { code?: string };
        error.code = 'ETIMEDOUT';
        reject(error);
      }, ms);
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Parses a raw SmartThings capability value (e.g.
   * `status.components?.main?.temperatureMeasurement?.temperature?.value`) into a number,
   * returning `undefined` when the reading is missing/broken (null, undefined, or non-numeric)
   * rather than silently coercing it to 0. A genuine numeric 0 (a real, valid temperature) is
   * preserved as 0 - this is NOT the same as `Number(...) || 0`, which conflates "no reading"
   * with "reads exactly zero".
   */
  private parseOptionalNumber(value: unknown): number | undefined {
    if (value === null || value === undefined) {
      return undefined;
    }
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  /**
   * Extracts capability IDs from a raw SmartThings device object (as returned by
   * client.devices.get), checking top-level capabilities first and falling back
   * to component-level capabilities.
   */
  private getCapabilityIds(device: any): string[] {
    let capabilityIds: string[] = (device?.capabilities || []).map((cap: any) => cap.id);

    if (capabilityIds.length === 0 && device?.components) {
      capabilityIds = device.components.reduce((allCaps: string[], component: any) => {
        const componentCaps = component.capabilities?.map((cap: any) => cap.id) || [];
        return allCaps.concat(componentCaps);
      }, []);
    }

    return capabilityIds;
  }

  /**
   * Retrieves all devices from SmartThings account with detailed information.
   * Fetches capabilities from both top-level and component-level.
   * @returns Array of all SmartThings devices
   * @throws {Error} If not authenticated
   */
  async getAllDevices(): Promise<SmartThingsDevice[]> {
    const client = await this.getClient();
    if (!client) {
      throw new Error('No authenticated SmartThings client available');
    }

    try {
      logger.info('📡 Fetching device list from SmartThings...');
      const deviceList = await withRetry(
        () => this.withTimeout(client.devices.list(), SMARTTHINGS_REQUEST_TIMEOUT_MS, 'list devices'),
        { maxRetries: 3, operationName: 'list devices' }
      );
      logger.info({ count: deviceList.length }, '📱 Found devices, fetching detailed info...');

      // Fetch detailed information for each device
      const devicePromises = deviceList.map(async (deviceSummary: any) => {
        try {
          logger.debug({ deviceId: deviceSummary.deviceId, name: deviceSummary.name }, '🔍 Fetching details for device');
          const deviceDetails = await withRetry(
            () => this.withTimeout(client.devices.get(deviceSummary.deviceId), SMARTTHINGS_REQUEST_TIMEOUT_MS, 'get device details'),
            { maxRetries: 2, operationName: 'get device details' }
          );
          logger.debug({
            deviceId: deviceSummary.deviceId,
            capabilities: (deviceDetails as any).capabilities?.length || 0,
            components: (deviceDetails as any).components?.length || 0
          }, '🔍 Device details fetched');
          // Extract capabilities from components if top-level capabilities are empty
          let capabilities = (deviceDetails as any).capabilities || [];
          if (capabilities.length === 0 && (deviceDetails as any).components) {
            // Flatten all capabilities from all components
            capabilities = (deviceDetails as any).components.reduce((allCaps: any[], component: any) => {
              const componentCaps = component.capabilities || [];
              return allCaps.concat(componentCaps);
            }, []);
          }

          return {
            deviceId: deviceDetails.deviceId!,
            name: deviceDetails.name!,
            label: deviceDetails.label!,
            manufacturerName: deviceDetails.manufacturerName || '',
            presentationId: deviceDetails.presentationId || '',
            deviceTypeName: (deviceDetails as any).deviceTypeName || '',
            capabilities: capabilities,
            components: (deviceDetails as any).components || [],
          };
        } catch (error) {
          logger.error({ deviceId: deviceSummary.deviceId, err: error }, '❌ Error fetching details for device');
          // Return basic info if detailed fetch fails
          return {
            deviceId: deviceSummary.deviceId!,
            name: deviceSummary.name!,
            label: deviceSummary.label!,
            manufacturerName: deviceSummary.manufacturerName || '',
            presentationId: deviceSummary.presentationId || '',
            deviceTypeName: deviceSummary.deviceTypeName || '',
            capabilities: deviceSummary.capabilities || [],
            components: deviceSummary.components || [],
          };
        }
      });

      const devices = await Promise.all(devicePromises);
      logger.debug('✅ Finished fetching detailed device information');
      return devices;
    } catch (error) {
      logger.error({ err: error }, '❌ Error fetching devices');
      throw error;
    }
  }

  async getFilteredDevices(): Promise<SmartThingsDevice[]> {
    const allDevices = await this.getAllDevices();

    logger.debug('🔍 Analyzing all devices for HVAC capabilities:');
    allDevices.forEach(device => {
      const capabilities = this.extractThermostatCapabilities(device);
      const capabilityList = device.capabilities.map(cap => cap.id).join(', ');
      logger.debug({
        name: device.name,
        deviceId: device.deviceId,
        capabilities: capabilityList,
        hvacAnalysis: capabilities
      }, '📱 Device analysis');

      const hasStandardThermostat = capabilities.temperatureMeasurement ||
                                    capabilities.thermostat ||
                                    capabilities.thermostatCoolingSetpoint ||
                                    capabilities.thermostatHeatingSetpoint;

      const hasSamsungAC = capabilities.airConditionerMode ||
                           capabilities.customThermostatSetpointControl;

      logger.debug({
        hasStandardThermostat,
        hasSamsungAC,
        isHVAC: hasStandardThermostat || hasSamsungAC
      }, '   Device type analysis');
    });

    return allDevices.filter(device => {
      // Exclude ecobee devices
      if (device.name.toLowerCase().includes('ecobee')) return false;

      const capabilities = this.extractThermostatCapabilities(device);
      // Standard thermostat capabilities
      const hasStandardThermostat = capabilities.temperatureMeasurement ||
                                    capabilities.thermostat ||
                                    capabilities.thermostatCoolingSetpoint ||
                                    capabilities.thermostatHeatingSetpoint;

      // Samsung air conditioner capabilities
      const hasSamsungAC = capabilities.airConditionerMode ||
                           capabilities.customThermostatSetpointControl;

      return hasStandardThermostat || hasSamsungAC;
    });
  }

  private extractThermostatCapabilities(device: SmartThingsDevice): ThermostatCapabilities {
    // Collect capabilities from both top-level and components
    let allCapabilities = device.capabilities.map(cap => cap.id);

    // If top-level capabilities are empty, collect from components
    if (allCapabilities.length === 0 && device.components) {
      allCapabilities = device.components.reduce((allCaps: string[], component: any) => {
        const componentCaps = component.capabilities?.map((cap: any) => cap.id) || [];
        return allCaps.concat(componentCaps);
      }, []);
    }

    return {
      temperatureMeasurement: allCapabilities.includes('temperatureMeasurement'),
      thermostat: allCapabilities.includes('thermostat'),
      thermostatCoolingSetpoint: allCapabilities.includes('thermostatCoolingSetpoint'),
      thermostatHeatingSetpoint: allCapabilities.includes('thermostatHeatingSetpoint'),
      thermostatMode: allCapabilities.includes('thermostatMode'),
      thermostatOperatingState: allCapabilities.includes('thermostatOperatingState'),
      switch: allCapabilities.includes('switch'),
      // Samsung air conditioner specific capabilities
      airConditionerMode: allCapabilities.includes('airConditionerMode'),
      airConditionerFanMode: allCapabilities.includes('airConditionerFanMode'),
      customThermostatSetpointControl: allCapabilities.includes('custom.thermostatSetpointControl'),
    };
  }

  /**
   * Gets current state of a specific device.
   * Handles both standard thermostats and Samsung air conditioners.
   * @param deviceId - Device to query
   * @returns Device state or null if error/not authenticated
   */
  async getDeviceStatus(deviceId: string): Promise<DeviceState | null> {
    const client = await this.getClient();
    if (!client) {
      return null;
    }

    try {
      const status = await withRetry(
        () => this.withTimeout(client.devices.getStatus(deviceId), SMARTTHINGS_REQUEST_TIMEOUT_MS, 'get device status'),
        { maxRetries: 2, operationName: 'get device status' }
      );
      const device = await withRetry(
        () => this.withTimeout(client.devices.get(deviceId), SMARTTHINGS_REQUEST_TIMEOUT_MS, 'get device info'),
        { maxRetries: 2, operationName: 'get device info' }
      );

      // Get temperature measurement. Missing/broken readings surface as `undefined`, not 0 -
      // 0°F is a real, valid temperature and must not be confused with "no sensor reading".
      const temperature = this.parseOptionalNumber(status.components?.main?.temperatureMeasurement?.temperature?.value);

      // Try standard thermostat setpoints first
      const coolingSetpoint = this.parseOptionalNumber(status.components?.main?.thermostatCoolingSetpoint?.coolingSetpoint?.value);
      const heatingSetpoint = this.parseOptionalNumber(status.components?.main?.thermostatHeatingSetpoint?.heatingSetpoint?.value);

      // Get mode - try thermostat mode first, then air conditioner mode
      let mode = status.components?.main?.thermostatMode?.thermostatMode?.value ||
                 status.components?.main?.airConditionerMode?.airConditionerMode?.value || 'off';

      // For Samsung air conditioners, convert modes
      if (mode === 'wind') mode = 'cool'; // Samsung uses 'wind' for fan mode, treat as cool
      if (mode === 'dry') mode = 'cool';  // Samsung dry mode, treat as cool

      const switchStatus = status.components?.main?.switch?.switch?.value || 'off';

      // Get the actual display light status from the Samsung-specific capability
      const lightingStatus = status.components?.main?.['samsungce.airConditionerLighting']?.lighting?.value || 'off';

      // For Samsung ACs: whenever switch is off, we report mode as 'off', regardless of what
      // airConditionerMode currently holds. This includes the brief window mid-transition where
      // a mode-set command has already landed (airConditionerMode updated) but the switch status
      // hasn't caught up yet - we intentionally do NOT trust airConditionerMode in that case.
      if (switchStatus === 'off' && status.components?.main?.airConditionerMode) {
        mode = 'off';
      }

      // If no standard setpoints, use the cooling setpoint (Samsung units primarily use cooling).
      // Use `??` (not `||`) so a genuine heatingSetpoint of 0°F isn't treated as missing - only
      // fall back to coolingSetpoint when heatingSetpoint is actually undefined. If the chosen
      // setpoint is itself missing, temperatureSetpoint correctly comes out undefined.
      const temperatureSetpoint = mode === 'cool' ? coolingSetpoint : (heatingSetpoint ?? coolingSetpoint);

      return {
        id: deviceId,
        name: device.name || device.label || deviceId,
        temperatureSetpoint,
        currentTemperature: temperature,
        mode: mode as 'heat' | 'cool' | 'auto' | 'off',
        lightOn: lightingStatus === 'on',
        lastUpdated: new Date(),
        // Include separate setpoints for auto-mode coordination. heatingSetpoint/coolingSetpoint
        // are already `number | undefined` from parseOptionalNumber above - no `|| undefined`
        // here, since that would incorrectly wipe out a genuine 0°F setpoint.
        heatingSetpoint,
        coolingSetpoint,
        // Samsung AC switch state for on/off control
        switchState: switchStatus as 'on' | 'off',
      };
    } catch (error) {
      logger.error({ deviceId, err: error }, 'Error getting device status');
      return null;
    }
  }

  private async turnOffLightSilently(client: any, deviceId: string): Promise<void> {
    try {
      // Note: "Light_On" actually turns the display OFF (counterintuitive naming from Samsung)
      const command = {
        component: 'main',
        capability: 'execute',
        command: 'execute',
        arguments: [
          'mode/vs/0',
          {
            'x.com.samsung.da.options': ['Light_On']
          }
        ],
      };
      logger.debug(`[turnOffLightSilently] Sending command to ${deviceId}: ${JSON.stringify(command, null, 2)}`);

      const response = await withRetry(
        () => this.withTimeout(client.devices.executeCommand(deviceId, command), SMARTTHINGS_REQUEST_TIMEOUT_MS, 'turn off light'),
        { maxRetries: 2, operationName: 'turn off light' }
      );
      logger.debug(`[turnOffLightSilently] Response from ${deviceId}: ${JSON.stringify(response, null, 2)}`);
    } catch (error: any) {
      // Log error but don't fail - not all devices may support this capability
      logger.debug({ deviceId, err: error.message || error }, '[turnOffLightSilently] Error');
      if (error.response) {
        logger.debug(`[turnOffLightSilently] Error response details: ${JSON.stringify(error.response, null, 2)}`);
      }
    }
  }

  /**
   * Sets temperature setpoint for a device.
   * Automatically turns off AC display light after setting temperature.
   * @param deviceId - Device to control
   * @param temperature - Target temperature in Fahrenheit
   * @param mode - Heating or cooling mode
   * @returns true if successful, false otherwise
   */
  async setTemperature(deviceId: string, temperature: number, mode: 'heat' | 'cool'): Promise<boolean> {
    const client = await this.getClient();
    if (!client) {
      return false;
    }

    try {
      const capability = mode === 'cool' ? 'thermostatCoolingSetpoint' : 'thermostatHeatingSetpoint';
      const command = mode === 'cool' ? 'setCoolingSetpoint' : 'setHeatingSetpoint';

      await withRetry(
        () => this.withTimeout(client.devices.executeCommand(deviceId, {
          component: 'main',
          capability,
          command,
          arguments: [temperature],
        }), SMARTTHINGS_REQUEST_TIMEOUT_MS, 'set temperature'),
        { maxRetries: 3, operationName: 'set temperature' }
      );

      logger.debug(`Set ${mode} setpoint to ${temperature}°F for device ${deviceId}`);

      // Always turn off the light after any command
      await this.turnOffLightSilently(client, deviceId);

      return true;
    } catch (error) {
      logger.error({ deviceId, err: error }, 'Error setting temperature for device');
      return false;
    }
  }

  /**
   * Sets operating mode for a device.
   * Determines whether the device is a standard thermostat or a Samsung air
   * conditioner UP FRONT by inspecting its capabilities (mirrors the isSamsungAC
   * logic in PluginContext.setSmartThingsState), rather than trying the standard
   * thermostatMode command and falling back to the Samsung AC path on ANY failure.
   * That try/fallback pattern was a bug: a transient network error against a
   * traditional thermostat would fall into the Samsung path and send switch
   * on/setAirConditionerMode commands, powering the device on as a side effect
   * of an unrelated network blip.
   * For Samsung AC off mode, uses switch capability.
   * @param deviceId - Device to control
   * @param mode - Target operating mode
   * @returns true if successful, false otherwise
   */
  async setMode(deviceId: string, mode: 'heat' | 'cool' | 'auto' | 'off'): Promise<boolean> {
    const client = await this.getClient();
    if (!client) {
      return false;
    }

    try {
      // Decide the path by capability, not by trial-and-error.
      const device = await withRetry(
        () => this.withTimeout(client.devices.get(deviceId), SMARTTHINGS_REQUEST_TIMEOUT_MS, 'get device for mode capability check'),
        { maxRetries: 2, operationName: 'get device for setMode capability check' }
      );
      const capabilityIds = this.getCapabilityIds(device);
      const isSamsungAC = capabilityIds.includes('airConditionerMode') && !capabilityIds.includes('thermostatMode');

      if (!isSamsungAC) {
        // Standard thermostat - use thermostatMode capability
        await withRetry(
          () => this.withTimeout(client.devices.executeCommand(deviceId, {
            component: 'main',
            capability: 'thermostatMode',
            command: 'setThermostatMode',
            arguments: [mode],
          }), SMARTTHINGS_REQUEST_TIMEOUT_MS, 'set thermostat mode'),
          { maxRetries: 3, operationName: 'set thermostat mode' }
        );
        logger.debug(`Set thermostat mode to ${mode} for device ${deviceId}`);

        // Always turn off the light after any command
        await this.turnOffLightSilently(client, deviceId);

        return true;
      }

      // Samsung air conditioner path
      // Handle Samsung AC "off" mode specially - use switch capability
      if (mode === 'off') {
        await withRetry(
          () => this.withTimeout(client.devices.executeCommand(deviceId, {
            component: 'main',
            capability: 'switch',
            command: 'off',
            arguments: [],
          }), SMARTTHINGS_REQUEST_TIMEOUT_MS, 'turn off AC'),
          { maxRetries: 3, operationName: 'turn off AC' }
        );
        logger.debug(`Turned Samsung AC off using switch capability for device ${deviceId}`);

        // Always turn off the light after any command
        await this.turnOffLightSilently(client, deviceId);

        return true;
      } else {
        // For heat/cool/auto modes, use airConditionerMode
        // First turn the device on if it's not already on
        logger.debug(`Turning on Samsung AC switch for device ${deviceId} before setting mode to ${mode}`);
        await withRetry(
          () => this.withTimeout(client.devices.executeCommand(deviceId, {
            component: 'main',
            capability: 'switch',
            command: 'on',
            arguments: [],
          }), SMARTTHINGS_REQUEST_TIMEOUT_MS, 'turn on AC'),
          { maxRetries: 3, operationName: 'turn on AC' }
        );
        logger.debug(`Samsung AC switch turned on for device ${deviceId}`);

        // Small delay to ensure switch command is processed
        await new Promise(resolve => setTimeout(resolve, 1000));

        logger.debug(`Setting Samsung AC mode to ${mode} for device ${deviceId}`);
        await withRetry(
          () => this.withTimeout(client.devices.executeCommand(deviceId, {
            component: 'main',
            capability: 'airConditionerMode',
            command: 'setAirConditionerMode',
            arguments: [mode],
          }), SMARTTHINGS_REQUEST_TIMEOUT_MS, 'set AC mode'),
          { maxRetries: 3, operationName: 'set AC mode' }
        );
        logger.debug(`Set Samsung AC mode to ${mode} for device ${deviceId}`);

        // Always turn off the light after any command
        await this.turnOffLightSilently(client, deviceId);

        return true;
      }
    } catch (error) {
      logger.error({ deviceId, err: error }, 'Error setting mode for device');
      return false;
    }
  }

  /**
   * Turns off AC display light.
   * NOTE: Samsung's API naming is counterintuitive - uses 'Light_On' command to turn display OFF.
   * @param deviceId - Device to control
   * @returns true if successful, false otherwise
   */
  async turnLightOff(deviceId: string): Promise<boolean> {
    const client = await this.getClient();
    if (!client) {
      return false;
    }

    try {
      // 🚨 DO NOT "FIX" THIS - IT IS CORRECT! 🚨
      // Samsung's API naming is BACKWARDS:
      // "Light_On" = turns display OFF (yes, really!)
      // See tests in SmartThingsAPI.test.ts for full explanation
      // Confirmed at: https://community.smartthings.com/t/rest-api-for-display-light-on-samsung-windfree-ac/195928
      const command = {
        component: 'main',
        capability: 'execute',
        command: 'execute',
        arguments: [
          'mode/vs/0',
          {
            'x.com.samsung.da.options': ['Light_On']
          }
        ],
      };
      logger.debug(`[turnLightOff] Sending command to ${deviceId}: ${JSON.stringify(command, null, 2)}`);

      const response = await withRetry(
        () => this.withTimeout(client.devices.executeCommand(deviceId, command), SMARTTHINGS_REQUEST_TIMEOUT_MS, 'turn display light off'),
        { maxRetries: 2, operationName: 'turn display light off' }
      );
      logger.debug(`[turnLightOff] Response from ${deviceId}: ${JSON.stringify(response, null, 2)}`);
      logger.debug(`[turnLightOff] Successfully turned off light for device ${deviceId}`);
      return true;
    } catch (error: any) {
      logger.error({ deviceId, err: error.message || error }, '[turnLightOff] Error turning off light');
      if (error.response) {
        logger.error(`[turnLightOff] Error response details: ${JSON.stringify(error.response, null, 2)}`);
      }
      if (error.statusCode) {
        logger.error({ statusCode: error.statusCode }, '[turnLightOff] Status code');
      }
      return false;
    }
  }

  /**
   * Turns on AC display light.
   * NOTE: Samsung's API naming is counterintuitive - uses 'Light_Off' command to turn display ON.
   * @param deviceId - Device to control
   * @returns true if successful, false otherwise
   */
  async turnLightOn(deviceId: string): Promise<boolean> {
    const client = await this.getClient();
    if (!client) {
      return false;
    }

    try {
      // 🚨 DO NOT "FIX" THIS - IT IS CORRECT! 🚨
      // Samsung's API naming is BACKWARDS:
      // "Light_Off" = turns display ON (yes, really!)
      // See tests in SmartThingsAPI.test.ts for full explanation
      // Confirmed at: https://community.smartthings.com/t/rest-api-for-display-light-on-samsung-windfree-ac/195928
      const command = {
        component: 'main',
        capability: 'execute',
        command: 'execute',
        arguments: [
          'mode/vs/0',
          {
            'x.com.samsung.da.options': ['Light_Off']
          }
        ],
      };
      logger.debug(`[turnLightOn] Sending command to ${deviceId}: ${JSON.stringify(command, null, 2)}`);

      const response = await withRetry(
        () => this.withTimeout(client.devices.executeCommand(deviceId, command), SMARTTHINGS_REQUEST_TIMEOUT_MS, 'turn display light on'),
        { maxRetries: 2, operationName: 'turn display light on' }
      );
      logger.debug(`[turnLightOn] Response from ${deviceId}: ${JSON.stringify(response, null, 2)}`);
      logger.debug(`[turnLightOn] Successfully turned on light for device ${deviceId}`);
      return true;
    } catch (error: any) {
      logger.error({ deviceId, err: error.message || error }, '[turnLightOn] Error turning on light');
      if (error.response) {
        logger.error(`[turnLightOn] Error response details: ${JSON.stringify(error.response, null, 2)}`);
      }
      if (error.statusCode) {
        logger.error({ statusCode: error.statusCode }, '[turnLightOn] Status code');
      }
      return false;
    }
  }

  async setLightingLevel(deviceId: string, level: 'on' | 'dim' | 'bright' | 'off' | 'smart' | 'high' | 'low'): Promise<boolean> {
    const client = await this.getClient();
    if (!client) {
      return false;
    }

    try {
      // Map levels to Samsung's counterintuitive naming:
      // "Light_On" = display OFF, "Light_Off" = display ON
      const lightCommand = (level === 'off') ? 'Light_On' : 'Light_Off';

      const command = {
        component: 'main',
        capability: 'execute',
        command: 'execute',
        arguments: [
          'mode/vs/0',
          {
            'x.com.samsung.da.options': [lightCommand]
          }
        ],
      };
      logger.debug(`[setLightingLevel] Sending command to ${deviceId}: ${JSON.stringify(command, null, 2)}`);

      const response = await withRetry(
        () => this.withTimeout(client.devices.executeCommand(deviceId, command), SMARTTHINGS_REQUEST_TIMEOUT_MS, 'set lighting level'),
        { maxRetries: 2, operationName: 'set lighting level' }
      );
      logger.debug(`[setLightingLevel] Response from ${deviceId}: ${JSON.stringify(response, null, 2)}`);
      logger.debug({ deviceId, level }, '[setLightingLevel] Successfully set lighting level');
      return true;
    } catch (error: any) {
      logger.error({ deviceId, level, err: error.message || error }, '[setLightingLevel] Error setting lighting level');
      if (error.response) {
        logger.error(`[setLightingLevel] Error response details: ${JSON.stringify(error.response, null, 2)}`);
      }
      if (error.statusCode) {
        logger.error({ statusCode: error.statusCode }, '[setLightingLevel] Status code');
      }
      return false;
    }
  }

  /**
   * Invalidates the cached client, forcing a new one to be created on next request.
   * Useful after token refresh or auth changes.
   */
  invalidateClient(): void {
    logger.debug('Invalidating SmartThings API client cache');
    this.client = null;
    this.currentToken = null;
  }

  /**
   * Retrieves all devices from SmartThings.
   * Includes current state for paired devices and analyzes thermostat capabilities.
   * @param pairedDeviceIds - List of already paired device IDs to fetch state for
   * @returns Array of all unified devices
   */
  async getDevices(pairedDeviceIds: string[] = []): Promise<UnifiedDevice[]> {
    const allDevices = await this.getAllDevices();

    const devicePromises = allDevices.map(async (device) => {
      const thermostatCapabilities = this.extractThermostatCapabilities(device);
      const isPaired = pairedDeviceIds.includes(device.deviceId);

      let currentState: DeviceState | undefined;
      if (isPaired) {
        try {
          currentState = await this.getDeviceStatus(device.deviceId) || undefined;
        } catch (error) {
          logger.error({ deviceId: device.deviceId, err: error }, 'Error getting state for device');
        }
      }

      const unifiedDevice: UnifiedDevice = {
        deviceId: device.deviceId,
        name: device.name,
        label: device.label,
        manufacturerName: device.manufacturerName,
        presentationId: device.presentationId,
        deviceTypeName: device.deviceTypeName,
        capabilities: device.capabilities,
        components: device.components,
        thermostatCapabilities,
        currentState,
        isPaired,
      };

      return unifiedDevice;
    });

    const devices = await Promise.all(devicePromises);

    // Return ALL devices (no filtering)
    // The thermostatCapabilities are included so the UI can determine which controls to show
    return devices;
  }

  /**
   * Execute multiple commands on a device.
   * Generic method for plugins to execute arbitrary commands.
   *
   * @param deviceId - Device to control
   * @param commands - Array of commands to execute
   * @returns Promise that resolves when commands are executed
   */
  async executeCommands(deviceId: string, commands: Array<{
    component: string;
    capability: string;
    command: string;
    arguments?: any[];
  }>): Promise<void> {
    const client = await this.getClient();
    if (!client) {
      throw new Error('No SmartThings client available');
    }

    const describeCommand = (cmd: { component: string; capability: string; command: string }): string =>
      `${cmd.component}/${cmd.capability}/${cmd.command}`;

    // Track which commands in the batch already succeeded so that if a later command
    // fails, we don't lose track of partial progress (e.g. switch-on succeeded but the
    // follow-up mode-set failed => device left running, but in the wrong mode).
    const succeeded: string[] = [];

    for (const cmd of commands) {
      const description = describeCommand(cmd);
      try {
        await withRetry(
          () => this.withTimeout(client.devices.executeCommand(deviceId, {
            component: cmd.component,
            capability: cmd.capability,
            command: cmd.command,
            arguments: cmd.arguments || [],
          }), SMARTTHINGS_REQUEST_TIMEOUT_MS, `execute command ${description}`),
          { maxRetries: 3, initialDelayMs: 1000 }
        );
        succeeded.push(description);
        logger.debug({ deviceId, command: cmd }, 'Executed command');
      } catch (error) {
        const message = succeeded.length > 0
          ? `Command batch partially failed for device ${deviceId}: succeeded=[${succeeded.join(', ')}], failed=${description}. Device may be left in an inconsistent state.`
          : `Command batch failed for device ${deviceId}: failed=${description} (no prior commands in this batch succeeded).`;
        logger.error({ err: error, deviceId, commands, succeeded, failed: description }, 'Error executing commands');
        throw new Error(message, { cause: error });
      }
    }
  }
}