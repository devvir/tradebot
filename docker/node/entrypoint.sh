#!/bin/sh
set -e

# Service entrypoint: Run a Node.js service

# Validate required environment variables
if [ -z "$SERVICE_NAME" ]; then
  echo "ERROR: SERVICE_NAME environment variable is not set"
  exit 1
fi

if [ -z "$NODE_MEMORY_MB" ]; then
  NODE_MEMORY_MB=2048
fi

echo "=== Service Entrypoint ==="
echo "Service: ${SERVICE_NAME}"
echo "Memory: ${NODE_MEMORY_MB} MB"
echo ""

# Run the service
echo "Starting ${SERVICE_NAME}..."
exec node --max-old-space-size="${NODE_MEMORY_MB}" "services/${SERVICE_NAME}/dist/src/index.js"
