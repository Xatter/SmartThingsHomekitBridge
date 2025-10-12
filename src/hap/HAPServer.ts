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

      // Listen for unpair event to clean up when removed from HomeKit
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

      // QR code will be generated after bridge is published

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

    // Check if this is a cached accessory that wasn't restored (shouldn't happen normally)
    if (this.accessoryCache.has(deviceId)) {
      logger.info(`⚠️  HAP: Device ${deviceState.name} is cached but wasn't restored`);
      return;
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
    // Current Temperature (read-only)
    thermostatService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({
        minValue: -50,
        maxValue: 100,
        minStep: 0.1
      })
      .setValue(this.fahrenheitToCelsius(deviceState.currentTemperature));

    // Target Temperature (read/write)
    const safeTargetSetpoint = deviceState.temperatureSetpoint || 68; // Default to 68°F if undefined/null/0
    thermostatService
      .getCharacteristic(Characteristic.TargetTemperature)
      .setProps({
        minValue: 10,
        maxValue: 35,
        minStep: 0.5
      })
      .setValue(this.fahrenheitToCelsius(safeTargetSetpoint))
      .on('set', (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
        logger.info(`🏠 HomeKit SET TargetTemperature for ${deviceId}: ${value}°C`);
        this.handleTargetTemperatureChange(deviceId, value as number, callback);
      })
      .on('get', (callback: CharacteristicGetCallback) => {
        logger.info(`🏠 HomeKit GET TargetTemperature for ${deviceId}`);
        const device = this.devices.get(deviceId);
        if (device) {
          const temp = this.fahrenheitToCelsius(device.state.temperatureSetpoint);
          logger.info(`   Returning: ${temp}°C (${device.state.temperatureSetpoint}°F)`);
          callback(null, temp);
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

    // Heating Threshold Temperature (required by HAP but set to safe minimum)
    thermostatService
      .getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setValue(10); // 10°C minimum required by HAP

    // Cooling Threshold Temperature (required by HAP but set to safe values)
    thermostatService
      .getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setValue(25); // 25°C (77°F) as reasonable cooling threshold
  }

  private async handleTargetTemperatureChange(
    deviceId: string,
    celsiusValue: number,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    const fahrenheitValue = this.celsiusToFahrenheit(celsiusValue);
    logger.info(`HAP: Target temperature change for ${deviceId}: ${fahrenheitValue.toFixed(1)}°F`);

    // Update our local state immediately
    const device = this.devices.get(deviceId);
    if (device) {
      device.state.temperatureSetpoint = Math.round(fahrenheitValue);
    }

    // Respond to HomeKit immediately
    callback();

    // Handle SmartThings update asynchronously (don't await)
    if (this.coordinator) {
      this.coordinator.handleHAPThermostatEvent({
        deviceId,
        type: 'temperature',
        temperature: Math.round(fahrenheitValue)
      }).catch(error => {
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
      this.coordinator.handleHAPThermostatEvent({
        deviceId,
        type: 'mode',
        mode: mode
      }).catch(error => {
        logger.error({ deviceId, err: error }, 'Error updating SmartThings');
      });
    }
  }

  private async handleCoolingThresholdChange(
    deviceId: string,
    celsiusValue: number,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    try {
      const fahrenheitValue = this.celsiusToFahrenheit(celsiusValue);
      logger.info(`HAP: Cooling threshold change for ${deviceId}: ${fahrenheitValue.toFixed(1)}°F`);

      if (this.coordinator) {
        await this.coordinator.handleHAPThermostatEvent({
          deviceId,
          type: 'temperature',
          temperature: Math.round(fahrenheitValue)
        });
      }

      callback();
    } catch (error) {
      logger.error({ deviceId, err: error }, 'Error handling cooling threshold change');
      callback(error as Error);
    }
  }

  private async handleHeatingThresholdChange(
    deviceId: string,
    celsiusValue: number,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    try {
      const fahrenheitValue = this.celsiusToFahrenheit(celsiusValue);
      logger.info(`HAP: Heating threshold change for ${deviceId}: ${fahrenheitValue.toFixed(1)}°F`);

      if (this.coordinator) {
        await this.coordinator.handleHAPThermostatEvent({
          deviceId,
          type: 'temperature',
          temperature: Math.round(fahrenheitValue)
        });
      }

      callback();
    } catch (error) {
      logger.error({ deviceId, err: error }, 'Error handling heating threshold change');
      callback(error as Error);
    }
  }

  /**
   * Updates HomeKit characteristics when SmartThings device state changes.
   * Includes cooldown period to prevent excessive updates.
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
      logger.info(`⏸️  HAP: Skipping update for ${deviceState.name} - cooldown period (${now - lastUpdate}ms since last update)`);
      return;
    }

    try {
      logger.info(`🔄 HAP: updateDeviceState called for ${deviceState.name} (${deviceId})`);
      logger.info(`   Caller stack: ${new Error().stack?.split('\n')[2]?.trim()}`);

      // Check if values actually changed
      const oldState = device.state;
      const tempChanged = Math.abs(oldState.currentTemperature - deviceState.currentTemperature) > 0.1;
      const setpointChanged = Math.abs(oldState.temperatureSetpoint - deviceState.temperatureSetpoint) > 0.1;
      const modeChanged = oldState.mode !== deviceState.mode;

      if (!tempChanged && !setpointChanged && !modeChanged) {
        logger.info({ deviceId }, '   No changes detected, skipping update');
        return;
      }

      logger.info({ deviceId, tempChanged, setpointChanged, modeChanged }, '   Changes detected');
      this.lastUpdateTime.set(deviceId, now);

      // Update characteristics if values have changed
      const service = device.thermostatService;

      // Update current temperature
      if (tempChanged) {
        const newTemp = this.fahrenheitToCelsius(deviceState.currentTemperature);
        logger.info(`   Updating CurrentTemperature: ${oldState.currentTemperature}°F -> ${deviceState.currentTemperature}°F (${newTemp}°C)`);
        service
          .getCharacteristic(Characteristic.CurrentTemperature)
          .updateValue(newTemp);
      }

      // Update target temperature
      if (setpointChanged) {
        const newSetpoint = this.fahrenheitToCelsius(deviceState.temperatureSetpoint);
        logger.info(`   Updating TargetTemperature: ${oldState.temperatureSetpoint}°F -> ${deviceState.temperatureSetpoint}°F (${newSetpoint}°C)`);
        service
          .getCharacteristic(Characteristic.TargetTemperature)
          .updateValue(newSetpoint);
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

      // Give it a moment before restarting
      setTimeout(() => {
        logger.info('♻️ Reinitializing bridge for fresh pairing...');
        this.initialize(this.coordinator!).then(() => {
          this.start().catch(error => {
            logger.error({ err: error }, 'Error restarting bridge after unpair');
          });
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