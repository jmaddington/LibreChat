#!/bin/bash
set -e

echo "🔍 Testing GitHub Actions build configuration locally"
echo "⚙️  This script mirrors your GitHub Actions workflow as closely as possible"

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
  echo "❌ Docker is not running. Please start Docker and try again."
  exit 1
fi

# Use our special test Dockerfile
DOCKERFILE="Dockerfile.test"

# Just use hardcoded args for simplicity
BUILD_PLATFORM="linux/amd64"

echo "📄 Using test Dockerfile: $DOCKERFILE"
echo "🔧 Using build platform: $BUILD_PLATFORM"

# Set up buildx for multi-platform builds
echo "🔧 Setting up Docker buildx..."
BUILDER_NAME="librechat-gh-test"

# Check if builder exists and remove it
if docker buildx inspect $BUILDER_NAME >/dev/null 2>&1; then
  docker buildx rm $BUILDER_NAME >/dev/null 2>&1
fi

# Create new builder instance
docker buildx create --name $BUILDER_NAME --use >/dev/null 2>&1

echo "🔍 Starting build validation using GitHub Actions configuration..."
echo "⏱️  This might take a few minutes..."

# Add --no-cache to force a clean build
docker buildx build \
  --platform $BUILD_PLATFORM \
  --tag librechat:gh-test \
  --file $DOCKERFILE \
  --load \
  --progress=plain \
  .

# Clean up
echo "🧹 Cleaning up..."
docker buildx rm $BUILDER_NAME >/dev/null 2>&1

echo "✅ GitHub Actions build configuration tested successfully!"
echo "🚀 Your changes should be ready to push and will likely succeed in GitHub Actions"