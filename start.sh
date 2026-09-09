#!/bin/bash

# Robust launcher for the Angel AI Meeting Assistant.
# Works when double-clicked from a desktop launcher where nvm's PATH isn't loaded.

# Make the build scripts executable
chmod +x "$(dirname "$0")/build.sh"
chmod +x "$(dirname "$0")/build-all.sh"

# Ensure node/npm from nvm is on PATH if not already
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -x "$(command -v node)" ] && [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
fi

# Make sure NODE_PATH includes nvm's global modules if npm isn't resolvable
if [ ! -x "$(command -v npm)" ]; then
  export PATH="$NVM_DIR/versions/node/$(ls "$NVM_DIR/versions/node" 2>/dev/null | tail -1)/bin:$PATH"
fi

echo "Starting Angel AI Meeting Assistant..."

# Start the application from the project directory
cd "$(dirname "$0")"
exec npm start
