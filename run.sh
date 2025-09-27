#!/bin/bash
set -euo pipefail

echo "Starting SmartThings HomeKit Bridge container..."

# Configuration
REGISTRY="docker.revealedpreferences.com"
IMAGE_NAME="smartthings-homekit-bridge"
FULL_IMAGE="${REGISTRY}/${IMAGE_NAME}:latest"
CONTAINER_NAME="smartthings-homekit-bridge"

# Port configuration (avoiding conflicts with Homebridge on 51826)
WEB_PORT="${WEB_PORT:-3000}"
HAP_PORT="${HAP_PORT:-52826}"  # Use 52826 to avoid conflict with Homebridge (51826)

# Stop and remove existing container if running
if docker ps -a --format 'table {{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "Stopping existing container..."
    docker stop ${CONTAINER_NAME} || true
    echo "Removing existing container..."
    docker rm ${CONTAINER_NAME} || true
fi

# Create data directory for persistent storage if it doesn't exist
DATA_DIR="${HOME}/.smartthings-bridge"
mkdir -p "${DATA_DIR}"

echo "Starting new container..."
docker run -d \
    --name ${CONTAINER_NAME} \
    --restart=always \
    -p ${WEB_PORT}:3000 \
    -p ${HAP_PORT}:51826 \
    -e HAP_PORT=51826 \
    -e WEB_PORT=3000 \
    -v "${DATA_DIR}:/app/data" \
    -v "${PWD}/oauth-settings.json:/app/oauth-settings.json:ro" \
    -v "${PWD}/.env:/app/.env:ro" \
    ${FULL_IMAGE}

echo "Container started successfully!"
echo "Web interface available at: http://localhost:${WEB_PORT}"
echo "HomeKit bridge running on port: ${HAP_PORT}"
echo "Container name: ${CONTAINER_NAME}"
echo "Data directory: ${DATA_DIR}"
echo ""
echo "Note: Using port ${HAP_PORT} to avoid conflict with Homebridge (port 51826)"
echo "To customize ports: WEB_PORT=3001 HAP_PORT=52827 ./run.sh"
echo ""
echo "To view logs: docker logs -f ${CONTAINER_NAME}"
echo "To stop: docker stop ${CONTAINER_NAME}"