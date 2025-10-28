# Plugin API Routes

All plugin routes are prefixed with `/api/plugins/{plugin-name}`.

## HVAC Auto-Mode Plugin

Base path: `/api/plugins/hvac-auto-mode`

### GET `/api/plugins/hvac-auto-mode/status`

Get the current auto-mode controller status.

**Response:**
```json
{
  "currentMode": "heat" | "cool" | "off",
  "enrolledDeviceIds": ["device-1", "device-2"],
  "timeSinceLastSwitch": 1234,
  "config": {
    "heatHysteresis": 0.7,
    "coolHysteresis": 0.7,
    "flipGuard": 2.0,
    "minOnTime": 600,
    "minOffTime": 300,
    "minLockTime": 1800,
    "relativeDominanceThreshold": 0.25,
    "absoluteDominanceThreshold": 2.0,
    "freezeProtectionTemp": 50,
    "highTempProtectionTemp": 90
  }
}
```

### GET `/api/plugins/hvac-auto-mode/decision`

Get the real-time auto-mode decision with per-device demand calculations.

**Response:**
```json
{
  "mode": "heat" | "cool" | "off",
  "totalHeatDemand": 5.2,
  "totalCoolDemand": 0.0,
  "deviceDemands": [
    {
      "deviceId": "device-1",
      "deviceName": "Master Bedroom",
      "heatDemand": 2.5,
      "coolDemand": 0.0,
      "currentTemp": 68.5,
      "lowerBound": 70,
      "upperBound": 75
    }
  ],
  "reason": "Heat demand dominant (5.2 > 0.0 + 25%)",
  "switchSuppressed": false,
  "secondsUntilSwitchAllowed": 0
}
```

## Lighting Monitor Plugin

Base path: `/api/plugins/lighting-monitor`

### GET `/api/plugins/lighting-monitor/status`

Get the current lighting monitor status.

**Response:**
```json
{
  "running": true,
  "interval": "*/1 * * * *",
  "monitoredDeviceCount": 4,
  "monitoredDevices": [
    {
      "id": "device-1",
      "name": "Master Bedroom AC"
    },
    {
      "id": "device-2",
      "name": "Guest Room AC"
    }
  ]
}
```

### GET `/api/plugins/lighting-monitor/check/:deviceId`

Manually check and turn off lights for a specific device.

**Parameters:**
- `deviceId` (path parameter) - SmartThings device ID

**Response:**
```json
{
  "success": true,
  "deviceId": "device-1"
}
```

**Error Response:**
```json
{
  "error": "Failed to check device"
}
```

## Core Devices Plugin

Base path: `/api/plugins/core-devices`

**No web routes** - This plugin provides basic passthrough functionality without requiring API endpoints.

## Using Plugin Routes

### From the Web Interface

All plugin routes are accessible from the web interface. For example:

```bash
# Get HVAC auto-mode status
curl http://localhost:3000/api/plugins/hvac-auto-mode/status

# Get real-time decision
curl http://localhost:3000/api/plugins/hvac-auto-mode/decision

# Get lighting monitor status
curl http://localhost:3000/api/plugins/lighting-monitor/status

# Manually check a device's lights
curl http://localhost:3000/api/plugins/lighting-monitor/check/device-abc123
```

### From the Production Server

If running on production (https://hvac.pa.revealedpreferences.com):

```bash
# Get HVAC auto-mode status
curl https://hvac.pa.revealedpreferences.com/api/plugins/hvac-auto-mode/status

# Get real-time decision
curl https://hvac.pa.revealedpreferences.com/api/plugins/hvac-auto-mode/decision
```

## Plugin Route Registration

Plugins register routes by implementing the `getWebRoutes()` method:

```typescript
getWebRoutes(): PluginWebRoute[] {
  return [
    {
      path: '/status',
      handler: async (req: Request, res: Response) => {
        // Handler implementation
        res.json({ status: 'ok' });
      }
    }
  ];
}
```

The PluginManager automatically mounts these routes at `/api/plugins/{plugin-name}`.

## Legacy Routes (Deprecated)

The following routes existed in the pre-plugin system and are now deprecated:

- `/api/devices/auto-mode/status` → **Redirects to** `/api/plugins/hvac-auto-mode/status`
- `/api/devices/auto-mode/decision` → **Redirects to** `/api/plugins/hvac-auto-mode/decision`

These redirects ensure backward compatibility but should not be used in new code.
