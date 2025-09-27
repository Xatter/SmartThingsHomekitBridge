#!/bin/bash
set -euo pipefail

echo "Starting integrated multi-platform build for SmartThings HomeKit Bridge..."

# Registry and image configuration
REGISTRY="docker.revealedpreferences.com"
IMAGE_NAME="smartthings-homekit-bridge"
FULL_IMAGE="${REGISTRY}/${IMAGE_NAME}:latest"
CACHE_IMAGE="${REGISTRY}/${IMAGE_NAME}:cache"

# Ensure buildx is available and create builder if needed
echo "Setting up Docker buildx..."
if ! docker buildx inspect smartthings-builder >/dev/null 2>&1; then
    echo "Creating new buildx builder instance..."
    docker buildx create --name smartthings-builder --driver docker-container --bootstrap
fi

# Use the builder
docker buildx use smartthings-builder

echo "Building multi-platform image (linux/amd64, linux/arm64) with registry caching..."

# Build for both AMD64 and ARM64 with registry caching
if ! docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --cache-from type=registry,ref=${CACHE_IMAGE} \
    --cache-to type=registry,ref=${CACHE_IMAGE},mode=max \
    -t docker.revealedpreferences.com/smartthings-homekit-bridge:latest \
    -t ${FULL_IMAGE} \
    --push \
    .; then
    echo "ERROR: Docker buildx multi-platform build failed!" >&2
    exit 1
fi

echo "Multi-platform build successful!"
echo "Images pushed to registry:"
echo "  - ${FULL_IMAGE} (linux/amd64, linux/arm64)"
echo "  - Cache stored at ${CACHE_IMAGE}"
echo "Build completed."
