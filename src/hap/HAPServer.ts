import { Coordinator } from '@/coordinator/Coordinator';
import { DeviceState } from '@/types';
import * as QRCode from 'qrcode';
import { v4 as uuid } from 'uuid';
import * as path from 'path';

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
      // Use a consistent username (MAC address) for the bridge
      // This should remain the same across restarts to maintain accessory identity
      const bridgeUsername = process.env.HAP_BRIDGE_USERNAME || 'CC:22:3D:E3:CE:F6';

      // Publish the bridge to make it discoverable
      this.bridge.publish({
        username: bridgeUsername,
        port: this.port,
        pincode: this.pincode,
        category: Categories.BRIDGE
      });

      // Generate QR code after bridge is published
      await this.generateQrCodeAfterPublish();

      console.log('🌐 HAP Bridge published and ready for pairing');
    } catch (error) {
      console.error('❌ Error starting HAP server:', error);
      throw error;
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
    console.log(`HAP: Adding device ${deviceState.name} (${deviceId})`);

    if (!this.bridge) {
      console.error('❌ Cannot add device - HAP bridge not initialized');
      return;
    }

    // Check if device already exists to prevent duplicates
    if (this.devices.has(deviceId)) {
      console.log(`📋 HAP: Device ${deviceState.name} already exists, updating state instead`);
      await this.updateDeviceState(deviceId, deviceState);
      return;
    }

    try {
      // Create accessory for this thermostat with a consistent UUID
      // Using the deviceId ensures the same accessory UUID across restarts
      const accessoryUUID = HAP_uuid.generate(`smartthings-thermostat-${deviceId}`);
      const accessory = new Accessory(deviceState.name, accessoryUUID);

      // Set up accessory information
      accessory
        .getService(Service.AccessoryInformation)!
        .setCharacteristic(Characteristic.Manufacturer, 'SmartThings')
        .setCharacteristic(Characteristic.Model, 'HVAC Thermostat')
        .setCharacteristic(Characteristic.SerialNumber, deviceId)
        .setCharacteristic(Characteristic.FirmwareRevision, '1.0.0');

      // Add thermostat service
      const thermostatService = accessory.addService(Service.Thermostat, deviceState.name);

      // Set up thermostat characteristics
      await this.setupThermostatCharacteristics(thermostatService, deviceId, deviceState);

      // Add the accessory to the bridge
      this.bridge.addBridgedAccessory(accessory);

      // Store the device reference for updates
      this.devices.set(deviceId, {
        name: deviceState.name,
        type: 'thermostat',
        accessory: accessory,
        thermostatService: thermostatService,
        state: deviceState
      });

      console.log(`✅ HAP: Thermostat device ${deviceState.name} added to bridge`);
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
        this.handleTargetTemperatureChange(deviceId, value as number, callback);
      })
      .on('get', (callback: CharacteristicGetCallback) => {
        const device = this.devices.get(deviceId);
        if (device) {
          callback(null, this.fahrenheitToCelsius(device.state.temperatureSetpoint));
        } else {
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
        this.handleTargetModeChange(deviceId, value as number, callback);
      })
      .on('get', (callback: CharacteristicGetCallback) => {
        const device = this.devices.get(deviceId);
        if (device) {
          callback(null, this.mapModeToTargetState(device.state.mode));
        } else {
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
    try {
      const fahrenheitValue = this.celsiusToFahrenheit(celsiusValue);
      console.log(`HAP: Target temperature change for ${deviceId}: ${fahrenheitValue.toFixed(1)}°F`);

      if (this.coordinator) {
        await this.coordinator.handleHAPThermostatEvent({
          deviceId,
          type: 'temperature',
          temperature: Math.round(fahrenheitValue)
        });
      }

      // Update our local state
      const device = this.devices.get(deviceId);
      if (device) {
        device.state.temperatureSetpoint = Math.round(fahrenheitValue);
      }

      callback();
    } catch (error) {
      console.error(`Error handling target temperature change for ${deviceId}:`, error);
      callback(error as Error);
    }
  }

  private async handleTargetModeChange(
    deviceId: string,
    hapMode: number,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    try {
      const mode = this.mapTargetStateToMode(hapMode);
      console.log(`HAP: Target mode change for ${deviceId}: ${mode}`);

      if (this.coordinator) {
        await this.coordinator.handleHAPThermostatEvent({
          deviceId,
          type: 'mode',
          mode: mode
        });
      }

      // Update our local state
      const device = this.devices.get(deviceId);
      if (device) {
        device.state.mode = mode;
      }

      callback();
    } catch (error) {
      console.error(`Error handling target mode change for ${deviceId}:`, error);
      callback(error as Error);
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

    try {
      // Update characteristics if values have changed
      const service = device.thermostatService;

      // Update current temperature
      service
        .getCharacteristic(Characteristic.CurrentTemperature)
        .updateValue(this.fahrenheitToCelsius(deviceState.currentTemperature));

      // Update target temperature
      service
        .getCharacteristic(Characteristic.TargetTemperature)
        .updateValue(this.fahrenheitToCelsius(deviceState.temperatureSetpoint));

      // Update current heating/cooling state
      service
        .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
        .updateValue(this.mapModeToCurrentState(deviceState.mode));

      // Update target heating/cooling state
      service
        .getCharacteristic(Characteristic.TargetHeatingCoolingState)
        .updateValue(this.mapModeToTargetState(deviceState.mode));

      // Note: Threshold temperatures are set during initial setup and don't need polling updates

      // Update stored state
      device.state = deviceState;

      console.log(`HAP: Updated device state for ${deviceState.name}: ${deviceState.currentTemperature}°F, setpoint: ${deviceState.temperatureSetpoint}°F, mode: ${deviceState.mode}`);
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
    console.log(`✅ HAP: Device ${deviceId} removed from tracking`);
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