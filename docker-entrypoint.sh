#!/bin/sh
set -e

# Fix permissions for mounted volumes
# This runs as root before switching to the smartthings user
if [ "$(id -u)" = "0" ]; then
  echo "Fixing permissions for mounted volumes..."

  # Ensure /app/persist exists and is writable
  mkdir -p /app/persist
  chown -R smartthings:nodejs /app/persist

  # Ensure /app/data exists and is writable
  mkdir -p /app/data
  chown -R smartthings:nodejs /app/data

  echo "Permissions fixed. Starting application as smartthings user..."

  # Execute the command as the smartthings user
  exec su-exec smartthings "$@"
else
  # Already running as non-root, just execute the command
  exec "$@"
fi
