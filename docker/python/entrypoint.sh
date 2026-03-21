#!/bin/sh
set -e

# Service entrypoint: Run a Python service

# Validate required environment variables
if [ -z "$SERVICE_NAME" ]; then
  echo "ERROR: SERVICE_NAME environment variable is not set"
  exit 1
fi

echo "=== Service Entrypoint ==="
echo "Service: ${SERVICE_NAME}"
echo ""

cd "/live/services/${SERVICE_NAME}"

# Sync dependencies (venv lives inside the mounted service directory)
echo "Syncing dependencies..."
uv sync

echo "Starting ${SERVICE_NAME}..."
exec uv run python -m src.main
