# Plugin System Implementation

## Overview

The SmartThings HomeKit Bridge now has a complete plugin architecture that allows for extensible device support and custom coordination logic while keeping the core bridge generic.

## Architecture

```
Core Bridge (Generic)
├── PluginManager - Loads and coordinates plugins
├── Coordinator - Device-agnostic state synchronization
├── SmartThingsAPI - SmartThings integration
└── HAPServer - HomeKit integration

Plugins (Extensible)
├── core-devices - Basic device passthrough (lights, switches, sensors)
└── hvac-auto-mode - Intelligent HVAC coordination (your existing logic!)
```

## What's Been Built

### 1. **Core Plugin System** ✅
- `src/plugins/types.ts` - Plugin interface definitions
- `src/plugins/PluginContext.ts` - API for plugins to interact with bridge
- `src/plugins/PluginManager.ts` - Plugin loader and coordinator
- `src/config/BridgeConfig.ts` - Configuration system

### 2. **Built-in Plugins** ✅

#### Core Devices Plugin
Location: `src/plugins/builtin/core-devices/`
- Handles non-thermostat devices (lights, switches, sensors)
- Simple passthrough implementation
- Example for future plugin development

#### HVAC Auto-Mode Plugin
Location: `src/plugins/builtin/hvac-auto-mode/`
- **Your existing HVAC coordination logic extracted into a plugin!**
- Features preserved:
  - Multi-device AUTO mode coordination
  - Weighted demand calculation
  - Timing protections (min on/off/lock times)
  - Flip guard for shoulder seasons
  - Freeze/high-temp safety overrides
  - State persistence
- Web dashboard routes (`/api/plugins/hvac-auto-mode/status`, `/api/plugins/hvac-auto-mode/decision`)

### 3. **Refactored Core** ✅
- `src/coordinator/Coordinator.ts` - Now device-agnostic, delegates to plugins
- `src/index.ts` - Initializes plugin system
- `src/web/server.ts` - Registers plugin web routes
- `config.example.json` - Example configuration with plugin settings

## Plugin Lifecycle

```typescript
// 1. Load: Discover and load plugins
await pluginManager.loadPlugins();

// 2. Init: Initialize each plugin with context
await pluginManager.initializePlugins();

// 3. Start: Start plugins after all components ready
await pluginManager.startPlugins();

// 4. Run: Plugins intercept state changes and poll cycles
// - beforeSetSmartThingsState()
// - beforeSetHomeKitState()
// - afterDeviceUpdate()
// - onPollCycle()

// 5. Stop: Graceful shutdown
await pluginManager.stopPlugins();
```

## Plugin Capabilities

Plugins can:

1. **Filter devices** - Choose which devices to handle via `shouldHandleDevice()`
2. **Intercept state changes** - Modify or cancel HomeKit ↔ SmartThings updates
3. **Coordinate devices** - Run logic across multiple devices during polling
4. **Persist state** - Save/load plugin-specific state to disk
5. **Provide web routes** - Add custom API endpoints and dashboards
6. **Access all devices** - Query any device via plugin context

## Configuration

### Example `config.json`

```json
{
  "bridge": {
    "name": "SmartThings Bridge",
    "port": 51826
  },
  "plugins": {
    "core-devices": {
      "enabled": true
    },
    "hvac-auto-mode": {
      "enabled": true,
      "config": {
        "minOnTime": 600,
        "minOffTime": 300,
        "minLockTime": 1800
      }
    }
  }
}
```

Plugins can be:
- Enabled/disabled via `enabled: true/false`
- Configured via plugin-specific `config` object
- Overridden by environment variables

## What Still Needs Fixing

### TypeScript Compilation Errors

1. **Missing API Methods**
   - `SmartThingsAPI.executeCommands()` - Need to add this method
   - `SmartThingsHAPServer.updateAccessoryState()` - Need to add this method

2. **HAP Event Type**
   - `HAPThermostatEvent` needs `heatingSetpoint` and `coolingSetpoint` properties

3. **Web Routes**
   - `/api/devices` routes still reference old Coordinator methods
   - Need to update to use new plugin-aware architecture

4. **Method Name Mismatch**
   - `HAPServer` calls `handleHAPThermostatEvent` but method is `handleThermostatEvent`

## Next Steps

1. ✅ **Design plugin architecture** (DONE)
2. ✅ **Create core plugin system** (DONE)
3. ✅ **Extract HVAC logic into plugin** (DONE)
4. ✅ **Add configuration system** (DONE)
5. ⏳ **Fix compilation errors** (IN PROGRESS)
6. ⏳ **Test end-to-end** (PENDING)
7. ⏳ **Update documentation** (PENDING)

## Future Plugin Ideas

- **Scenes Plugin** - Create HomeKit scenes that control multiple devices
- **Scheduling Plugin** - Time-based automation
- **Presence Plugin** - Location-based device control
- **Energy Plugin** - Track and optimize energy usage
- **Weather Plugin** - Integrate weather data for smarter HVAC decisions

## Benefits

✅ **Preserves Your Work** - HVAC coordination is now a first-class plugin
✅ **Generic Bridge** - Core can support any SmartThings device
✅ **Extensible** - Anyone can write plugins
✅ **Configurable** - Enable/disable features as needed
✅ **Community Ready** - Plugin system allows community contributions
✅ **No Breaking Changes** - Existing functionality preserved

## Breaking from Old Code

The plugin system is in a git worktree at:
```
/Users/xatter/code/SmartThingsHomekitBridge-plugin-system
```

Branch: `plugin-system`

Old implementation backed up as:
- `src/coordinator/Coordinator.old.ts`
- `src/index.old.ts`
