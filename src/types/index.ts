export interface DeviceState {
  id: string;
  name: string;
  temperatureSetpoint: number;
  currentTemperature: number;
  mode: 'heat' | 'cool' | 'auto' | 'off';
  lightOn: boolean;
  lastUpdated: Date;
}

export interface CoordinatorState {
  pairedDevices: string[];
  averageTemperature: number;
  currentMode: 'heat' | 'cool' | 'auto' | 'off';
  deviceStates: Map<string, DeviceState>;
}

export interface SmartThingsAuthToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
  scope: string;
}

export interface SmartThingsDevice {
  deviceId: string;
  name: string;
  label: string;
  manufacturerName: string;
  presentationId: string;
  deviceTypeName: string;
  capabilities: Array<{
    id: string;
    version: number;
  }>;
  components: Array<{
    id: string;
    capabilities: Array<{
      id: string;
      version: number;
    }>;
  }>;
}

export interface ThermostatCapabilities {
  temperatureMeasurement?: boolean;
  thermostat?: boolean;
  thermostatCoolingSetpoint?: boolean;
  thermostatHeatingSetpoint?: boolean;
  thermostatMode?: boolean;
  thermostatOperatingState?: boolean;
  switch?: boolean;
  // Samsung air conditioner specific capabilities
  airConditionerMode?: boolean;
  airConditionerFanMode?: boolean;
  customThermostatSetpointControl?: boolean;
}

export interface MatterThermostatEvent {
  deviceId: string;
  type: 'temperature' | 'mode' | 'both';
  temperature?: number;
  mode?: 'heat' | 'cool' | 'auto' | 'off';
}