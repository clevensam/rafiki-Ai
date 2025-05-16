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

# Create empty directory for sox-bin to prevent build errors
echo "Setting up sox-bin directory..."
mkdir -p node_modules/sox-bin/bin

# Rebuild native modules
echo "Rebuilding native modules..."
electron-rebuild

# Build for macOS (both Intel and Apple Silicon)
echo "Building for macOS..."
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build-mac
if [ $? -ne 0 ]; then
    echo "Error: macOS build failed"
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
if [ ! -f "dist/Angel AI Meeting Assistant-1.0.0-mac.zip" ] && [ ! -f "dist/Angel AI Meeting Assistant-1.0.0-arm64-mac.zip" ]; then
    echo "Error: macOS builds not found"
    exit 1
fi

ls -la dist/

echo "Build completed successfully!"
echo "You can find the builds in the dist directory:"
echo "- macOS Intel: dist/Angel AI Meeting Assistant-1.0.0-mac.zip"
echo "- macOS Apple Silicon: dist/Angel AI Meeting Assistant-1.0.0-arm64-mac.zip"
echo "- Windows: dist/Angel AI Meeting Assistant*.exe"
echo ""
echo "Note: These builds are not code signed. Users may need to bypass security warnings."

# Print build sizes
echo ""
echo "Build sizes:"
ls -lh dist/*.zip 
if [ -f "dist/Angel AI Meeting Assistant-1.0.0-arm64.dmg" ]; then
    ls -lh dist/*.dmg
fi 