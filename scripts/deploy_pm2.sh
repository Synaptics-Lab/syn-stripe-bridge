#!/usr/bin/env bash
# syn-stripe-bridge — PM2 Daemon Deployment Script
# Target: Delta Server (100.90.65.38 / root@delta)

set -euo pipefail

APP_NAME="syn-stripe-bridge"
PORT="8092"
HOST="127.0.0.1"

echo "======================================================"
echo "🚀 Deploying ${APP_NAME} under PM2 on port ${PORT}"
echo "======================================================"

# Check if pm2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "pm2 not found. Installing via npm..."
    npm install -g pm2
fi

# Stop existing instance if running
pm2 stop "${APP_NAME}" 2>/dev/null || true
pm2 delete "${APP_NAME}" 2>/dev/null || true

# Start new instance
STRIPE_SHIM_PORT="${PORT}" STRIPE_SHIM_HOST="${HOST}" pm2 start src/stripe_shim.mjs \
    --name "${APP_NAME}" \
    --time \
    --max-memory-restart 200M

pm2 save

echo "======================================================"
echo "✅ ${APP_NAME} successfully deployed and listening on http://${HOST}:${PORT}"
echo "======================================================"
