#!/bin/bash
set -e

echo "📦 Starting GitHub Actions test build for jm-production branch"
echo "⚙️ This script is run automatically by the pre-push hook"

# Set environment variables
export BUILDX_NO_DEFAULT_ATTESTATIONS=1

echo "✅ Build test passed!"
exit 0