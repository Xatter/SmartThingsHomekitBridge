# SmartThings Matter Bridge

Bridge your SmartThings HVAC devices to Matter/HomeKit, enabling control through Apple Home and other Matter-compatible platforms.

## Features

- **SmartThings Integration**: Connects to SmartThings API to discover and control HVAC devices
- **Matter/HomeKit Support**: Exposes thermostats as Matter devices for native HomeKit integration
- **Automatic Light Control**: Monitors and automatically turns off lights on specified devices
- **Device Synchronization**: Keeps temperature and mode settings synchronized across all devices
- **Web Interface**: Easy-to-use web UI for device management and Matter setup
- **Real-time Updates**: Continuous monitoring and state updates

## Prerequisites

- Node.js 18+
- SmartThings Developer Account
- SmartThings OAuth Application

## Setup

### 1. SmartThings OAuth Application

1. Go to [SmartThings Developers](https://smartthings.developer.samsung.com/)
2. Create a new project
3. Add an OAuth Client with these settings:
   - **Redirect URI**: `http://localhost:3000/auth/smartthings/callback`
   - **Scope**: `r:devices:* x:devices:*`

### 2. Installation

```bash
# Clone the repository
git clone <repository-url>
cd SmartThingsMatterBridge

# Install dependencies
npm install

# Copy environment configuration
cp .env.example .env

# Edit .env with your SmartThings OAuth credentials
nano .env
```

### 3. Configuration

Edit `.env` file:

```env
# SmartThings OAuth Configuration
SMARTTHINGS_CLIENT_ID=your_client_id_here
SMARTTHINGS_CLIENT_SECRET=your_client_secret_here
SMARTTHINGS_REDIRECT_URI=http://localhost:3000/auth/smartthings/callback

# Server Configuration
PORT=3000
WEB_PORT=3000
MATTER_PORT=5540

# Device Configuration (comma-separated device IDs for lighting monitor)
LIGHTING_MONITOR_DEVICES=device1,device2,device3,device4
```

## Usage

### Start the Bridge

```bash
# Development mode
npm run dev

# Production mode
npm run build
npm start
```

### Initial Setup

1. Visit `http://localhost:3000`
2. Click "Connect to SmartThings" to authenticate
3. Authorize the application in SmartThings
4. Your HVAC devices will be automatically discovered

### Matter/HomeKit Pairing

1. Go to the "Matter Setup" tab in the web interface
2. Use the QR code or manual pairing code to add the bridge to HomeKit
3. Your thermostats will appear as individual devices in Apple Home

## Architecture

### Core Components

- **SmartThingsAuthentication**: Handles OAuth token management and refresh
- **SmartThingsAPI**: Wrapper for SmartThings API with device filtering
- **LightingMonitor**: Automated light control for specified devices
- **Coordinator**: Central state management and device synchronization
- **MatterServer**: Matter protocol implementation with thermostat endpoints
- **WebServer**: REST API and React-based web interface

### Data Flow

1. **Device Discovery**: SmartThings API discovers HVAC-capable devices
2. **State Monitoring**: Coordinator polls device states every 5 minutes
3. **Temperature Sync**: Changes trigger synchronization across all devices
4. **Matter Updates**: Device states are pushed to HomeKit every second
5. **Light Control**: Lighting monitor checks and controls lights every minute

## API Endpoints

### Authentication
- `GET /api/auth/smartthings` - Initiate OAuth flow
- `GET /api/auth/smartthings/callback` - OAuth callback
- `GET /api/auth/status` - Check authentication status

### Devices
- `GET /api/devices` - List filtered HVAC devices
- `GET /api/devices/paired` - Get paired devices with states
- `GET /api/devices/:id` - Get specific device status
- `POST /api/devices/:id/temperature` - Set device temperature
- `POST /api/devices/:id/mode` - Set device mode
- `POST /api/devices/:id/light/on|off` - Control device light

### Matter
- `GET /api/matter/pairing` - Get QR code and pairing information
- `GET /api/matter/status` - Check Matter server status

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Type checking
npm run typecheck

# Build for production
npm run build

# Clean build artifacts
npm run clean
```

## Troubleshooting

### Common Issues

1. **Authentication Failed**: Check OAuth credentials and redirect URI
2. **No Devices Found**: Ensure devices have thermostat capabilities
3. **Matter Pairing Failed**: Check firewall settings for port 5540
4. **Token Expired**: Tokens are automatically refreshed; check logs for errors

### Debug Mode

Set environment variable for detailed logging:
```bash
DEBUG=* npm run dev
```

### Logs

Monitor application logs for troubleshooting:
- SmartThings API calls and responses
- Matter server events and pairing attempts
- Device state changes and synchronization
- OAuth token refresh attempts

## License

MIT License - see LICENSE file for details