#!/bin/bash
#
# Unmount production NFS volumes on macOS
#

set -e

LOCAL_MOUNT_BASE="/tmp/smartthings-nfs"

echo "🔌 Unmounting NFS volumes..."

if mount | grep -q "$LOCAL_MOUNT_BASE/data"; then
    echo "  Unmounting data volume..."
    sudo umount "$LOCAL_MOUNT_BASE/data"
    echo "✓ Data volume unmounted"
else
    echo "  Data volume not mounted"
fi

if mount | grep -q "$LOCAL_MOUNT_BASE/persist"; then
    echo "  Unmounting persist volume..."
    sudo umount "$LOCAL_MOUNT_BASE/persist"
    echo "✓ Persist volume unmounted"
else
    echo "  Persist volume not mounted"
fi

echo ""
echo "✅ NFS volumes unmounted"
