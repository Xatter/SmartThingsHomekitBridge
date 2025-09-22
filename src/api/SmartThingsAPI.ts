import { SmartThingsClient, BearerTokenAuthenticator } from '@smartthings/core-sdk';
import { SmartThingsAuthentication } from '@/auth/SmartThingsAuthentication';
import { SmartThingsDevice, DeviceState, ThermostatCapabilities } from '@/types';

export class SmartThingsAPI {
  private client: SmartThingsClient | null = null;
  private readonly auth: SmartThingsAuthentication;

  constructor(auth: SmartThingsAuthentication) {
    this.auth = auth;
  }

  hasAuth(): boolean {
    return this.auth.hasAuth();
  }

  private async getClient(): Promise<SmartThingsClient | null> {
    if (!await this.auth.ensureValidToken()) {
      return null;
    }

    if (!this.client) {
      const token = this.auth.getAccessToken();
      if (!token) {
        return null;
      }

      this.client = new SmartThingsClient(new BearerTokenAuthenticator(token));
    }

    return this.client;
  }

  async getAllDevices(): Promise<SmartThingsDevice[]> {
    const client = await this.getClient();
    if (!client) {
      throw new Error('No authenticated SmartThings client available');
    }

    try {
      const devices = await client.devices.list();
      return devices.map((device: any) => ({
        deviceId: device.deviceId!,
        name: device.name!,
        label: device.label!,
        manufacturerName: device.manufacturerName || '',
        presentationId: device.presentationId || '',
        deviceTypeName: device.deviceTypeName || '',
        capabilities: device.capabilities || [],
        components: device.components || [],
      }));
    } catch (error) {
      console.error('Error fetching devices:', error);
      throw error;
    }
  }

  async getFilteredDevices(): Promise<SmartThingsDevice[]> {
    const allDevices = await this.getAllDevices();

    return allDevices.filter(device => {
      const capabilities = this.extractThermostatCapabilities(device);
      return capabilities.temperatureMeasurement ||
             capabilities.thermostat ||
             capabilities.thermostatCoolingSetpoint ||
             capabilities.thermostatHeatingSetpoint;
    });
  }

  private extractThermostatCapabilities(device: SmartThingsDevice): ThermostatCapabilities {
    const allCapabilities = device.capabilities.map(cap => cap.id);

    return {
      temperatureMeasurement: allCapabilities.includes('temperatureMeasurement'),
      thermostat: allCapabilities.includes('thermostat'),
      thermostatCoolingSetpoint: allCapabilities.includes('thermostatCoolingSetpoint'),
      thermostatHeatingSetpoint: allCapabilities.includes('thermostatHeatingSetpoint'),
      thermostatMode: allCapabilities.includes('thermostatMode'),
      thermostatOperatingState: allCapabilities.includes('thermostatOperatingState'),
      switch: allCapabilities.includes('switch'),
    };
  }

  async getDeviceStatus(deviceId: string): Promise<DeviceState | null> {
    const client = await this.getClient();
    if (!client) {
      return null;
    }

    try {
      const status = await client.devices.getStatus(deviceId);
      const device = await client.devices.get(deviceId);

      const temperature = Number(status.components?.main?.temperatureMeasurement?.temperature?.value) || 0;
      const coolingSetpoint = Number(status.components?.main?.thermostatCoolingSetpoint?.coolingSetpoint?.value) || 0;
      const heatingSetpoint = Number(status.components?.main?.thermostatHeatingSetpoint?.heatingSetpoint?.value) || 0;
      const mode = status.components?.main?.thermostatMode?.thermostatMode?.value || 'off';
      const switchStatus = status.components?.main?.switch?.switch?.value || 'off';

      const temperatureSetpoint = mode === 'cool' ? coolingSetpoint : heatingSetpoint;

      return {
        id: deviceId,
        name: device.name || device.label || deviceId,
        temperatureSetpoint,
        currentTemperature: temperature,
        mode: mode as 'heat' | 'cool' | 'auto' | 'off',
        lightOn: switchStatus === 'on',
        lastUpdated: new Date(),
      };
    } catch (error) {
      console.error(`Error getting device status for ${deviceId}:`, error);
      return null;
    }
  }

  async setTemperature(deviceId: string, temperature: number, mode: 'heat' | 'cool'): Promise<boolean> {
    const client = await this.getClient();
    if (!client) {
      return false;
    }

    try {
      const capability = mode === 'cool' ? 'thermostatCoolingSetpoint' : 'thermostatHeatingSetpoint';
      const command = mode === 'cool' ? 'setCoolingSetpoint' : 'setHeatingSetpoint';

      await client.devices.executeCommand(deviceId, {
        component: 'main',
        capability,
        command,
        arguments: [temperature],
      });

      console.log(`Set ${mode} setpoint to ${temperature}°F for device ${deviceId}`);
      return true;
    } catch (error) {
      console.error(`Error setting temperature for device ${deviceId}:`, error);
      return false;
    }
  }

  async setMode(deviceId: string, mode: 'heat' | 'cool' | 'auto' | 'off'): Promise<boolean> {
    const client = await this.getClient();
    if (!client) {
      return false;
    }

    try {
      await client.devices.executeCommand(deviceId, {
        component: 'main',
        capability: 'thermostatMode',
        command: 'setThermostatMode',
        arguments: [mode],
      });

      console.log(`Set mode to ${mode} for device ${deviceId}`);
      return true;
    } catch (error) {
      console.error(`Error setting mode for device ${deviceId}:`, error);
      return false;
    }
  }

  async turnLightOff(deviceId: string): Promise<boolean> {
    const client = await this.getClient();
    if (!client) {
      return false;
    }

    try {
      await client.devices.executeCommand(deviceId, {
        component: 'main',
        capability: 'switch',
        command: 'off',
        arguments: [],
      });

      console.log(`Turned off light for device ${deviceId}`);
      return true;
    } catch (error) {
      console.error(`Error turning off light for device ${deviceId}:`, error);
      return false;
    }
  }

  async turnLightOn(deviceId: string): Promise<boolean> {
    const client = await this.getClient();
    if (!client) {
      return false;
    }

    try {
      await client.devices.executeCommand(deviceId, {
        component: 'main',
        capability: 'switch',
        command: 'on',
        arguments: [],
      });

      console.log(`Turned on light for device ${deviceId}`);
      return true;
    } catch (error) {
      console.error(`Error turning on light for device ${deviceId}:`, error);
      return false;
    }
  }

  invalidateClient(): void {
    this.client = null;
  }
}