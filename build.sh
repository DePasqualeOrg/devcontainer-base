#!/bin/bash

# Build and tag the devcontainer base image
# Usage: ./build.sh [tag] [--no-cache]

set -e

# Check for no-cache flag and set tag
NO_CACHE=""
if [ "$1" == "--no-cache" ]; then
    NO_CACHE="--no-cache"
    TAG="latest"
    echo "Building devcontainer-base image with tag: $TAG (no cache)"
elif [ "$2" == "--no-cache" ]; then
    NO_CACHE="--no-cache"
    TAG=${1:-latest}
    echo "Building devcontainer-base image with tag: $TAG (no cache)"
else
    TAG=${1:-latest}
    echo "Building devcontainer-base image with tag: $TAG"
fi

# Build the image
docker build $NO_CACHE -t devcontainer-base:$TAG .

echo "Successfully built devcontainer-base:$TAG"

# Optionally tag as latest if a specific version was provided
if [ "$TAG" != "latest" ]; then
    docker tag devcontainer-base:$TAG devcontainer-base:latest
    echo "Also tagged as devcontainer-base:latest"
fi

# Clean up old dangling images from devcontainer-base builds
echo "Cleaning up dangling devcontainer-base images..."
docker image prune -f --filter "label=image-name=devcontainer-base" 2>/dev/null || true

echo "Available tags:"
docker images devcontainer-base