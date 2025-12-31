# SmartThings HomeKit Bridge - Device Specification

This document describes the device behaviors, capabilities, and command mappings used by the bridge to translate between HomeKit and SmartThings.

## Overview

The bridge supports two primary device types:
1. **Traditional Thermostats** (e.g., ecobee) - Use standard `thermostatMode` capability
2. **Samsung Room Air Conditioners** - Use `airConditionerMode` + `switch` capabilities

## HomeKit Thermostat States

HomeKit uses numeric values for heating/cooling states:

| HomeKit Value | Mode |
|---------------|------|
| 0 | Off |
| 1 | Heat |
| 2 | Cool |
| 3 | Auto |

## Device Type Detection

The bridge detects device type by checking `thermostatCapabilities`:

```typescript
const usesAirConditionerMode = caps.airConditionerMode && !caps.thermostatMode;
```

- If device has `airConditionerMode` but NOT `thermostatMode` → Samsung AC
- Otherwise → Traditional thermostat

---

## Traditional Thermostats

### Capabilities Used
| Capability | Purpose |
|------------|---------|
| `thermostatMode` | Set mode (heat/cool/auto/off) |
| `thermostatHeatingSetpoint` | Set heating temperature target |
| `thermostatCoolingSetpoint` | Set cooling temperature target |
| `temperatureMeasurement` | Read current temperature |

### Mode Mapping
| HomeKit Mode | SmartThings Command |
|--------------|---------------------|
| Off | `thermostatMode:setThermostatMode:off` |
| Heat | `thermostatMode:setThermostatMode:heat` |
| Cool | `thermostatMode:setThermostatMode:cool` |
| Auto | `thermostatMode:setThermostatMode:auto` |

### Temperature Setpoint Commands
| Current Mode | Command |
|--------------|---------|
| Heat | `thermostatHeatingSetpoint:setHeatingSetpoint:<temp>` |
| Cool | `thermostatCoolingSetpoint:setCoolingSetpoint:<temp>` |
| Auto | Both heating and cooling setpoints |
| Off | No temperature command sent |

---

## Samsung Room Air Conditioners

### Key Differences from Traditional Thermostats

1. **No "off" mode** - Samsung ACs use `switch` capability for on/off
2. **No heating setpoint** - Uses `thermostatCoolingSetpoint` for ALL temperature changes
3. **Additional modes** - Supports `dry` and `wind` modes (mapped to `cool` in HomeKit)

### Capabilities Used
| Capability | Purpose |
|------------|---------|
| `switch` | Turn device on/off |
| `airConditionerMode` | Set mode (heat/cool/auto/dry/wind) |
| `thermostatCoolingSetpoint` | Set temperature target (all modes) |
| `temperatureMeasurement` | Read current temperature |
| `airConditionerFanMode` | Fan speed control |

### Supported AC Modes
```json
["auto", "cool", "dry", "wind", "heat"]
```

**Note:** There is NO "off" in the supported modes list.

### Mode Mapping
| HomeKit Mode | SmartThings Commands |
|--------------|----------------------|
| Off | `switch:off` |
| Heat | `switch:on` (if off) + `airConditionerMode:setAirConditionerMode:heat` |
| Cool | `switch:on` (if off) + `airConditionerMode:setAirConditionerMode:cool` |
| Auto | `switch:on` (if off) + `airConditionerMode:setAirConditionerMode:auto` |

### Temperature Setpoint Commands
| Current Mode | Command |
|--------------|---------|
| Heat | `thermostatCoolingSetpoint:setCoolingSetpoint:<temp>` |
| Cool | `thermostatCoolingSetpoint:setCoolingSetpoint:<temp>` |
| Auto | `thermostatCoolingSetpoint:setCoolingSetpoint:<temp>` |

**Important:** Samsung ACs do NOT have `thermostatHeatingSetpoint`. The `thermostatCoolingSetpoint` capability is used for ALL temperature changes regardless of the current mode.

### Samsung AC Mode Translations
| SmartThings Mode | HomeKit Mapping |
|------------------|-----------------|
| heat | Heat |
| cool | Cool |
| auto | Auto |
| dry | Cool (no direct equivalent) |
| wind | Cool (fan-only, no direct equivalent) |

### Switch State Handling

When changing modes on a Samsung AC:

1. **Turning Off:**
   - Send `switch:off`
   - Do NOT send `airConditionerMode:setAirConditionerMode:off` (invalid)

2. **Turning On (from off):**
   - First send `switch:on`
   - Then send `airConditionerMode:setAirConditionerMode:<mode>`

3. **Changing Mode (already on):**
   - Only send `airConditionerMode:setAirConditionerMode:<mode>`

---

## State Tracking

### DeviceState Properties
| Property | Type | Description |
|----------|------|-------------|
| `id` | string | SmartThings device ID |
| `name` | string | Device display name |
| `currentTemperature` | number | Current temperature (°F) |
| `temperatureSetpoint` | number | Active setpoint (°F) |
| `heatingSetpoint` | number? | Heating setpoint (traditional thermostats) |
| `coolingSetpoint` | number? | Cooling setpoint (all devices) |
| `mode` | string | Current mode: heat/cool/auto/off |
| `switchState` | string? | Switch state: on/off (Samsung ACs) |
| `lightOn` | boolean | Display light status |

### Mode vs Switch State

For Samsung ACs, the `mode` in DeviceState represents the `airConditionerMode`, NOT the on/off state:

```
switchState: "off", mode: "heat"  → Device is OFF (heat mode saved)
switchState: "on",  mode: "heat"  → Device is ON in heat mode
```

When `switchState` is "off", HomeKit should show the device as "Off" regardless of the stored `airConditionerMode`.

---

## Temperature Units

- **SmartThings API:** Fahrenheit (°F)
- **HomeKit:** Celsius (°C)
- **Bridge:** Converts between units at the HAP layer

### Conversion Formulas
```typescript
fahrenheitToCelsius = (f) => (f - 32) * 5 / 9
celsiusToFahrenheit = (c) => c * 9 / 5 + 32
```

---

## Command Flow

### HomeKit → SmartThings

```
HomeKit App
    ↓ (Characteristic change)
HAP Server (HAPServer.ts)
    ↓ (HAPThermostatEvent)
Coordinator (Coordinator.ts)
    ↓ (Plugin hooks)
SmartThings API (SmartThingsAPI.ts)
    ↓ (executeCommands)
SmartThings Cloud
```

### SmartThings → HomeKit

```
SmartThings Cloud
    ↓ (Polling every 5 min)
SmartThings API (getDeviceStatus)
    ↓ (DeviceState)
Coordinator (updateDeviceStates)
    ↓ (Plugin hooks)
HAP Server (updateDeviceState)
    ↓ (Characteristic updates)
HomeKit App
```

---

## Testing Commands

### Using SmartThings CLI

```bash
# Get device status
smartthings devices:status <device-id> --json

# Turn off Samsung AC
smartthings devices:commands <device-id> switch:off

# Turn on and set to heat
smartthings devices:commands <device-id> switch:on
smartthings devices:commands <device-id> airConditionerMode:setAirConditionerMode:heat

# Set temperature (works in any mode)
smartthings devices:commands <device-id> thermostatCoolingSetpoint:setCoolingSetpoint:72

# Traditional thermostat mode change
smartthings devices:commands <device-id> thermostatMode:setThermostatMode:heat

# Traditional thermostat heating setpoint
smartthings devices:commands <device-id> thermostatHeatingSetpoint:setHeatingSetpoint:68
```

### Test Script
A test script is available at `scripts/test-commands.sh`:
```bash
./scripts/test-commands.sh <device-id>
```

---

## Critical Implementation Notes

### All Command Paths Must Use Coordinator

**IMPORTANT:** All temperature and mode changes—whether from HomeKit, the web UI, or any other source—MUST route through `Coordinator.handleThermostatEvent()`.

**Why:** The Coordinator contains the Samsung AC fallback logic:
- Detects when a device lacks `thermostatHeatingSetpoint` capability
- Falls back to `thermostatCoolingSetpoint` for temperature changes in heat mode
- Uses `switch:off` instead of invalid mode commands for Samsung ACs

**What happens if you bypass the Coordinator:**
```
SmartThings API returns 422 error:
"thermostatHeatingSetpoint is not a valid value"
```

**Correct pattern:**
```typescript
// ✅ CORRECT - Routes through Coordinator
await coordinator.handleThermostatEvent({
  deviceId,
  type: 'temperature',
  temperature: 72,
});

// ❌ WRONG - Bypasses Samsung AC logic
await api.setTemperature(deviceId, 72, 'heat');
```

### Samsung AC Capability Detection

Samsung ACs are identified by having `airConditionerMode` but NOT `thermostatMode`:

```typescript
const isSamsungAC = caps.airConditionerMode && !caps.thermostatMode;
```

When `isSamsungAC` is true:
- **Temperature:** Always use `thermostatCoolingSetpoint`, never `thermostatHeatingSetpoint`
- **Off mode:** Use `switch:off`, not `airConditionerMode:setAirConditionerMode:off`
- **Other modes:** Turn on switch first if device is off, then set mode

---

## Known Limitations

1. **Samsung AC "dry" and "wind" modes** - Mapped to "cool" in HomeKit since there's no equivalent
2. **Fan speed control** - Not exposed to HomeKit (Samsung ACs have `airConditionerFanMode`)
3. **Polling delay** - State changes from SmartThings take up to 5 minutes to appear in HomeKit
4. **No push updates** - Bridge uses polling, not webhooks/subscriptions

---

## References

- [SmartThings Capabilities Reference](https://developer.smartthings.com/docs/devices/capabilities/capabilities-reference)
- [HAP-NodeJS Documentation](https://github.com/homebridge/HAP-NodeJS)
- [HomeKit Accessory Protocol Specification](https://developer.apple.com/homekit/)
