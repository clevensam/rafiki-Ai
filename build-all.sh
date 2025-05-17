#!/bin/bash

# Exit on error
set -e

# Clean previous builds
echo "Cleaning previous builds..."
rm -rf dist
rm -rf node_modules/.cache

# Install dependencies
echo "Installing dependencies..."
npm install

# Rebuild native modules
echo "Rebuilding native modules..."
electron-rebuild

# Build for macOS (Apple Silicon)
echo "Building for macOS (Apple Silicon)..."
CSC_IDENTITY_AUTO_DISCOVERY=false NOTARIZE=false npm run build-macarm
if [ $? -ne 0 ]; then
    echo "Error: macOS (Apple Silicon) build failed"
    exit 1
fi

# Build for Windows
echo "Building for Windows..."
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build-win
if [ $? -ne 0 ]; then
    echo "Error: Windows build failed"
    exit 1
fi

# Verify the builds
echo "Verifying builds..."
ls -la dist/

echo "Build completed successfully!"
echo "You can find the builds in the dist directory:"
echo "- macOS Apple Silicon: dist/Angel AI Meeting Assistant-1.0.0-arm64-mac.zip"
echo "- macOS Apple Silicon: dist/Angel AI Meeting Assistant-1.0.0-arm64.dmg"
echo "- Windows: dist/Angel AI Meeting Assistant Setup 1.0.0.exe"
echo "- Windows: dist/Angel AI Meeting Assistant-1.0.0-win.zip"
echo ""
echo "Note: These builds are not code signed. Users may need to bypass security warnings."

# Print build sizes
echo ""
echo "Build sizes:"
ls -lh dist/*.zip 
ls -lh dist/*.dmg 2>/dev/null || true
ls -lh dist/*.exe 2>/dev/null || true 