#!/bin/bash
#
# Mount production NFS volumes on macOS
#

set -e

NFS_SERVER="192.168.4.2"
NFS_BASE_PATH="/volume1/docker/smartthings-homekit-bridge"
LOCAL_MOUNT_BASE="/tmp/smartthings-nfs"

echo "🔌 Mounting NFS volumes from production..."

# Create mount points
mkdir -p "$LOCAL_MOUNT_BASE/data"
mkdir -p "$LOCAL_MOUNT_BASE/persist"

# Check if already mounted
if mount | grep -q "$LOCAL_MOUNT_BASE/data"; then
    echo "✓ Data volume already mounted"
else
    echo "  Mounting data volume..."
    sudo mount -t nfs -o resvport,rw "$NFS_SERVER:$NFS_BASE_PATH/data" "$LOCAL_MOUNT_BASE/data"
    echo "✓ Data volume mounted"
fi

if mount | grep -q "$LOCAL_MOUNT_BASE/persist"; then
    echo "✓ Persist volume already mounted"
else
    echo "  Mounting persist volume..."
    sudo mount -t nfs -o resvport,rw "$NFS_SERVER:$NFS_BASE_PATH/persist" "$LOCAL_MOUNT_BASE/persist"
    echo "✓ Persist volume mounted"
fi

echo ""
echo "✅ NFS volumes mounted at:"
echo "  Data:    $LOCAL_MOUNT_BASE/data"
echo "  Persist: $LOCAL_MOUNT_BASE/persist"
echo ""
echo "To unmount later, run: ./unmount-nfs.sh"
