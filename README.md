# SmartThings HomeKit Bridge

A bridge application that connects SmartThings HVAC devices to HomeKit/HomeKit, allowing you to control your SmartThings devices through Apple's Home app and other HomeKit-compatible platforms.

## Features

- Bridge SmartThings devices to HomeKit via HomeKit protocol
- OAuth integration with SmartThings platform
- Web-based device management interface
- Real-time device state synchronization
- HomeKit Accessory Protocol (HAP) support

## Prerequisites

- Node.js 18.0.0 or higher
- SmartThings Developer Account
- ngrok (for OAuth callback during development)
- SmartThings CLI

## Installation

1. Clone the repository and install dependencies:
```bash
npm install
```

2. Build the project:
```bash
npm run build
```

## Setup Instructions

### 1. Setting up ngrok for OAuth

You'll need a public URL for the SmartThings OAuth callback. Use `ngrok` to create a tunnel to your local server. You can shut it down once you've done the oauth handshake:

1. Install ngrok if you haven't already:
```bash
# Using npm
npm install -g ngrok

# Using Homebrew (macOS)
brew install ngrok

# Or download from https://ngrok.com/download
```

2. Start your application first:
```bash
npm run dev
```

3. In a separate terminal, create a tunnel to localhost:3000:
```bash
ngrok http 3000
```

4. Note the public HTTPS URL provided by ngrok (e.g., `https://abc123.ngrok.io`)

### 2. SmartThings CLI Setup and App Creation

1. Install the SmartThings CLI:
```bash
npm install -g @smartthings/cli
```

2. Login to your SmartThings account:
```bash
smartthings login
```

3. Create a new SmartThings application:
```bash
smartthings apps:create
```

Follow the interactive prompts:
- **Application Name**: Choose a name for your app (e.g., "HomeKit Bridge")
- **Display Name**: User-friendly name
- **Description**: Brief description of your app
- **App Type**: Select "WebHook SmartApp"
- **Classifications**: Select appropriate classifications
- **OAuth**: Choose "Yes" to enable OAuth

4. Configure OAuth settings:
```bash
smartthings apps:oauth [APP_ID]
```

When prompted, set:
- **Client Name**: Your app name
- **Scope**: Select the scopes you need (typically `r:devices:*` and `x:devices:*`)
- **Redirect URIs**: Use your ngrok URL + callback path:
  ```
  https://your-ngrok-url.ngrok.io/auth/smartthings/callback
  ```

5. Get your OAuth credentials:
```bash
smartthings apps:oauth [APP_ID]
```

This will display your `CLIENT_ID` and `CLIENT_SECRET`.

### 3. Environment Configuration

1. Copy the example environment file:
```bash
cp .env.example .env
```

2. Edit the `.env` file with your configuration:

```env
# SmartThings OAuth Configuration
SMARTTHINGS_CLIENT_ID=your_client_id_from_cli
SMARTTHINGS_CLIENT_SECRET=your_client_secret_from_cli
SMARTTHINGS_REDIRECT_URI=https://your-ngrok-url.ngrok.io/auth/smartthings/callback

# Server Configuration
PORT=3000
WEB_PORT=3000
HAP_PORT=51826
HAP_PINCODE=942-37-286
SESSION_SECRET=your-random-session-secret-here

# Storage Paths
AUTH_TOKEN_PATH=./data/smartthings_token.json
DEVICE_STATE_PATH=./data/device_state.json

# Device Configuration (comma-separated device IDs for lighting monitor)
LIGHTING_MONITOR_DEVICES=device1,device2,device3,device4

# Update Intervals (in seconds)
DEVICE_POLL_INTERVAL=300
LIGHTING_CHECK_INTERVAL=60
```

**Important Notes:**
- Replace `your_client_id_from_cli` and `your_client_secret_from_cli` with the values from the SmartThings CLI
- Replace `your-ngrok-url.ngrok.io` with your actual ngrok URL
- Generate a secure random string for `SESSION_SECRET`
- Create the `./data` directory if it doesn't exist

### 4. Update Redirect URL for Production

For production deployment, update your SmartThings app's redirect URI:

```bash
smartthings apps:oauth:update [APP_ID]
```

Replace the ngrok URL with your production domain.

## Usage

### Docker Deployment (Recommended)

The easiest way to run the SmartThings HomeKit Bridge is using Docker:

#### Quick Start with Docker Compose

1. Create a `.env` file with your SmartThings credentials:
```bash
SMARTTHINGS_CLIENT_ID=your_client_id_from_cli
SMARTTHINGS_CLIENT_SECRET=your_client_secret_from_cli
SMARTTHINGS_REDIRECT_URI=http://your-domain:3000/auth/callback
```

2. Start the application:
```bash
docker-compose up -d
```

3. Access the web interface at `http://localhost:3000`

#### Manual Docker Build

```bash
# Build the Docker image
docker build -t smartthings-bridge .

# Run the container
docker run -d \
  --name smartthings-homekit-bridge \
  -p 3000:3000 \
  -p 5353:5353/udp \
  -e SMARTTHINGS_CLIENT_ID=your_client_id \
  -e SMARTTHINGS_CLIENT_SECRET=your_client_secret \
  -v homekit_data:/app/homekit \
  smartthings-bridge
```

#### Docker Environment Variables

- `SMARTTHINGS_CLIENT_ID` - Your SmartThings OAuth client ID
- `SMARTTHINGS_CLIENT_SECRET` - Your SmartThings OAuth client secret
- `SMARTTHINGS_REDIRECT_URI` - OAuth redirect URI (defaults to `http://localhost:3000/auth/callback`)
- `NODE_ENV` - Set to `production` for production deployments

#### Docker Volumes

- `/app/homekit` - Persists HomeKit pairing data across container restarts
- `/app/config` - Optional configuration directory (read-only)

#### Docker Networking Notes

- Port `3000` is used for the web interface
- Port `5353/udp` is used for mDNS HomeKit discovery
- If you experience HomeKit discovery issues, uncomment the `network_mode: host` line in `docker-compose.yml`

### Native Node.js Deployment

#### Start the Bridge

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

### HomeKit Pairing

1. Go to the "HomeKit Setup" tab in the web interface
2. Use the QR code or manual pairing code to add the bridge to HomeKit
3. Your thermostats will appear as individual devices in Apple Home

## Architecture

### Core Components

- **SmartThingsAuthentication**: Handles OAuth token management and refresh
- **SmartThingsAPI**: Wrapper for SmartThings API with device filtering
- **LightingMonitor**: Automated light control for specified devices
- **Coordinator**: Central state management and device synchronization
- **HomeKitServer**: HomeKit protocol implementation with thermostat endpoints
- **WebServer**: REST API and React-based web interface

### Data Flow

1. **Device Discovery**: SmartThings API discovers HVAC-capable devices
2. **State Monitoring**: Coordinator polls device states every 5 minutes
3. **Temperature Sync**: Changes trigger synchronization across all devices
4. **HomeKit Updates**: Device states are pushed to HomeKit every second
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

### HomeKit
- `GET /api/matter/pairing` - Get QR code and pairing information
- `GET /api/matter/status` - Check HomeKit server status

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
3. **HomeKit Pairing Failed**: Check firewall settings for port 5540
4. **Token Expired**: Tokens are automatically refreshed; check logs for errors

### Debug Mode

Set environment variable for detailed logging:
```bash
DEBUG=* npm run dev
```

### Logs

Monitor application logs for troubleshooting:
- SmartThings API calls and responses
- HomeKit server events and pairing attempts
- Device state changes and synchronization
- OAuth token refresh attempts

## License

MIT License - see LICENSE file for details