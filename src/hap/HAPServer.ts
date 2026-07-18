import { Coordinator } from '@/coordinator/Coordinator';
import { DeviceState } from '@/types';
import * as QRCode from 'qrcode';
import { v4 as uuid } from 'uuid';
import * as path from 'path';
import { logger } from '@/utils/logger';
import { promises as fs } from 'fs';
import { AccessoryCache, CachedAccessory } from './AccessoryCache';

// Import HAP-NodeJS components
import {
  Bridge,
  Service,
  Characteristic,
  CharacteristicValue,
  CharacteristicSetCallback,
  CharacteristicGetCallback,
  Categories,
  Accessory,
  uuid as HAP_uuid,
  HAPStorage
} from 'hap-nodejs';

export interface HAPThermostatEvent {
  deviceId: string;
  type: 'temperature' | 'mode' | 'both';
  mode?: 'heat' | 'cool' | 'auto' | 'off';
  temperature?: number;
  heatingSetpoint?: number;
  coolingSetpoint?: number;
}

/**
 * HomeKit Accessory Protocol server that bridges SmartThings devices to HomeKit.
 * Manages device lifecycle, state synchronization, and HomeKit pairing.
 */
export class SmartThingsHAPServer {
  private coordinator: Coordinator | null = null;
  private bridge: Bridge | null = null;
  private qrCode: string | null = null;
  private pincode: string;
  private setupCode: string = '';
  private readonly port: number;
  private accessoryCache: AccessoryCache;
  private hasRestoredAccessories = false;
  private lastUpdateTime = new Map<string, number>();
  private readonly UPDATE_COOLDOWN_MS = 2000; // 2 second cooldown between updates

  // Trailing-edge debounce state for updateDeviceState(): while a device is
  // within its cooldown window, the latest state is coalesced here and
  // flushed by a single tracked timer once the cooldown expires - instead of
  // being silently dropped.
  private pendingUpdates = new Map<string, DeviceState>();
  private cooldownTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Round-trip memory for TargetTemperature: records the Fahrenheit value we
  // last commanded to SmartThings alongside the exact Celsius value the user
  // set in HomeKit, so that when a poll echoes back that same Fahrenheit
  // value we can push the original Celsius value instead of a reconverted
  // (and potentially drifted) one.
  private lastCommanded = new Map<string, { commandedF: number; originalC: number }>();

  // Tracks the untracked-before unpair->reinitialize timer so stop() can
  // cancel it, and a flag so the timer callback (and any initialize()/start()
  // chained after it) can bail out if the server is shutting down.
  private unpairRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;

  private devices = new Map<string, {
    name: string;
    type: string;
    accessory: Accessory;
    thermostatService: Service;
    state: DeviceState;
  }>();

  /**
   * Creates a new HAP server instance.
   * @param port - HomeKit bridge port (default: 51826)
   * @param pincode - HomeKit pairing PIN (format: XXX-XX-XXX)
   */
  constructor(port: number = 51826, pincode: string = '942-37-286') {
    this.port = port;
    this.pincode = pincode;
    const persistPath = process.env.HAP_PERSIST_PATH || path.join(process.cwd(), 'persist');
    this.accessoryCache = new AccessoryCache(persistPath);
  }

  /**
   * Initializes the HAP bridge and sets up persistence.
   * Must be called before start().
   * @param coordinator - Coordinator instance for handling device events
   */
  async initialize(coordinator: Coordinator): Promise<void> {
    this.coordinator = coordinator;

    try {
      logger.info('HAP server initializing...');

      // Set up HAP-NodeJS storage path to persist accessory data
      const persistPath = process.env.HAP_PERSIST_PATH || path.join(process.cwd(), 'persist');
      logger.info(`📁 Setting HAP storage path to: ${persistPath}`);
      HAPStorage.setCustomStoragePath(persistPath);

      // Create the bridge accessory with a consistent UUID
      const bridgeUUID = HAP_uuid.generate('SmartThings-Bridge-Main');
      this.bridge = new Bridge('SmartThings Bridge', bridgeUUID);

      // Listen for unpair event to clean up when removed from HomeKit.
      // Defensively strip any pre-existing 'unpaired' listeners first so
      // repeated initialize() calls (e.g. the post-unpair re-init below)
      // never stack duplicate handlers on the same bridge object.
      (this.bridge as any).removeAllListeners?.('unpaired');
      this.bridge.on('unpaired' as any, () => {
        logger.info('🔓 Bridge unpaired from HomeKit - cleaning up persistence');
        this.handleUnpaired();
      });

      // Set up bridge information service
      this.bridge
        .getService(Service.AccessoryInformation)!
        .setCharacteristic(Characteristic.Manufacturer, 'SmartThings Bridge')
        .setCharacteristic(Characteristic.Model, 'HVAC Bridge v1.0')
        .setCharacteristic(Characteristic.SerialNumber, 'ST-BRIDGE-001')
        .setCharacteristic(Characteristic.FirmwareRevision, '1.0.0');

      // Initialize the setup code from pincode
      this.setupCode = this.pincode;

      logger.info('✅ HAP server initialized successfully');
      logger.info(`🏠 HomeKit Bridge: Port ${this.port}`);
      logger.info(`🔗 HomeKit Pairing Information:`);
      logger.info(`   QR Code: Available in web interface`);
      logger.info(`   Setup Code: ${this.setupCode}`);
      logger.info(`   PIN: ${this.pincode}`);
      logger.info('🎉 Ready for HomeKit pairing!');
    } catch (error) {
      logger.error({ err: error }, '❌ Error initializing HAP server');
      logger.error('💥 Cannot operate without functioning HomeKit protocol - terminating');
      throw error;
    }
  }

  private async generateQrCode(): Promise<void> {
    try {
      // Generate setup code for HomeKit pairing
      this.setupCode = this.pincode;

      // The QR code generation will be handled after the bridge is published
      // For now, set a placeholder
      this.qrCode = null;
    } catch (error) {
      logger.error({ err: error }, 'Error generating QR code');
      this.qrCode = null;
    }
  }

  /**
   * Publishes the HAP bridge and makes it discoverable for HomeKit pairing.
   * Restores cached accessories from previous sessions before publishing.
   * @throws {Error} If bridge not initialized via initialize()
   */
  async start(): Promise<void> {
    if (!this.bridge) {
      throw new Error('Bridge not initialized');
    }

    try {
      // Load and restore cached accessories BEFORE publishing the bridge
      await this.restoreCachedAccessories();

      // Use a consistent username (MAC address) for the bridge
      // This should remain the same across restarts to maintain accessory identity
      const bridgeUsername = process.env.HAP_BRIDGE_USERNAME || 'CC:22:3D:E3:CE:F6';

      // Publish the bridge to make it discoverable
      logger.info(`📡 Publishing bridge with username: ${bridgeUsername}`);
      logger.info(`   Accessories in bridge: ${this.bridge.bridgedAccessories.length}`);

      this.bridge.publish({
        username: bridgeUsername,
        port: this.port,
        pincode: this.pincode,
        category: Categories.BRIDGE,
        bind: '0.0.0.0' // Bind to all network interfaces, not just localhost
      } as any);

      // Add listener to detect configuration changes
      this.bridge.on('advertised' as any, () => {
        logger.info('🔔 Bridge advertised event fired');
      });

      // Check if bridge has any event emitters we can listen to
      logger.info(`   Bridge published successfully`);

      // Generate QR code after bridge is published
      await this.generateQrCodeAfterPublish();

      logger.info('🌐 HAP Bridge published and ready for pairing');
    } catch (error) {
      logger.error({ err: error }, '❌ Error starting HAP server');
      throw error;
    }
  }

  private async restoreCachedAccessories(): Promise<void> {
    const cachedAccessories = await this.accessoryCache.load();
    if (cachedAccessories.length === 0) {
      logger.info('📭 No cached accessories to restore');
      return;
    }

    logger.info(`🔄 Restoring ${cachedAccessories.length} cached accessories...`);
    logger.info('Note: Accessories will be synced with inclusion settings when coordinator reloads devices');
    const accessories: Accessory[] = [];
    const setupPromises: Promise<void>[] = [];

    for (const cached of cachedAccessories) {
      // Create unique display name by adding last 4 chars of device ID if names are duplicated
      const shortId = cached.deviceId.split('-').pop()?.substring(0, 4) || '';
      const uniqueName = `${cached.name} ${shortId}`.trim();
      const accessory = new Accessory(uniqueName, cached.uuid);

      // Set up accessory information
      const infoService = accessory.getService(Service.AccessoryInformation)!;
      infoService
        .setCharacteristic(Characteristic.Manufacturer, cached.manufacturer)
        .setCharacteristic(Characteristic.Model, cached.model)
        .setCharacteristic(Characteristic.SerialNumber, cached.serialNumber)
        .setCharacteristic(Characteristic.FirmwareRevision, cached.firmwareRevision);

      // Add Identify handler - required for HomeKit to properly manage the accessory
      infoService.getCharacteristic(Characteristic.Identify)
        .on('set', (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
          logger.info(`🔍 HomeKit IDENTIFY request for ${cached.name}`);
          callback();
        });

      // Add thermostat service with unique name
      const thermostatService = accessory.addService(Service.Thermostat, uniqueName);

      // Create default state
      const defaultState: DeviceState = {
        id: cached.deviceId,
        name: cached.name,
        temperatureSetpoint: 70,
        currentTemperature: 70,
        mode: 'off',
        lightOn: false,
        lastUpdated: new Date()
      };

      // IMPORTANT: Set up characteristics with event handlers NOW
      // This is critical - without these handlers, HomeKit can't interact with the accessory
      // FIX: Collect the promise so we can await ALL setups before publishing
      const setupPromise = this.setupThermostatCharacteristics(thermostatService, cached.deviceId, defaultState)
        .catch(error => {
          logger.error({ name: cached.name, err: error }, 'Failed to setup characteristics');
        });
      setupPromises.push(setupPromise);

      // Store the device reference
      this.devices.set(cached.deviceId, {
        name: cached.name,
        type: 'thermostat',
        accessory: accessory,
        thermostatService: thermostatService,
        state: defaultState
      });

      // Mark accessory as reachable
      accessory.reachable = true;

      // Set the unique display name
      accessory.displayName = uniqueName;

      accessories.push(accessory);
    }

    // CRITICAL FIX: Wait for ALL characteristic setups to complete before proceeding
    logger.info(`⏳ Waiting for ${setupPromises.length} characteristic setups to complete...`);
    await Promise.all(setupPromises);
    logger.info(`✅ All characteristic setups completed`);

    // Add all accessories to the bridge at once
    if (accessories.length > 0 && this.bridge) {
      logger.info(`🔧 Adding ${accessories.length} accessories to bridge...`);

      // Log current bridge state
      logger.info(`   Bridge info before adding accessories:`);
      logger.info(`   - Bridged accessories count: ${this.bridge.bridgedAccessories.length}`);

      this.bridge.addBridgedAccessories(accessories);
      this.hasRestoredAccessories = true;

      logger.info(`✅ Restored ${accessories.length} accessories to bridge`);
      logger.info(`   - Bridged accessories count after: ${this.bridge.bridgedAccessories.length}`);

      // Log accessory details
      accessories.forEach(acc => {
        logger.info(`   - Accessory: ${acc.displayName} (UUID: ${acc.UUID})`);
      });
    }
  }

  private async generateQrCodeAfterPublish(): Promise<void> {
    try {
      if (!this.bridge) return;

      // Get the setup URI from the published bridge
      const setupURI = this.bridge.setupURI();

      // Log the setup URI for debugging
      logger.info({ setupURI, port: this.port, pincode: this.pincode }, '📱 Generated HomeKit Setup URI');

      this.qrCode = await QRCode.toString(setupURI, {
        type: 'svg',
        width: 256,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      });

      logger.info('✅ QR code generated successfully');
    } catch (error) {
      logger.error({ err: error }, 'Error generating QR code after publish');
      this.qrCode = null;
    }
  }

  /**
   * Returns the QR code SVG for HomeKit pairing.
   * @returns SVG string or null if bridge not yet published
   */
  getQrCode(): string | null {
    return this.qrCode;
  }

  /**
   * Returns the HomeKit pairing setup code.
   * @returns Setup code string or null if not available
   */
  getPairingCode(): string | null {
    return this.setupCode;
  }

  /**
   * Adds a SmartThings device to the HomeKit bridge as a thermostat accessory.
   * If device already exists, updates its state instead. Caches accessory for persistence.
   * @param deviceId - Unique SmartThings device identifier
   * @param deviceState - Current device state (temperature, mode, etc.)
   */
  async addDevice(deviceId: string, deviceState: DeviceState): Promise<void> {
    logger.info(`HAP: Processing device ${deviceState.name} (${deviceId})`);

    if (!this.bridge) {
      logger.error('❌ Cannot add device - HAP bridge not initialized');
      return;
    }

    // Check if device already exists in our tracking
    const existingDevice = this.devices.get(deviceId);
    if (existingDevice) {
      logger.info(`📋 HAP: Device ${deviceState.name} already tracked`);

      // Just update the state, characteristics were already set up during restore
      await this.updateDeviceState(deviceId, deviceState);
      return;
    }

    // Check if this is a cached accessory that wasn't restored (shouldn't happen normally).
    // Don't drop the device silently - fall through and create the accessory.
    // The UUID is generated deterministically from deviceId below, so
    // HomeKit identity is preserved even though restoration was skipped.
    if (this.accessoryCache.has(deviceId)) {
      logger.warn(`⚠️  HAP: Device ${deviceState.name} is cached but wasn't restored - creating accessory now instead of dropping it`);
    }

    try {
      // Create new accessory with consistent UUID and unique name
      const accessoryUUID = HAP_uuid.generate(`smartthings-thermostat-${deviceId}`);
      const shortId = deviceId.split('-').pop()?.substring(0, 4) || '';
      const uniqueName = `${deviceState.name} ${shortId}`.trim();
      const accessory = new Accessory(uniqueName, accessoryUUID);

      // Set up accessory information
      const manufacturer = 'SmartThings';
      const model = 'HVAC Thermostat';
      const serialNumber = deviceId;
      const firmwareRevision = '1.0.0';

      const infoService = accessory.getService(Service.AccessoryInformation)!;
      infoService
        .setCharacteristic(Characteristic.Manufacturer, manufacturer)
        .setCharacteristic(Characteristic.Model, model)
        .setCharacteristic(Characteristic.SerialNumber, serialNumber)
        .setCharacteristic(Characteristic.FirmwareRevision, firmwareRevision);

      // Add Identify handler
      infoService.getCharacteristic(Characteristic.Identify)
        .on('set', (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
          logger.info(`🔍 HomeKit IDENTIFY request for ${deviceState.name}`);
          callback();
        });

      // Add thermostat service with unique name
      const thermostatService = accessory.addService(Service.Thermostat, uniqueName);

      // Set up thermostat characteristics
      await this.setupThermostatCharacteristics(thermostatService, deviceId, deviceState);

      // Mark accessory as reachable
      accessory.reachable = true;

      // Add to bridge
      this.bridge.addBridgedAccessory(accessory);

      // Store the device reference for updates
      this.devices.set(deviceId, {
        name: deviceState.name,
        type: 'thermostat',
        accessory: accessory,
        thermostatService: thermostatService,
        state: deviceState
      });

      // Cache the accessory (storing original name, will add unique ID on restore)
      await this.accessoryCache.addOrUpdate({
        deviceId,
        name: deviceState.name,
        uuid: accessoryUUID,
        manufacturer,
        model,
        serialNumber,
        firmwareRevision
      });

      logger.info({
        name: deviceState.name,
        currentTemp: deviceState.currentTemperature,
        setpoint: deviceState.temperatureSetpoint,
        mode: deviceState.mode
      }, '✅ HAP: Thermostat device added to bridge and cached');
    } catch (error) {
      logger.error({ name: deviceState.name, err: error }, '❌ Failed to add device');
      throw error;
    }
  }

  private async setupThermostatCharacteristics(
    thermostatService: Service,
    deviceId: string,
    deviceState: DeviceState
  ): Promise<void> {
    logger.info({
      name: deviceState.name,
      deviceId,
      currentTemp: deviceState.currentTemperature,
      setpoint: deviceState.temperatureSetpoint,
      mode: deviceState.mode
    }, '⚙️  Setting up characteristics');
    // Current Temperature (read-only). HomeKit requires an initial numeric value at
    // accessory creation, so fall back to a safe default if the SmartThings reading is
    // missing - this is a structural requirement, not a general-purpose 0-coercion.
    const safeCurrentTemp = deviceState.currentTemperature ?? 68; // Default to 68°F if undefined
    thermostatService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({
        minValue: -50,
        maxValue: 100,
        minStep: 0.1
      })
      .setValue(this.quantize(this.fahrenheitToCelsius(safeCurrentTemp), 0.1));

    // Target Temperature (read/write)
    const safeTargetSetpoint = deviceState.temperatureSetpoint || 68; // Default to 68°F if undefined/null/0
    thermostatService
      .getCharacteristic(Characteristic.TargetTemperature)
      .setProps({
        minValue: 10,
        maxValue: 35,
        minStep: 0.5
      })
      .setValue(this.quantize(this.fahrenheitToCelsius(safeTargetSetpoint), 0.5))
      .on('set', (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
        logger.info(`🏠 HomeKit SET TargetTemperature for ${deviceId}: ${value}°C`);
        this.handleTargetTemperatureChange(deviceId, value as number, callback);
      })
      .on('get', (callback: CharacteristicGetCallback) => {
        logger.info(`🏠 HomeKit GET TargetTemperature for ${deviceId}`);
        const device = this.devices.get(deviceId);
        if (device) {
          if (device.state.temperatureSetpoint !== undefined) {
            const temp = this.quantize(this.fahrenheitToCelsius(device.state.temperatureSetpoint), 0.5);
            logger.info(`   Returning: ${temp}°C (${device.state.temperatureSetpoint}°F)`);
            callback(null, temp);
            return;
          }
          // Setpoint currently unavailable (missing/broken SmartThings reading). GET must
          // synchronously return a number to HomeKit - unlike a push update, there's no way to
          // "skip" a read - but fabricating a fixed 68°F here would contradict the push path
          // (which deliberately leaves the characteristic untouched rather than overwrite a
          // known-good value with a guess). Instead, return whatever value is already cached on
          // the characteristic (set at creation, or from the last successful update).
          const cachedValue = thermostatService.getCharacteristic(Characteristic.TargetTemperature).value;
          logger.debug(`   TargetTemperature setpoint unavailable for ${deviceId} - returning last cached value (${cachedValue})`);
          callback(null, cachedValue);
        } else {
          logger.info(`   ❌ Device not found!`);
          callback(new Error('Device not found'));
        }
      });

    // Current Heating Cooling State (read-only)
    thermostatService
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .setValue(this.mapModeToCurrentState(deviceState.mode));

    // Target Heating Cooling State (read/write)
    thermostatService
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setValue(this.mapModeToTargetState(deviceState.mode))
      .on('set', (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
        logger.info(`🏠 HomeKit SET TargetHeatingCoolingState for ${deviceId}: ${value}`);
        this.handleTargetModeChange(deviceId, value as number, callback);
      })
      .on('get', (callback: CharacteristicGetCallback) => {
        logger.info(`🏠 HomeKit GET TargetHeatingCoolingState for ${deviceId}`);
        const device = this.devices.get(deviceId);
        if (device) {
          const mode = this.mapModeToTargetState(device.state.mode);
          logger.info(`   Returning: ${mode} (${device.state.mode})`);
          callback(null, mode);
        } else {
          logger.info(`   ❌ Device not found!`);
          callback(new Error('Device not found'));
        }
      });

    // Temperature Display Units (always Fahrenheit)
    thermostatService
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .setValue(Characteristic.TemperatureDisplayUnits.FAHRENHEIT);

    // Heating Threshold Temperature (used by HomeKit in Auto mode for the lower bound)
    const DEFAULT_TEMP_BAND = 4;
    const safeHeatingSetpoint = deviceState.heatingSetpoint
      ?? (deviceState.coolingSetpoint !== undefined ? deviceState.coolingSetpoint - DEFAULT_TEMP_BAND : 68);
    thermostatService
      .getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps({
        minValue: 0,
        maxValue: 25,
        minStep: 0.5
      })
      .setValue(this.quantize(this.fahrenheitToCelsius(safeHeatingSetpoint), 0.5))
      .on('set', (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
        logger.info(`🏠 HomeKit SET HeatingThresholdTemperature for ${deviceId}: ${value}°C`);
        this.handleHeatingThresholdChange(deviceId, value as number, callback);
      })
      .on('get', (callback: CharacteristicGetCallback) => {
        const device = this.devices.get(deviceId);
        if (device) {
          const setpoint = device.state.heatingSetpoint
            ?? (device.state.coolingSetpoint !== undefined ? device.state.coolingSetpoint - DEFAULT_TEMP_BAND : 68);
          const temp = this.quantize(this.fahrenheitToCelsius(setpoint), 0.5);
          callback(null, temp);
        } else {
          callback(new Error('Device not found'));
        }
      });

    // Cooling Threshold Temperature (used by HomeKit in Auto mode for the upper bound)
    const safeCoolingSetpoint = deviceState.coolingSetpoint ?? deviceState.temperatureSetpoint ?? 72;
    thermostatService
      .getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps({
        minValue: 10,
        maxValue: 35,
        minStep: 0.5
      })
      .setValue(this.quantize(this.fahrenheitToCelsius(safeCoolingSetpoint), 0.5))
      .on('set', (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
        logger.info(`🏠 HomeKit SET CoolingThresholdTemperature for ${deviceId}: ${value}°C`);
        this.handleCoolingThresholdChange(deviceId, value as number, callback);
      })
      .on('get', (callback: CharacteristicGetCallback) => {
        const device = this.devices.get(deviceId);
        if (device) {
          const setpoint = device.state.coolingSetpoint ?? device.state.temperatureSetpoint ?? 72;
          const temp = this.quantize(this.fahrenheitToCelsius(setpoint), 0.5);
          callback(null, temp);
        } else {
          callback(new Error('Device not found'));
        }
      });
  }

  private async handleTargetTemperatureChange(
    deviceId: string,
    celsiusValue: number,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    const fahrenheitValue = this.celsiusToFahrenheit(celsiusValue);
    const commandedF = Math.round(fahrenheitValue);
    logger.info(`HAP: Target temperature change for ${deviceId}: ${fahrenheitValue.toFixed(1)}°F`);

    // Remember the exact Celsius value the user set alongside the rounded
    // Fahrenheit value we're about to send to SmartThings. If a later poll
    // reports this same Fahrenheit value back, we push this original Celsius
    // value to HomeKit instead of reconverting (which can drift, e.g.
    // 22.5C -> 73F -> 22.78C -> rounds to 23C).
    this.lastCommanded.set(deviceId, { commandedF, originalC: celsiusValue });

    // Update our local state immediately
    const device = this.devices.get(deviceId);
    if (device) {
      device.state.temperatureSetpoint = commandedF;
    }

    // Respond to HomeKit immediately
    callback();

    // Handle SmartThings update asynchronously (don't await)
    if (this.coordinator) {
      this.coordinator.handleThermostatEvent({
        deviceId,
        type: 'temperature',
        temperature: commandedF
      }).catch((error: any) => {
        logger.error({ deviceId, err: error }, 'Error updating SmartThings');
      });
    }
  }

  private async handleTargetModeChange(
    deviceId: string,
    hapMode: number,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    const mode = this.mapTargetStateToMode(hapMode);
    logger.info(`HAP: Target mode change for ${deviceId}: ${mode}`);

    // Update our local state immediately
    const device = this.devices.get(deviceId);
    if (device) {
      device.state.mode = mode;

      // Also update the current heating/cooling state to reflect the change immediately
      const service = device.thermostatService;
      service
        .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
        .updateValue(this.mapModeToCurrentState(mode));
    }

    // Respond to HomeKit immediately
    callback();

    // Handle SmartThings update asynchronously (don't await)
    if (this.coordinator) {
      this.coordinator.handleThermostatEvent({
        deviceId,
        type: 'mode',
        mode: mode
      }).catch((error: any) => {
        logger.error({ deviceId, err: error }, 'Error updating SmartThings');
      });
    }
  }

  private async handleCoolingThresholdChange(
    deviceId: string,
    celsiusValue: number,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    const fahrenheitValue = this.celsiusToFahrenheit(celsiusValue);
    const commandedF = Math.round(fahrenheitValue);
    logger.info(`HAP: Cooling threshold change for ${deviceId}: ${fahrenheitValue.toFixed(1)}°F`);

    const device = this.devices.get(deviceId);
    if (device) {
      device.state.coolingSetpoint = commandedF;
    }

    callback();

    if (this.coordinator) {
      this.coordinator.handleThermostatEvent({
        deviceId,
        type: 'temperature',
        coolingSetpoint: commandedF,
      }).catch((error: any) => {
        logger.error({ deviceId, err: error }, 'Error handling cooling threshold change');
      });
    }
  }

  private async handleHeatingThresholdChange(
    deviceId: string,
    celsiusValue: number,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    const fahrenheitValue = this.celsiusToFahrenheit(celsiusValue);
    const commandedF = Math.round(fahrenheitValue);
    logger.info(`HAP: Heating threshold change for ${deviceId}: ${fahrenheitValue.toFixed(1)}°F`);

    const device = this.devices.get(deviceId);
    if (device) {
      device.state.heatingSetpoint = commandedF;
    }

    callback();

    if (this.coordinator) {
      this.coordinator.handleThermostatEvent({
        deviceId,
        type: 'temperature',
        heatingSetpoint: commandedF,
      }).catch((error: any) => {
        logger.error({ deviceId, err: error }, 'Error handling heating threshold change');
      });
    }
  }

  /**
   * Updates HomeKit characteristics when SmartThings device state changes.
   * Includes cooldown period to prevent excessive updates. Updates that
   * arrive during the cooldown window are not dropped - the latest one is
   * coalesced and applied via a single trailing-edge timer once the
   * cooldown expires.
   * @param deviceId - Device to update
   * @param deviceState - New device state
   */
  async updateDeviceState(deviceId: string, deviceState: DeviceState): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) {
      logger.warn(`HAP: Device ${deviceId} not found for state update`);
      return;
    }

    // Check for cooldown period
    const lastUpdate = this.lastUpdateTime.get(deviceId) || 0;
    const now = Date.now();
    if (now - lastUpdate < this.UPDATE_COOLDOWN_MS) {
      // Trailing-edge debounce: remember the latest state (coalescing any
      // update already pending) and make sure exactly one timer is scheduled
      // to flush it once the cooldown window expires.
      this.pendingUpdates.set(deviceId, deviceState);
      logger.info(`⏸️  HAP: Deferring update for ${deviceState.name} - cooldown period (${now - lastUpdate}ms since last update)`);

      if (!this.cooldownTimers.has(deviceId)) {
        const remainingMs = this.UPDATE_COOLDOWN_MS - (now - lastUpdate);
        const timer = setTimeout(() => {
          this.cooldownTimers.delete(deviceId);
          const pending = this.pendingUpdates.get(deviceId);
          this.pendingUpdates.delete(deviceId);
          if (pending) {
            this.applyDeviceStateUpdate(deviceId, pending).catch(error => {
              logger.error({ deviceId, err: error }, '❌ Failed to apply deferred HAP device state update');
            });
          }
        }, Math.max(remainingMs, 0));
        this.cooldownTimers.set(deviceId, timer);
      }
      return;
    }

    await this.applyDeviceStateUpdate(deviceId, deviceState);
  }

  /**
   * Actually applies a device state update to the HomeKit characteristics.
   * Called either directly (cooldown already elapsed) or from the trailing
   * timer scheduled by updateDeviceState() once the cooldown expires.
   */
  private async applyDeviceStateUpdate(deviceId: string, deviceState: DeviceState): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) {
      logger.warn(`HAP: Device ${deviceId} not found for deferred state update`);
      return;
    }

    try {
      logger.info(`🔄 HAP: applyDeviceStateUpdate called for ${deviceState.name} (${deviceId})`);

      // Check if values actually changed. A missing (undefined) reading in deviceState never
      // counts as a "change" to push to HomeKit - we skip pushing that characteristic below
      // and leave whatever value HomeKit already has rather than pushing NaN.
      const oldState = device.state;
      const newCurrentTemp = deviceState.currentTemperature;
      const newSetpointF = deviceState.temperatureSetpoint;

      const tempChanged = newCurrentTemp !== undefined &&
        (oldState.currentTemperature === undefined ||
          Math.abs(oldState.currentTemperature - newCurrentTemp) > 0.1);

      // Round-trip check: if this poll's setpoint matches a value we just
      // commanded to SmartThings, treat it as our own echo. We always want
      // to (re)assert the originally-requested Celsius value in that case,
      // even if it happens to already match device.state numerically, since
      // the goal is to correct any drift that crept into the characteristic.
      const pendingCommand = this.lastCommanded.get(deviceId);
      const isRoundTripEcho = !!pendingCommand && newSetpointF !== undefined &&
        Math.abs(newSetpointF - pendingCommand.commandedF) < 0.5;

      const setpointChanged = newSetpointF !== undefined &&
        (oldState.temperatureSetpoint === undefined ||
          Math.abs(oldState.temperatureSetpoint - newSetpointF) > 0.1 ||
          isRoundTripEcho);
      const modeChanged = oldState.mode !== deviceState.mode;
      const coolingThresholdChanged = deviceState.coolingSetpoint !== undefined &&
        (oldState.coolingSetpoint === undefined ||
          Math.abs(oldState.coolingSetpoint - deviceState.coolingSetpoint) > 0.1);
      const heatingThresholdChanged = deviceState.heatingSetpoint !== undefined &&
        (oldState.heatingSetpoint === undefined ||
          Math.abs(oldState.heatingSetpoint - deviceState.heatingSetpoint) > 0.1);

      if (!tempChanged && !setpointChanged && !modeChanged && !coolingThresholdChanged && !heatingThresholdChanged) {
        logger.info({ deviceId }, '   No changes detected, skipping update');
        return;
      }

      logger.info({ deviceId, tempChanged, setpointChanged, modeChanged, coolingThresholdChanged, heatingThresholdChanged }, '   Changes detected');
      this.lastUpdateTime.set(deviceId, Date.now());

      // Update characteristics if values have changed
      const service = device.thermostatService;

      // Update current temperature
      if (newCurrentTemp === undefined) {
        logger.debug({ deviceId }, '   Skipping CurrentTemperature push - reading unavailable (undefined)');
      } else if (tempChanged) {
        const newTemp = this.quantize(this.fahrenheitToCelsius(newCurrentTemp), 0.1);
        logger.info(`   Updating CurrentTemperature: ${oldState.currentTemperature}°F -> ${newCurrentTemp}°F (${newTemp}°C)`);
        service
          .getCharacteristic(Characteristic.CurrentTemperature)
          .updateValue(newTemp);
      }

      // Update target temperature
      if (newSetpointF === undefined) {
        logger.debug({ deviceId }, '   Skipping TargetTemperature push - setpoint unavailable (undefined)');
      } else if (setpointChanged) {
        let newSetpoint: number;
        if (isRoundTripEcho && pendingCommand) {
          // Push back exactly what the user originally set rather than the
          // reconverted (and possibly drifted) Fahrenheit-from-SmartThings value.
          newSetpoint = this.quantize(pendingCommand.originalC, 0.5);
          logger.info(`   Round-trip echo detected for setpoint ${newSetpointF}°F - restoring original ${newSetpoint}°C instead of reconverted value`);
          this.lastCommanded.delete(deviceId);
        } else {
          newSetpoint = this.quantize(this.fahrenheitToCelsius(newSetpointF), 0.5);
        }
        logger.info(`   Updating TargetTemperature: ${oldState.temperatureSetpoint}°F -> ${newSetpointF}°F (${newSetpoint}°C)`);
        service
          .getCharacteristic(Characteristic.TargetTemperature)
          .updateValue(newSetpoint);
      }

      // Update threshold temperatures (used by HomeKit in Auto mode)
      if (coolingThresholdChanged) {
        const newCoolingC = this.quantize(this.fahrenheitToCelsius(deviceState.coolingSetpoint!), 0.5);
        logger.info(`   Updating CoolingThresholdTemperature: ${oldState.coolingSetpoint}°F -> ${deviceState.coolingSetpoint}°F (${newCoolingC}°C)`);
        service
          .getCharacteristic(Characteristic.CoolingThresholdTemperature)
          .updateValue(newCoolingC);
      }
      if (heatingThresholdChanged) {
        const newHeatingC = this.quantize(this.fahrenheitToCelsius(deviceState.heatingSetpoint!), 0.5);
        logger.info(`   Updating HeatingThresholdTemperature: ${oldState.heatingSetpoint}°F -> ${deviceState.heatingSetpoint}°F (${newHeatingC}°C)`);
        service
          .getCharacteristic(Characteristic.HeatingThresholdTemperature)
          .updateValue(newHeatingC);
      }

      // Update current heating/cooling state
      if (modeChanged) {
        const currentState = this.mapModeToCurrentState(deviceState.mode);
        const targetState = this.mapModeToTargetState(deviceState.mode);
        logger.info({
          oldMode: oldState.mode,
          newMode: deviceState.mode,
          currentState,
          targetState
        }, '   Updating HeatingCoolingState');

        service
          .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
          .updateValue(currentState);

        // Update target heating/cooling state
        service
          .getCharacteristic(Characteristic.TargetHeatingCoolingState)
          .updateValue(targetState);
      }

      // Update stored state
      device.state = deviceState;

      logger.info({ name: deviceState.name }, '✅ HAP: Updated device state');
    } catch (error) {
      logger.error({ name: deviceState.name, err: error }, '❌ Failed to update HAP device state');
    }
  }

  /**
   * Removes a device from the HomeKit bridge and clears it from cache.
   * @param deviceId - Device to remove
   */
  async removeDevice(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (device && this.bridge) {
      try {
        this.bridge.removeBridgedAccessory(device.accessory);
        logger.info({ deviceId }, '✅ HAP: Device removed from bridge');
      } catch (error) {
        logger.error({ deviceId, err: error }, 'Error removing device from HAP bridge');
      }
    }

    // Cancel any pending trailing-edge cooldown flush for this device so it
    // doesn't fire (and re-add tracking state) after removal.
    const cooldownTimer = this.cooldownTimers.get(deviceId);
    if (cooldownTimer) {
      clearTimeout(cooldownTimer);
      this.cooldownTimers.delete(deviceId);
    }
    this.pendingUpdates.delete(deviceId);
    this.lastUpdateTime.delete(deviceId);
    this.lastCommanded.delete(deviceId);

    this.devices.delete(deviceId);
    await this.accessoryCache.remove(deviceId);
    logger.info(`✅ HAP: Device ${deviceId} removed from tracking and cache`);
  }

  // Temperature conversion methods
  private fahrenheitToCelsius(fahrenheit: number): number {
    return (fahrenheit - 32) * 5 / 9;
  }

  private celsiusToFahrenheit(celsius: number): number {
    return (celsius * 9 / 5) + 32;
  }

  /**
   * Rounds a value to the nearest multiple of `step`, stripping the
   * floating-point noise that `Math.round(value / step) * step` can leave
   * behind (e.g. 22.799999999999997). Used to keep every Celsius value we
   * push to a HomeKit characteristic aligned to its minStep so HAP-NodeJS
   * doesn't warn about out-of-step values.
   */
  private quantize(value: number, step: number): number {
    const quantized = Math.round(value / step) * step;
    return Math.round(quantized * 1000) / 1000;
  }

  // Mode mapping methods
  private mapModeToCurrentState(mode: string): number {
    switch (mode.toLowerCase()) {
      case 'heat':
      case 'heating':
        return Characteristic.CurrentHeatingCoolingState.HEAT;
      case 'cool':
      case 'cooling':
        return Characteristic.CurrentHeatingCoolingState.COOL;
      case 'off':
        return Characteristic.CurrentHeatingCoolingState.OFF;
      default:
        return Characteristic.CurrentHeatingCoolingState.OFF;
    }
  }

  private mapModeToTargetState(mode: string): number {
    switch (mode.toLowerCase()) {
      case 'heat':
      case 'heating':
        return Characteristic.TargetHeatingCoolingState.HEAT;
      case 'cool':
      case 'cooling':
        return Characteristic.TargetHeatingCoolingState.COOL;
      case 'auto':
        return Characteristic.TargetHeatingCoolingState.AUTO;
      case 'off':
        return Characteristic.TargetHeatingCoolingState.OFF;
      default:
        return Characteristic.TargetHeatingCoolingState.OFF;
    }
  }

  private mapTargetStateToMode(hapMode: number): 'heat' | 'cool' | 'auto' | 'off' {
    switch (hapMode) {
      case Characteristic.TargetHeatingCoolingState.HEAT:
        return 'heat';
      case Characteristic.TargetHeatingCoolingState.COOL:
        return 'cool';
      case Characteristic.TargetHeatingCoolingState.AUTO:
        return 'auto';
      case Characteristic.TargetHeatingCoolingState.OFF:
        return 'off';
      default:
        return 'off';
    }
  }

  /**
   * Returns current state of all devices managed by this HAP server.
   * @returns Map of device IDs to their current states
   */
  getDeviceStates(): Map<string, DeviceState> {
    const states = new Map<string, DeviceState>();
    for (const [deviceId, device] of this.devices) {
      states.set(deviceId, device.state);
    }
    return states;
  }

  /**
   * Returns set of device IDs currently bridged to HomeKit.
   * Checks both internal tracking and bridge accessories.
   * @returns Set of device IDs
   */
  getBridgedDeviceIds(): Set<string> {
    const deviceIds = new Set<string>();

    if (!this.bridge) {
      return deviceIds;
    }

    // Check all bridged accessories for SmartThings device IDs
    for (const accessory of this.bridge.bridgedAccessories) {
      // Extract device ID from the accessory UUID
      // UUID format: smartthings-thermostat-{deviceId}
      const uuidString = accessory.UUID;

      // Check all known device IDs to find matches
      for (const [deviceId] of this.devices) {
        const expectedUUID = HAP_uuid.generate(`smartthings-thermostat-${deviceId}`);
        if (expectedUUID === uuidString) {
          deviceIds.add(deviceId);
          break;
        }
      }

      // Also check serial number from AccessoryInformation service
      const infoService = accessory.getService(Service.AccessoryInformation);
      if (infoService) {
        const serialNumber = infoService.getCharacteristic(Characteristic.SerialNumber).value;
        if (serialNumber && typeof serialNumber === 'string') {
          deviceIds.add(serialNumber);
        }
      }
    }

    return deviceIds;
  }

  private async handleUnpaired(): Promise<void> {
    if (this.stopping) {
      logger.info('⏭️  Ignoring unpair event - server is stopping');
      return;
    }

    try {
      logger.info('🧹 Cleaning up after unpair...');

      // Clear the cached accessories
      await this.accessoryCache.save([]);
      logger.info('   ✓ Cleared cached accessories');

      // Clear the devices map
      this.devices.clear();
      logger.info('   ✓ Cleared device map');

      // Delete persistence files to allow re-pairing
      const persistPath = process.env.HAP_PERSIST_PATH || path.join(process.cwd(), 'persist');
      const bridgeUsername = process.env.HAP_BRIDGE_USERNAME || 'CC:22:3D:E3:CE:F6';
      const cleanUsername = bridgeUsername.replace(/:/g, '');

      try {
        // Delete AccessoryInfo file
        await fs.unlink(path.join(persistPath, `AccessoryInfo.${cleanUsername}.json`));
        logger.info('   ✓ Deleted AccessoryInfo');
      } catch (error) {
        logger.info('   - AccessoryInfo already deleted or not found');
      }

      try {
        // Delete IdentifierCache file
        await fs.unlink(path.join(persistPath, `IdentifierCache.${cleanUsername}.json`));
        logger.info('   ✓ Deleted IdentifierCache');
      } catch (error) {
        logger.info('   - IdentifierCache already deleted or not found');
      }

      logger.info('✅ Bridge is ready to be re-paired');

      // Restart the bridge to reinitialize
      logger.info('🔄 Restarting bridge...');
      if (this.bridge) {
        this.bridge.unpublish();
      }

      // Give it a moment before restarting. Track the timer handle so stop()
      // can cancel it - otherwise it races shutdown: stop() nulls this.bridge,
      // then this timer fires and resurrects it, and the process never
      // exits cleanly.
      if (this.unpairRestartTimer) {
        clearTimeout(this.unpairRestartTimer);
      }
      this.unpairRestartTimer = setTimeout(() => {
        this.unpairRestartTimer = null;

        if (this.stopping) {
          logger.info('⏭️  Skipping unpair restart - server is stopping');
          return;
        }

        logger.info('♻️ Reinitializing bridge for fresh pairing...');
        this.initialize(this.coordinator!).then(() => {
          if (this.stopping) {
            logger.info('⏭️  Skipping post-unpair bridge publish - server is stopping');
            return;
          }
          return this.start();
        }).catch(error => {
          logger.error({ err: error }, 'Error restarting bridge after unpair');
        });
      }, 2000);

    } catch (error) {
      logger.error({ err: error }, 'Error handling unpair');
    }
  }

  /**
   * Manually resets the HomeKit pairing by clearing all cached accessories,
   * deleting persistence files, and reinitializing the bridge.
   * This is useful when you want to force a fresh pairing without using the Home app.
   */
  async resetPairing(): Promise<void> {
    logger.info('🔄 Manual pairing reset requested');
    await this.handleUnpaired();
  }

  /**
   * Checks if the bridge is currently paired with any HomeKit controllers.
   * @returns true if paired, false otherwise
   */
  isPaired(): boolean {
    if (!this.bridge) {
      return false;
    }

    // Check if there are any paired controllers
    // HAP-NodeJS stores paired controllers in the AccessoryInfo
    try {
      const accessoryInfo = (this.bridge as any)._accessoryInfo;
      if (accessoryInfo) {
        const pairedClients = accessoryInfo.pairedClients || {};
        return Object.keys(pairedClients).length > 0;
      }
    } catch (error) {
      logger.error({ err: error }, 'Error checking pairing status');
    }

    return false;
  }

  /**
   * Unpublishes the HAP bridge and stops the server.
   * Makes the bridge no longer discoverable in HomeKit.
   */
  async stop(): Promise<void> {
    this.stopping = true;

    // Cancel the untracked-before unpair->reinitialize timer so it can't
    // resurrect the bridge after this method has torn it down.
    if (this.unpairRestartTimer) {
      clearTimeout(this.unpairRestartTimer);
      this.unpairRestartTimer = null;
    }

    // Cancel any pending trailing-edge cooldown flushes.
    for (const timer of this.cooldownTimers.values()) {
      clearTimeout(timer);
    }
    this.cooldownTimers.clear();
    this.pendingUpdates.clear();

    if (this.bridge) {
      try {
        this.bridge.unpublish();
        logger.info('HAP bridge unpublished');
      } catch (error) {
        logger.error({ err: error }, 'Error unpublishing HAP bridge');
      }
      this.bridge = null;
    }

    logger.info('HAP server stopped');
  }
}