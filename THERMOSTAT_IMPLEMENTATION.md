# Matter.js Thermostat Implementation Guide

This document provides a complete implementation guide for creating fully functional Matter thermostat devices using @matter/main v0.12.6 with bidirectional state management and event handling.

## Overview

The implementation provides:
- ✅ Proper thermostat device initialization with cluster attributes
- ✅ Bidirectional communication between Matter and SmartThings
- ✅ Automatic temperature conversion (°F ↔ °C)
- ✅ Event handlers for setpoint and mode changes
- ✅ Dynamic attribute updates from external state changes
- ✅ Full HomeKit and Google Home compatibility

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   HomeKit/      │    │   Matter.js      │    │  SmartThings    │
│   Google Home   │◄──►│   Thermostat     │◄──►│     API         │
│   Controllers   │    │   Device         │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
       │                        │                        │
       │ Matter Protocol        │ State Management       │ REST API
       │ (°C * 100)            │ (°F conversion)        │ (°F)
       │                        │                        │
   Commands/Events         Cluster Attributes      Device Control
```

## Core Implementation

### 1. Device Creation with Initial State

```typescript
// Create thermostat with proper initial cluster attributes
const initialState = {
  thermostat: {
    localTemperature: celsiusToMatterTemp(currentTempC),
    systemMode: mapThermostatMode(deviceState.mode),
    occupiedCoolingSetpoint: celsiusToMatterTemp(setpointTempC),
    occupiedHeatingSetpoint: celsiusToMatterTemp(setpointTempC),
    controlSequenceOfOperation: 4, // CoolingAndHeating
    thermostatRunningState: 0, // Idle
    minHeatSetpointLimit: celsiusToMatterTemp(10),
    maxHeatSetpointLimit: celsiusToMatterTemp(35),
    minCoolSetpointLimit: celsiusToMatterTemp(10),
    maxCoolSetpointLimit: celsiusToMatterTemp(35),
  }
};

const thermostatDevice = new Endpoint(ThermostatDeviceWithCluster, {
  id: deviceId,
  ...initialState
});
```

### 2. Event Handler Setup

```typescript
// Handle setpoint changes from HomeKit/Google Home
thermostatCluster.events.occupiedCoolingSetpointChange.on((value: number) => {
  handleSetpointChange(deviceId, 'cool', value);
});

// Handle mode changes
thermostatCluster.events.systemModeChange.on((value: number) => {
  handleModeChange(deviceId, value);
});

// Handle raise/lower commands
thermostatCluster.commands.setpointRaiseLower.addListener((request: any) => {
  handleSetpointRaiseLower(deviceId, request);
});
```

### 3. Temperature Conversion

```typescript
// Matter uses 1/100ths of degrees Celsius
private celsiusToMatterTemp(celsius: number): number {
  return Math.round(celsius * 100);
}

private fahrenheitToCelsius(fahrenheit: number): number {
  return (fahrenheit - 32) * 5 / 9;
}

// SmartThings uses Fahrenheit
private celsiusToFahrenheit(celsius: number): number {
  return (celsius * 9 / 5) + 32;
}
```

### 4. Dynamic State Updates

```typescript
// Update Matter attributes when SmartThings state changes
private async updateClusterAttribute(cluster: any, attributeName: string, value: any) {
  if (cluster && cluster.attributes && cluster.attributes[attributeName]) {
    cluster.attributes[attributeName].local = value;
    if (cluster.triggerAttributeUpdate) {
      cluster.triggerAttributeUpdate(attributeName, value);
    }
  }
}
```

## Matter Thermostat Cluster Attributes

| Attribute ID | Name | Type | Description |
|--------------|------|------|-------------|
| 0x0000 | LocalTemperature | int16s | Current temperature (°C * 100) |
| 0x001C | SystemMode | enum8 | Operating mode (0=Off, 1=Auto, 3=Cool, 4=Heat) |
| 0x0011 | OccupiedCoolingSetpoint | int16s | Cooling setpoint (°C * 100) |
| 0x0012 | OccupiedHeatingSetpoint | int16s | Heating setpoint (°C * 100) |
| 0x001B | ControlSequenceOfOperation | enum8 | Capabilities (4=CoolingAndHeating) |
| 0x0029 | ThermostatRunningState | bitmap16 | Current operation state |

## System Mode Mapping

| SmartThings | Matter | Description |
|-------------|--------|-------------|
| 'off' | 0 | System off |
| 'auto' | 1 | Automatic mode |
| 'cool' | 3 | Cooling mode |
| 'heat' | 4 | Heating mode |
| 'emergency heat' | 5 | Emergency heating |

## Event Handling Flow

### 1. HomeKit/Google Home → SmartThings

```typescript
// User changes setpoint in HomeKit
HomeKit Command → Matter Event → handleSetpointChange() →
SmartThings API → Device Updated

// User changes mode in Google Home
Google Command → Matter Event → handleModeChange() →
SmartThings API → Device Updated
```

### 2. SmartThings → HomeKit/Google Home

```typescript
// Device state changes in SmartThings
SmartThings Polling → updateDeviceStates() →
updateClusterAttribute() → Matter Attribute Change →
HomeKit/Google Home Updated
```

## Temperature Conversion Examples

| Fahrenheit | Celsius | Matter Value |
|------------|---------|--------------|
| 68°F | 20.0°C | 2000 |
| 72°F | 22.2°C | 2222 |
| 75°F | 23.9°C | 2389 |
| 78°F | 25.6°C | 2556 |

## Error Handling

The implementation includes comprehensive error handling:

- **Cluster Access Errors**: Graceful fallback if cluster behaviors aren't available
- **Temperature Conversion**: Safe handling of invalid temperature values
- **Event Handler Registration**: Warning logs for missing event handlers
- **API Communication**: Retry logic for SmartThings API calls

## Usage Example

```typescript
import { MatterServer } from './src/matter/MatterServer';
import { DeviceState } from './src/types';

// Initialize Matter server
const matterServer = new MatterServer(5540);
await matterServer.initialize(coordinator);

// Add thermostat device
const deviceState: DeviceState = {
  id: 'thermostat-001',
  name: 'Living Room Thermostat',
  currentTemperature: 72.0, // °F
  temperatureSetpoint: 75.0, // °F
  mode: 'cool',
  lightOn: false,
  lastUpdated: new Date()
};

await matterServer.addDevice('thermostat-001', deviceState);
```

## Compatibility

- **Matter Specification**: 1.0+
- **HomeKit**: Full compatibility with temperature control
- **Google Home**: Full compatibility with thermostat control
- **SmartThings**: All HVAC device types supported
- **@matter/main**: v0.12.6+

## Benefits

1. **Full Bidirectional Control**: Changes in HomeKit sync to SmartThings and vice versa
2. **Proper Temperature Handling**: Automatic °F ↔ °C conversion
3. **Real-time Updates**: Immediate synchronization across all platforms
4. **Standards Compliant**: Follows Matter specification exactly
5. **Production Ready**: Comprehensive error handling and logging

## Troubleshooting

### Common Issues

1. **Temperature Not Updating**: Check temperature conversion and cluster attribute access
2. **Commands Not Working**: Verify event handler registration and cluster behaviors
3. **Mode Changes Ignored**: Confirm mode mapping and SmartThings API connectivity
4. **Setpoint Limits**: Ensure min/max limits are set appropriately

### Debug Logging

Enable detailed logging to troubleshoot issues:

```typescript
console.log('Matter device state:', device.thermostatCluster.attributes);
console.log('Temperature conversion:', fahrenheitToCelsius(75)); // Should be ~23.89
console.log('Mode mapping:', mapThermostatMode('cool')); // Should be 3
```

This implementation provides a complete, production-ready Matter thermostat device with full SmartThings integration and HomeKit/Google Home compatibility.