#!/bin/bash
#
# Run the SmartThings HomeKit Bridge locally in Docker
# Connected to production NFS volumes
#

set -e

echo "🚀 Starting SmartThings HomeKit Bridge (Plugin System) locally..."
echo ""
echo "Configuration:"
echo "  - Web Interface: http://localhost:3001"
echo "  - HAP Port: 52827"
echo "  - Data Volume: NFS from 192.168.4.2:/volume1/docker/smartthings-homekit-bridge/data"
echo "  - Persist Volume: NFS from 192.168.4.2:/volume1/docker/smartthings-homekit-bridge/persist"
echo ""
echo "⚠️  WARNING: This will use PRODUCTION data from the NFS volumes!"
echo "   You may want to stop the production container first to avoid conflicts."
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 1
fi

echo ""
echo "📂 Mounting NFS volumes..."
./mount-nfs.sh

echo ""
echo "🏗️  Building Docker image..."
docker-compose -f docker-compose.local.yml build

echo ""
echo "🚀 Starting container..."
docker-compose -f docker-compose.local.yml up -d

echo ""
echo "✅ Container started!"
echo ""
echo "View logs with:"
echo "  docker logs -f smartthings-homekit-bridge-local"
echo ""
echo "Stop with:"
echo "  docker-compose -f docker-compose.local.yml down"
echo ""
echo "Web interface available at: http://localhost:3001"
