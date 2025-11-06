# SmartThings HomeKit Bridge - Developer Notes

## Project Overview
This project bridges SmartThings HVAC devices to HomeKit using HAP-NodeJS. It maintains device state synchronization between SmartThings and HomeKit.

## Key Architecture Points

### HomeKit Accessory Persistence
- HAP-NodeJS stores accessory persistence data in the `persist/` directory
- The bridge MAC address is set via `HAP_BRIDGE_USERNAME` env var (default: `CC:22:3D:E3:CE:F6`)
- Accessory UUIDs are generated deterministically: `HAP_uuid.generate('smartthings-thermostat-${deviceId}')`
- **IMPORTANT**: Accessories must be reused on restart to maintain HomeKit stability (names, rooms, automations)

### Device Identity Management
- Each SmartThings device has a unique `deviceId` that serves as the primary identifier
- This deviceId is used to:
  - Generate consistent accessory UUIDs
  - Set the SerialNumber characteristic
  - Track devices across restarts

### Critical Files
- `src/hap/HAPServer.ts` - HomeKit bridge implementation
- `src/coordinator/Coordinator.ts` - Device synchronization logic
- `persist/` - HAP-NodeJS persistence (DO NOT DELETE - contains pairing data)

## Common Issues & Solutions

### Devices Losing Names/Rooms After Restart
**Problem**: Accessories were losing custom names and room assignments after service restart.

**Root Cause**: HAP-NodeJS doesn't automatically restore bridged accessories. The library only persists:
- `AccessoryInfo.*.json` - Bridge pairing and configuration
- `IdentifierCache.*.json` - Accessory/Service/Characteristic ID mappings

When accessories are re-added individually after restart, it changes the configuration hash and HomeKit treats them as new.

**Solution**: Implemented Homebridge-style accessory caching:
1. Cache accessory metadata in `persist/cached_accessories.json`
2. On startup, restore ALL cached accessories from disk
3. Add them to the bridge in a SINGLE batch operation using `addBridgedAccessories()`
4. This preserves the configuration and HomeKit recognizes them as the same accessories

**Key Files**:
- `src/hap/AccessoryCache.ts` - Caching implementation
- `src/hap/HAPServer.ts` - Restore logic in `restoreCachedAccessories()`

**How It Works**:
1. When a new device is added, its metadata is saved to cache
2. On restart, cached accessories are restored BEFORE bridge publishes
3. All accessories are added to bridge at once
4. When `reloadDevices()` runs, it finds accessories already exist and just updates their state

**Result**: HomeKit now maintains device names, room assignments, and automations across restarts!

### Testing Commands
```bash
# Build and type-check
npm run build
npm run typecheck

# Start development server
npm run dev

# Start production server
npm start
```

## Environment Variables
- `WEB_PORT` - Web interface port (default: 3000)
- `HAP_PORT` - HomeKit bridge port (default: 51826)
- `HAP_PINCODE` - HomeKit pairing code (default: 942-37-286)
- `HAP_BRIDGE_USERNAME` - Bridge MAC address (default: CC:22:3D:E3:CE:F6)
- `HAP_PERSIST_PATH` - Persistence directory (default: ./persist)

## HomeKit Pairing
1. Bridge must be unpaired in Home app before changing `HAP_BRIDGE_USERNAME`
2. Pairing data is stored in `persist/AccessoryInfo.*.json`
3. Device accessories are tracked in `persist/IdentifierCache.*.json`

## Debugging Tips
- Check `persist/` directory for HAP-NodeJS state
- Monitor console logs for accessory reuse messages (♻️ symbols)
- Verify device IDs remain consistent across restarts
- Use Home app's accessory details to check if SerialNumber matches deviceId
- We use terraform to deploy to production, it's located in the ../infrastructure project