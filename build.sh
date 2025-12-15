#!/bin/bash
set -euo pipefail

echo "Starting integrated multi-platform build for SmartThings HomeKit Bridge..."

# Registry and image configuration
REGISTRY="docker.revealedpreferences.com"
IMAGE_NAME="smartthings-homekit-bridge"
FULL_IMAGE="${REGISTRY}/${IMAGE_NAME}:latest"
CACHE_IMAGE="${REGISTRY}/${IMAGE_NAME}:cache"

# Detect container runtime (podman or docker)
DOCKER_PATH="$(command -v docker 2>/dev/null || true)"
if [[ -n "$DOCKER_PATH" ]]; then
    DOCKER_REAL="$(readlink -f "$DOCKER_PATH" 2>/dev/null || echo "$DOCKER_PATH")"
fi

if command -v podman &>/dev/null && [[ "${DOCKER_REAL:-}" == *podman* || -z "$DOCKER_PATH" ]]; then
    RUNTIME="podman"
    echo "Using Podman..."
elif docker buildx version &>/dev/null; then
    RUNTIME="docker-buildx"
    echo "Using Docker with buildx..."
else
    RUNTIME="docker"
    echo "Using Docker..."
fi

if [[ "$RUNTIME" == "podman" ]]; then
    # Podman: build each platform separately and create manifest
    echo "Building multi-platform image (linux/amd64, linux/arm64)..."

    podman build --platform linux/amd64 --format docker -t "${FULL_IMAGE}-amd64" .
    podman build --platform linux/arm64 --format docker -t "${FULL_IMAGE}-arm64" .

    echo "Pushing images and creating manifest..."
    podman push "${FULL_IMAGE}-amd64"
    podman push "${FULL_IMAGE}-arm64"

    # Create and push manifest list
    podman manifest create "${FULL_IMAGE}" || podman manifest rm "${FULL_IMAGE}"
    podman manifest create "${FULL_IMAGE}"
    podman manifest add "${FULL_IMAGE}" "${FULL_IMAGE}-amd64"
    podman manifest add "${FULL_IMAGE}" "${FULL_IMAGE}-arm64"
    podman manifest push "${FULL_IMAGE}" "docker://${FULL_IMAGE}"

elif [[ "$RUNTIME" == "docker-buildx" ]]; then
    # Docker buildx with caching
    echo "Setting up Docker buildx..."
    if ! docker buildx inspect smartthings-builder >/dev/null 2>&1; then
        echo "Creating new buildx builder instance..."
        docker buildx create --name smartthings-builder --driver docker-container --bootstrap
    fi
    docker buildx use smartthings-builder

    echo "Building multi-platform image (linux/amd64, linux/arm64) with registry caching..."
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

else
    # Plain docker - single platform only
    echo "WARNING: Plain Docker detected, building for current platform only..."
    if ! docker build -t "${FULL_IMAGE}" .; then
        echo "ERROR: Build failed!" >&2
        exit 1
    fi
    docker push "${FULL_IMAGE}"
fi

echo "Multi-platform build successful!"
echo "Images pushed to registry:"
echo "  - ${FULL_IMAGE} (linux/amd64, linux/arm64)"
[[ "$RUNTIME" == "docker-buildx" ]] && echo "  - Cache stored at ${CACHE_IMAGE}"
echo "Build completed."
