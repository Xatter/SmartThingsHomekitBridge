import { Coordinator } from '@/coordinator/Coordinator';
import { DeviceState } from '@/types';
import * as QRCode from 'qrcode';
import { v4 as uuid } from 'uuid';
import * as path from 'path';
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

  constructor(port: number = 51826, pincode: string = '942-37-286') {
    this.port = port;
    this.pincode = pincode;
    const persistPath = process.env.HAP_PERSIST_PATH || path.join(process.cwd(), 'persist');
    this.accessoryCache = new AccessoryCache(persistPath);
  }

  async initialize(coordinator: Coordinator): Promise<void> {
    this.coordinator = coordinator;

    try {
      console.log('HAP server initializing...');

      // Set up HAP-NodeJS storage path to persist accessory data
      const persistPath = process.env.HAP_PERSIST_PATH || path.join(process.cwd(), 'persist');
      console.log(`📁 Setting HAP storage path to: ${persistPath}`);
      HAPStorage.setCustomStoragePath(persistPath);

      // Create the bridge accessory with a consistent UUID
      const bridgeUUID = HAP_uuid.generate('SmartThings-Bridge-Main');
      this.bridge = new Bridge('SmartThings Bridge', bridgeUUID);

      // Listen for unpair event to clean up when removed from HomeKit
      this.bridge.on('unpaired' as any, () => {
        console.log('🔓 Bridge unpaired from HomeKit - cleaning up persistence');
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

      console.log('✅ HAP server initialized successfully');
      console.log(`🏠 HomeKit Bridge: Port ${this.port}`);
      console.log(`🔗 HomeKit Pairing Information:`);
      console.log(`   QR Code: Available in web interface`);
      console.log(`   Setup Code: ${this.setupCode}`);
      console.log(`   PIN: ${this.pincode}`);
      console.log('🎉 Ready for HomeKit pairing!');
    } catch (error) {
      console.error('❌ Error initializing HAP server:', error);
      console.error('💥 Cannot operate without functioning HomeKit protocol - terminating');
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
      console.error('Error generating QR code:', error);
      this.qrCode = null;
    }
  }

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
      console.log(`📡 Publishing bridge with username: ${bridgeUsername}`);
      console.log(`   Accessories in bridge: ${this.bridge.bridgedAccessories.length}`);

      this.bridge.publish({
        username: bridgeUsername,
        port: this.port,
        pincode: this.pincode,
        category: Categories.BRIDGE
      });

      // Add listener to detect configuration changes
      this.bridge.on('advertised' as any, () => {
        console.log('🔔 Bridge advertised event fired');
      });

      // Check if bridge has any event emitters we can listen to
      console.log(`   Bridge published successfully`);

      // Generate QR code after bridge is published
      await this.generateQrCodeAfterPublish();

      console.log('🌐 HAP Bridge published and ready for pairing');
    } catch (error) {
      console.error('❌ Error starting HAP server:', error);
      throw error;
    }
  }

  private async restoreCachedAccessories(): Promise<void> {
    const cachedAccessories = await this.accessoryCache.load();
    if (cachedAccessories.length === 0) {
      console.log('📭 No cached accessories to restore');
      return;
    }

    console.log(`🔄 Restoring ${cachedAccessories.length} cached accessories...`);
    const accessories: Accessory[] = [];

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
          console.log(`🔍 HomeKit IDENTIFY request for ${cached.name}`);
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
      this.setupThermostatCharacteristics(thermostatService, cached.deviceId, defaultState)
        .catch(error => {
          console.error(`Failed to setup characteristics for ${cached.name}:`, error);
        });

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

    // Add all accessories to the bridge at once
    if (accessories.length > 0 && this.bridge) {
      console.log(`🔧 Adding ${accessories.length} accessories to bridge...`);

      // Log current bridge state
      console.log(`   Bridge info before adding accessories:`);
      console.log(`   - Bridged accessories count: ${this.bridge.bridgedAccessories.length}`);

      this.bridge.addBridgedAccessories(accessories);
      this.hasRestoredAccessories = true;

      console.log(`✅ Restored ${accessories.length} accessories to bridge`);
      console.log(`   - Bridged accessories count after: ${this.bridge.bridgedAccessories.length}`);

      // Log accessory details
      accessories.forEach(acc => {
        console.log(`   - Accessory: ${acc.displayName} (UUID: ${acc.UUID})`);
      });
    }
  }

  private async generateQrCodeAfterPublish(): Promise<void> {
    try {
      if (!this.bridge) return;

      // Get the setup URI from the published bridge
      const setupURI = this.bridge.setupURI();

      this.qrCode = await QRCode.toString(setupURI, {
        type: 'svg',
        width: 256,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      });
    } catch (error) {
      console.error('Error generating QR code after publish:', error);
      this.qrCode = null;
    }
  }

  getQrCode(): string | null {
    return this.qrCode;
  }

  getPairingCode(): string | null {
    return this.setupCode;
  }

  async addDevice(deviceId: string, deviceState: DeviceState): Promise<void> {
    console.log(`HAP: Processing device ${deviceState.name} (${deviceId})`);

    if (!this.bridge) {
      console.error('❌ Cannot add device - HAP bridge not initialized');
      return;
    }

    // Check if device already exists in our tracking
    const existingDevice = this.devices.get(deviceId);
    if (existingDevice) {
      console.log(`📋 HAP: Device ${deviceState.name} already tracked`);

      // Just update the state, characteristics were already set up during restore
      await this.updateDeviceState(deviceId, deviceState);
      return;
    }

    // Check if this is a cached accessory that wasn't restored (shouldn't happen normally)
    if (this.accessoryCache.has(deviceId)) {
      console.log(`⚠️  HAP: Device ${deviceState.name} is cached but wasn't restored`);
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
          console.log(`🔍 HomeKit IDENTIFY request for ${deviceState.name}`);
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

      console.log(`✅ HAP: Thermostat device ${deviceState.name} added to bridge and cached`);
      console.log(`   Initial state: ${deviceState.currentTemperature}°F, setpoint: ${deviceState.temperatureSetpoint}°F, mode: ${deviceState.mode}`);
    } catch (error) {
      console.error(`❌ Failed to add device ${deviceState.name}:`, error);
      throw error;
    }
  }

  private async setupThermostatCharacteristics(
    thermostatService: Service,
    deviceId: string,
    deviceState: DeviceState
  ): Promise<void> {
    console.log(`⚙️  Setting up characteristics for ${deviceState.name} (${deviceId})`);
    console.log(`   State: temp=${deviceState.currentTemperature}°F, setpoint=${deviceState.temperatureSetpoint}°F, mode=${deviceState.mode}`);
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
        console.log(`🏠 HomeKit SET TargetTemperature for ${deviceId}: ${value}°C`);
        this.handleTargetTemperatureChange(deviceId, value as number, callback);
      })
      .on('get', (callback: CharacteristicGetCallback) => {
        console.log(`🏠 HomeKit GET TargetTemperature for ${deviceId}`);
        const device = this.devices.get(deviceId);
        if (device) {
          const temp = this.fahrenheitToCelsius(device.state.temperatureSetpoint);
          console.log(`   Returning: ${temp}°C (${device.state.temperatureSetpoint}°F)`);
          callback(null, temp);
        } else {
          console.log(`   ❌ Device not found!`);
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
        console.log(`🏠 HomeKit SET TargetHeatingCoolingState for ${deviceId}: ${value}`);
        this.handleTargetModeChange(deviceId, value as number, callback);
      })
      .on('get', (callback: CharacteristicGetCallback) => {
        console.log(`🏠 HomeKit GET TargetHeatingCoolingState for ${deviceId}`);
        const device = this.devices.get(deviceId);
        if (device) {
          const mode = this.mapModeToTargetState(device.state.mode);
          console.log(`   Returning: ${mode} (${device.state.mode})`);
          callback(null, mode);
        } else {
          console.log(`   ❌ Device not found!`);
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
    console.log(`HAP: Target temperature change for ${deviceId}: ${fahrenheitValue.toFixed(1)}°F`);

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
        console.error(`Error updating SmartThings for ${deviceId}:`, error);
      });
    }
  }

  private async handleTargetModeChange(
    deviceId: string,
    hapMode: number,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    const mode = this.mapTargetStateToMode(hapMode);
    console.log(`HAP: Target mode change for ${deviceId}: ${mode}`);

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
        console.error(`Error updating SmartThings for ${deviceId}:`, error);
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
      console.log(`HAP: Cooling threshold change for ${deviceId}: ${fahrenheitValue.toFixed(1)}°F`);

      if (this.coordinator) {
        await this.coordinator.handleHAPThermostatEvent({
          deviceId,
          type: 'temperature',
          temperature: Math.round(fahrenheitValue)
        });
      }

      callback();
    } catch (error) {
      console.error(`Error handling cooling threshold change for ${deviceId}:`, error);
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
      console.log(`HAP: Heating threshold change for ${deviceId}: ${fahrenheitValue.toFixed(1)}°F`);

      if (this.coordinator) {
        await this.coordinator.handleHAPThermostatEvent({
          deviceId,
          type: 'temperature',
          temperature: Math.round(fahrenheitValue)
        });
      }

      callback();
    } catch (error) {
      console.error(`Error handling heating threshold change for ${deviceId}:`, error);
      callback(error as Error);
    }
  }

  async updateDeviceState(deviceId: string, deviceState: DeviceState): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) {
      console.warn(`HAP: Device ${deviceId} not found for state update`);
      return;
    }

    // Check for cooldown period
    const lastUpdate = this.lastUpdateTime.get(deviceId) || 0;
    const now = Date.now();
    if (now - lastUpdate < this.UPDATE_COOLDOWN_MS) {
      console.log(`⏸️  HAP: Skipping update for ${deviceState.name} - cooldown period (${now - lastUpdate}ms since last update)`);
      return;
    }

    try {
      console.log(`🔄 HAP: updateDeviceState called for ${deviceState.name} (${deviceId})`);
      console.log(`   Caller stack: ${new Error().stack?.split('\n')[2]?.trim()}`);

      // Check if values actually changed
      const oldState = device.state;
      const tempChanged = Math.abs(oldState.currentTemperature - deviceState.currentTemperature) > 0.1;
      const setpointChanged = Math.abs(oldState.temperatureSetpoint - deviceState.temperatureSetpoint) > 0.1;
      const modeChanged = oldState.mode !== deviceState.mode;

      if (!tempChanged && !setpointChanged && !modeChanged) {
        console.log(`   No changes detected, skipping update`);
        return;
      }

      console.log(`   Changes detected: temp=${tempChanged}, setpoint=${setpointChanged}, mode=${modeChanged}`);
      this.lastUpdateTime.set(deviceId, now);

      // Update characteristics if values have changed
      const service = device.thermostatService;

      // Update current temperature
      if (tempChanged) {
        const newTemp = this.fahrenheitToCelsius(deviceState.currentTemperature);
        console.log(`   Updating CurrentTemperature: ${oldState.currentTemperature}°F -> ${deviceState.currentTemperature}°F (${newTemp}°C)`);
        service
          .getCharacteristic(Characteristic.CurrentTemperature)
          .updateValue(newTemp);
      }

      // Update target temperature
      if (setpointChanged) {
        const newSetpoint = this.fahrenheitToCelsius(deviceState.temperatureSetpoint);
        console.log(`   Updating TargetTemperature: ${oldState.temperatureSetpoint}°F -> ${deviceState.temperatureSetpoint}°F (${newSetpoint}°C)`);
        service
          .getCharacteristic(Characteristic.TargetTemperature)
          .updateValue(newSetpoint);
      }

      // Update current heating/cooling state
      if (modeChanged) {
        const currentState = this.mapModeToCurrentState(deviceState.mode);
        const targetState = this.mapModeToTargetState(deviceState.mode);
        console.log(`   Updating HeatingCoolingState: ${oldState.mode} -> ${deviceState.mode} (current=${currentState}, target=${targetState})`);

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

      console.log(`✅ HAP: Updated device state for ${deviceState.name}`);
    } catch (error) {
      console.error(`❌ Failed to update HAP device state for ${deviceState.name}:`, error);
    }
  }

  async removeDevice(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (device && this.bridge) {
      try {
        this.bridge.removeBridgedAccessory(device.accessory);
        console.log(`✅ HAP: Device ${deviceId} removed from bridge`);
      } catch (error) {
        console.error(`Error removing device ${deviceId} from HAP bridge:`, error);
      }
    }

    this.devices.delete(deviceId);
    await this.accessoryCache.remove(deviceId);
    console.log(`✅ HAP: Device ${deviceId} removed from tracking and cache`);
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

  getDeviceStates(): Map<string, DeviceState> {
    const states = new Map<string, DeviceState>();
    for (const [deviceId, device] of this.devices) {
      states.set(deviceId, device.state);
    }
    return states;
  }

  /**
   * Get list of currently bridged device IDs
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
      console.log('🧹 Cleaning up after unpair...');

      // Clear the cached accessories
      await this.accessoryCache.save([]);
      console.log('   ✓ Cleared cached accessories');

      // Clear the devices map
      this.devices.clear();
      console.log('   ✓ Cleared device map');

      // Delete persistence files to allow re-pairing
      const persistPath = process.env.HAP_PERSIST_PATH || path.join(process.cwd(), 'persist');
      const bridgeUsername = process.env.HAP_BRIDGE_USERNAME || 'CC:22:3D:E3:CE:F6';
      const cleanUsername = bridgeUsername.replace(/:/g, '');

      try {
        // Delete AccessoryInfo file
        await fs.unlink(path.join(persistPath, `AccessoryInfo.${cleanUsername}.json`));
        console.log('   ✓ Deleted AccessoryInfo');
      } catch (error) {
        console.log('   - AccessoryInfo already deleted or not found');
      }

      try {
        // Delete IdentifierCache file
        await fs.unlink(path.join(persistPath, `IdentifierCache.${cleanUsername}.json`));
        console.log('   ✓ Deleted IdentifierCache');
      } catch (error) {
        console.log('   - IdentifierCache already deleted or not found');
      }

      console.log('✅ Bridge is ready to be re-paired');

      // Restart the bridge to reinitialize
      console.log('🔄 Restarting bridge...');
      if (this.bridge) {
        this.bridge.unpublish();
      }

      // Give it a moment before restarting
      setTimeout(() => {
        console.log('♻️ Reinitializing bridge for fresh pairing...');
        this.initialize(this.coordinator!).then(() => {
          this.start().catch(error => {
            console.error('Error restarting bridge after unpair:', error);
          });
        });
      }, 2000);

    } catch (error) {
      console.error('Error handling unpair:', error);
    }
  }

  async stop(): Promise<void> {
    if (this.bridge) {
      try {
        this.bridge.unpublish();
        console.log('HAP bridge unpublished');
      } catch (error) {
        console.error('Error unpublishing HAP bridge:', error);
      }
      this.bridge = null;
    }

    console.log('HAP server stopped');
  }
}