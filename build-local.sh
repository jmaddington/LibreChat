#!/bin/bash
set -e

echo "📦 Starting local build check for x86_64 architecture"
echo "⚙️ This script simulates GitHub Actions environment to catch issues early"

# Check if Docker is running
if ! docker info; then
 echo "❌ Docker is not running. Please start Docker and try again."
 exit 1
fi

# Set up buildx for multi-platform builds
echo "🔧 Setting up Docker buildx..."
BUILDER_NAME="librechat-builder"

# Check if builder exists and remove it
if docker buildx inspect $BUILDER_NAME; then
 docker buildx rm $BUILDER_NAME
fi

# Create new builder instance
docker buildx create --name $BUILDER_NAME --use --platform linux/amd64 | tee build.log  2>&1

echo "🔍 Starting local build validation..."
echo "⏱️ This might take a few minutes..."

# Run the build without pushing (--load instead of --push)
# Adding --progress=plain for detailed output
(docker buildx build \
 --no-cache \
 --platform linux/amd64 \
 --tag librechat:local-test \
 --file Dockerfile.multi \
 --load \
 --progress=plain \
 .) | tee -a build.log 2>&1

# Clean up
echo "🧹 Cleaning up..."
docker buildx rm $BUILDER_NAME | tee -a build.log 2>&1

echo "✅ Build completed successfully!"
echo "🚀 Your changes should be ready to push to GitHub"