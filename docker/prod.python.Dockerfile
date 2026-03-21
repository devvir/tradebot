# Base Dockerfile for all Python services in the TradeBot monorepo (production)

# ============================================================================
# Builder Stage - Install dependencies
# ============================================================================
FROM python:3.12-slim AS builder

ARG SERVICE_NAME
RUN test -n "$SERVICE_NAME" || (echo "SERVICE_NAME build arg is required" && exit 1)

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app

# Copy entire monorepo (respects .dockerignore)
COPY . .

# Install production dependencies into the service's venv
RUN uv sync --project services/${SERVICE_NAME} --no-dev

# ============================================================================
# Production Stage - Minimal runtime image
# ============================================================================
FROM python:3.12-slim

ARG SERVICE_NAME
RUN test -n "$SERVICE_NAME" || (echo "SERVICE_NAME build arg is required" && exit 1)
ENV SERVICE_NAME=${SERVICE_NAME}

# Install runtime utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
      dumb-init \
      curl \
    && rm -rf /var/lib/apt/lists/*

# Install uv (needed to run the venv)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app/services/${SERVICE_NAME}

# Copy the built service (venv + source)
COPY --from=builder /app/services/${SERVICE_NAME} .

# Copy any shared packages that may be needed
COPY --from=builder /app/packages /app/packages

# Expose health check port (standard across all services)
EXPOSE 3000

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

CMD ["uv", "run", "python", "-m", "src.main"]
