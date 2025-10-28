#!/bin/bash
#
# Stop the local SmartThings HomeKit Bridge container
#

set -e

echo "🛑 Stopping SmartThings HomeKit Bridge (local)..."
docker-compose -f docker-compose.local.yml down

echo ""
echo "📂 Unmounting NFS volumes..."
./unmount-nfs.sh

echo ""
echo "✅ Container stopped and NFS volumes unmounted"
