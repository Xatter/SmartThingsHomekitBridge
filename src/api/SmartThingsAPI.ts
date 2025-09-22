import { SmartThingsClient, BearerTokenAuthenticator } from '@smartthings/core-sdk';
import { SmartThingsAuthentication } from '@/auth/SmartThingsAuthentication';
import { SmartThingsDevice, DeviceState, ThermostatCapabilities, UnifiedDevice } from '@/types';

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
      console.log('📡 Fetching device list from SmartThings...');
      const deviceList = await client.devices.list();
      console.log(`📱 Found ${deviceList.length} devices, fetching detailed info...`);

      // Fetch detailed information for each device
      const devicePromises = deviceList.map(async (deviceSummary: any) => {
        try {
          console.log(`🔍 Fetching details for device: ${deviceSummary.name || deviceSummary.deviceId}`);
          const deviceDetails = await client.devices.get(deviceSummary.deviceId);
          console.log(`🔍 Device ${deviceSummary.deviceId} details:`, {
            capabilities: (deviceDetails as any).capabilities?.length || 0,
            components: (deviceDetails as any).components?.length || 0,
            rawCapabilities: (deviceDetails as any).capabilities?.map((cap: any) => cap.id).join(', ') || 'none',
            componentCapabilities: (deviceDetails as any).components?.map((comp: any) =>
              `${comp.id}: [${comp.capabilities?.map((cap: any) => cap.id).join(', ') || 'none'}]`
            ).join(' | ') || 'none'
          });
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
          console.error(`❌ Error fetching details for device ${deviceSummary.deviceId}:`, error);
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
      console.log('✅ Finished fetching detailed device information');
      return devices;
    } catch (error) {
      console.error('❌ Error fetching devices:', error);
      throw error;
    }
  }

  async getFilteredDevices(): Promise<SmartThingsDevice[]> {
    const allDevices = await this.getAllDevices();

    console.log('🔍 Analyzing all devices for HVAC capabilities:');
    allDevices.forEach(device => {
      const capabilities = this.extractThermostatCapabilities(device);
      const capabilityList = device.capabilities.map(cap => cap.id).join(', ');
      console.log(`📱 ${device.name}:`);
      console.log(`   ID: ${device.deviceId}`);
      console.log(`   Capabilities: ${capabilityList}`);
      console.log(`   HVAC Analysis:`, capabilities);

      const hasStandardThermostat = capabilities.temperatureMeasurement ||
                                    capabilities.thermostat ||
                                    capabilities.thermostatCoolingSetpoint ||
                                    capabilities.thermostatHeatingSetpoint;

      const hasSamsungAC = capabilities.airConditionerMode ||
                           capabilities.customThermostatSetpointControl;

      console.log(`   Standard Thermostat: ${hasStandardThermostat}`);
      console.log(`   Samsung AC: ${hasSamsungAC}`);
      console.log(`   Is HVAC: ${hasStandardThermostat || hasSamsungAC}`);
      console.log('');
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

  async getDeviceStatus(deviceId: string): Promise<DeviceState | null> {
    const client = await this.getClient();
    if (!client) {
      return null;
    }

    try {
      const status = await client.devices.getStatus(deviceId);
      const device = await client.devices.get(deviceId);

      // Get temperature measurement
      const temperature = Number(status.components?.main?.temperatureMeasurement?.temperature?.value) || 0;

      // Try standard thermostat setpoints first
      let coolingSetpoint = Number(status.components?.main?.thermostatCoolingSetpoint?.coolingSetpoint?.value) || 0;
      const heatingSetpoint = Number(status.components?.main?.thermostatHeatingSetpoint?.heatingSetpoint?.value) || 0;

      // Get mode - try thermostat mode first, then air conditioner mode
      let mode = status.components?.main?.thermostatMode?.thermostatMode?.value ||
                 status.components?.main?.airConditionerMode?.airConditionerMode?.value || 'off';

      // For Samsung air conditioners, convert modes
      if (mode === 'wind') mode = 'cool'; // Samsung uses 'wind' for fan mode, treat as cool
      if (mode === 'dry') mode = 'cool';  // Samsung dry mode, treat as cool

      const switchStatus = status.components?.main?.switch?.switch?.value || 'off';

      // For Samsung ACs: if switch is off, the device mode should be 'off' regardless of airConditionerMode
      if (switchStatus === 'off' && status.components?.main?.airConditionerMode) {
        mode = 'off';
      }

      // If no standard setpoints, use the cooling setpoint (Samsung units primarily use cooling)
      const temperatureSetpoint = mode === 'cool' ? coolingSetpoint : (heatingSetpoint || coolingSetpoint);

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
      // Try standard thermostat mode first
      try {
        await client.devices.executeCommand(deviceId, {
          component: 'main',
          capability: 'thermostatMode',
          command: 'setThermostatMode',
          arguments: [mode],
        });
        console.log(`Set thermostat mode to ${mode} for device ${deviceId}`);
        return true;
      } catch (thermostatError) {
        // If thermostat mode fails, try air conditioner mode for Samsung devices
        console.log(`Thermostat mode failed, trying air conditioner mode for device ${deviceId}`);

        // Handle Samsung AC "off" mode specially - use switch capability
        if (mode === 'off') {
          await client.devices.executeCommand(deviceId, {
            component: 'main',
            capability: 'switch',
            command: 'off',
            arguments: [],
          });
          console.log(`Turned Samsung AC off using switch capability for device ${deviceId}`);
          return true;
        } else {
          // For heat/cool/auto modes, use airConditionerMode
          // First turn the device on if it's not already on
          await client.devices.executeCommand(deviceId, {
            component: 'main',
            capability: 'switch',
            command: 'on',
            arguments: [],
          });

          await client.devices.executeCommand(deviceId, {
            component: 'main',
            capability: 'airConditionerMode',
            command: 'setAirConditionerMode',
            arguments: [mode],
          });
          console.log(`Set Samsung AC mode to ${mode} for device ${deviceId}`);
          return true;
        }
      }
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
          console.error(`Error getting state for device ${device.deviceId}:`, error);
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

    const hasStandardThermostat = (caps: ThermostatCapabilities) =>
      caps.temperatureMeasurement || caps.thermostat ||
      caps.thermostatCoolingSetpoint || caps.thermostatHeatingSetpoint;

    const hasSamsungAC = (caps: ThermostatCapabilities) =>
      caps.airConditionerMode || caps.customThermostatSetpointControl;

    return devices.filter(device => {
      if (device.name.toLowerCase().includes('ecobee')) return false;
      const caps = device.thermostatCapabilities;
      return hasStandardThermostat(caps) || hasSamsungAC(caps);
    });
  }
}