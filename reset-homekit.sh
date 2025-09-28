#!/bin/bash
set -euo pipefail

echo "🔄 Resetting HomeKit pairing data..."

# Stop the container if running
if docker ps --format 'table {{.Names}}' | grep -q "^smartthings-homekit-bridge$"; then
    echo "Stopping container..."
    docker stop smartthings-homekit-bridge
fi

# Remove persist directory from host data directory
DATA_DIR="${HOME}/.smartthings-bridge"
if [ -d "${DATA_DIR}/persist" ]; then
    echo "Removing HomeKit persist data from ${DATA_DIR}/persist..."
    rm -rf "${DATA_DIR}/persist"
    echo "✅ HomeKit pairing data cleared"
else
    echo "No persist directory found at ${DATA_DIR}/persist"
fi

# Also check if there's a persist directory in the container volume
if docker ps -a --format 'table {{.Names}}' | grep -q "^smartthings-homekit-bridge$"; then
    echo "Checking container for persist data..."
    docker exec smartthings-homekit-bridge rm -rf /app/persist 2>/dev/null || true
fi

echo ""
echo "✅ HomeKit reset complete!"
echo "You can now restart the bridge with: ./run.sh"
echo "The bridge will generate a new identity and can be added to HomeKit fresh."