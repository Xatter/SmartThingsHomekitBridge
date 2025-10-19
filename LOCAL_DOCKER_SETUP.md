# Local Docker Setup

This guide explains how to run the SmartThings HomeKit Bridge plugin system locally in Docker, connected to the production NFS volumes.

## Overview

The local setup:
- Runs in a Docker container on your Mac
- Connects to the **same NFS volumes** as production (data and persist)
- Uses **different ports** to avoid conflicts (3001 for web, 52827 for HAP)
- Uses **different HAP MAC address** to avoid HomeKit conflicts

## ⚠️ Important Warnings

1. **This uses PRODUCTION data!** The container connects to the same NFS volumes as production
2. **Stop production first** to avoid conflicts with device state and HomeKit pairing
3. **HomeKit pairing** - The local instance uses a different MAC address, so iOS devices will see it as a different bridge

## Prerequisites

1. Docker Desktop installed on your Mac
2. Network access to the NAS (192.168.4.2)
3. NFS access to `/volume1/docker/smartthings-homekit-bridge/`
4. Sudo access on your Mac (needed for NFS mounting)

## Quick Start

### 1. Build and Run

```bash
./run-local.sh
```

This will:
- Mount the NFS shares on your Mac (at `/tmp/smartthings-nfs/`)
- Build the Docker image
- Start the container with bind mounts to the NFS shares
- Display the web interface URL

**Note**: You'll be prompted for your sudo password to mount the NFS shares.

### 2. View Logs

```bash
./logs-local.sh
```

### 3. Stop

```bash
./stop-local.sh
```

## Configuration

### Port Configuration

- **Web Interface**: http://localhost:3001
- **HAP Port**: 52827
- **HAP MAC**: CC:22:3D:E3:CE:F6 (different from production)

### NFS Volumes

The setup mounts two NFS volumes from `192.168.4.2` on your Mac, then bind mounts them to the container:

**NFS Mounts on Mac**:
- `192.168.4.2:/volume1/docker/smartthings-homekit-bridge/data` → `/tmp/smartthings-nfs/data`
- `192.168.4.2:/volume1/docker/smartthings-homekit-bridge/persist` → `/tmp/smartthings-nfs/persist`

**Container Bind Mounts**:
- `/tmp/smartthings-nfs/data` → `/app/data`
  - Contains: config.json, smartthings_token.json, device_state.json
- `/tmp/smartthings-nfs/persist` → `/app/persist`
  - Contains: HomeKit pairing data, plugin state

**Manual NFS Management**:
```bash
# Mount NFS shares
./mount-nfs.sh

# Unmount NFS shares
./unmount-nfs.sh

# Check if mounted
mount | grep smartthings-nfs
```

### Plugin Configuration

The bridge will look for `/app/data/config.json` in the NFS volume. If it doesn't exist, you can create one:

```json
{
  "bridge": {
    "name": "SmartThings Bridge",
    "port": 52827,
    "pincode": "942-37-286",
    "username": "CC:22:3D:E3:CE:F6",
    "persistPath": "./persist"
  },
  "web": {
    "port": 3001
  },
  "smartthings": {
    "clientId": "beb5d179-ed3d-4b0f-aed6-0d268ef4b9c7",
    "clientSecret": "9ea208ec-b50f-4ede-a08b-44be100e34b7",
    "tokenPath": "./data/smartthings_token.json"
  },
  "polling": {
    "devicePollInterval": 300,
    "lightingCheckInterval": 60
  },
  "devices": {
    "include": ["*"],
    "exclude": []
  },
  "plugins": {
    "core-devices": {
      "enabled": true,
      "config": {}
    },
    "hvac-auto-mode": {
      "enabled": true,
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
    },
    "lighting-monitor": {
      "enabled": true,
      "config": {
        "checkInterval": 60
      }
    }
  }
}
```

## Troubleshooting

### NFS Mount Issues

If you get NFS mount errors when running `./mount-nfs.sh`:

1. **Verify NFS is enabled on the NAS**
   - Log into Synology NAS
   - Control Panel → File Services → NFS → Enable NFS

2. **Check network connectivity**
   ```bash
   ping 192.168.4.2
   ```

3. **Verify NFS exports on the NAS**
   - The paths should be exported with read/write permissions
   - May need to add your Mac's IP to allowed hosts

4. **Test manual mount**
   ```bash
   sudo mount -t nfs -o resvport,rw 192.168.4.2:/volume1/docker/smartthings-homekit-bridge/data /tmp/test-mount
   ```

5. **Check macOS NFS client**
   ```bash
   # Show current NFS mounts
   mount | grep nfs

   # Test NFS connectivity
   showmount -e 192.168.4.2
   ```

### Port Conflicts

If ports 3001 or 52827 are already in use:

1. Stop any other services using these ports
2. Or modify `docker-compose.local.yml` to use different ports

### HomeKit Pairing Issues

The local instance uses a different MAC address (CC:22:3D:E3:CE:F6) than production (CC:22:3D:E3:CE:F9), so:

1. iOS devices will see it as a new bridge
2. You'll need to pair it separately in the Home app
3. Or you can use the same MAC as production (but then you MUST stop production first)

## Switching Back to Production

1. Stop the local container: `./stop-local.sh`
2. Start the production container on the Raspberry Pi
3. The production instance will resume with the shared state

## Docker Commands

### Rebuild after code changes

```bash
docker-compose -f docker-compose.local.yml build --no-cache
docker-compose -f docker-compose.local.yml up -d
```

### Check container status

```bash
docker ps | grep smartthings
```

### Execute commands in container

```bash
docker exec -it smartthings-homekit-bridge-local sh
```

### Remove volumes (⚠️ WARNING: This will delete NFS mounts)

```bash
docker-compose -f docker-compose.local.yml down -v
```

## Notes

- The container uses **host networking** for mDNS/HomeKit discovery
- Environment variables can override config.json values
- Logs are available via `docker logs` command
- The container runs as the `smartthings` user (UID 1001)
