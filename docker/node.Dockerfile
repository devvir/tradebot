# Base Dockerfile for all Node.js services in the TradeBot monorepo
# Usage: docker build --build-arg SERVICE_NAME=archivist -f docker/node.Dockerfile .

ARG NODE_VERSION=22-alpine

# ============================================================================
# Builder Stage - Compile TypeScript
# ============================================================================
FROM node:${NODE_VERSION} AS builder

WORKDIR /app

# Copy entire monorepo (respects .dockerignore)
COPY . .

# Enable corepack and install pnpm
RUN corepack enable

# Install all dependencies (including dev dependencies for build)
RUN pnpm install

# Build argument to specify which service to build
ARG SERVICE_NAME
RUN test -n "$SERVICE_NAME" || (echo "SERVICE_NAME build arg is required" && exit 1)

# Build all packages and services from root
RUN pnpm run build

# ============================================================================
# Production Stage - Minimal runtime image
# ============================================================================
FROM node:${NODE_VERSION}

# Node.js heap memory limit (in MB, default 2GB)
ARG NODE_MEMORY_MB=2048
ENV NODE_MEMORY_MB=${NODE_MEMORY_MB}

# Build argument (must redeclare after FROM)
ARG SERVICE_NAME
RUN test -n "$SERVICE_NAME" || (echo "SERVICE_NAME build arg is required" && exit 1)

# Install runtime utilities
RUN apk add --no-cache dumb-init curl

WORKDIR /app

# Enable corepack
RUN corepack enable

# Copy the pre-built workspace (preserves structure needed for relative imports)
COPY --from=builder /app .

# Set working directory to service
WORKDIR /app/services/${SERVICE_NAME}

# Expose health check port (standard across all services)
EXPOSE 3000

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start the service with configurable memory limits (default: 2GB)
CMD ["/bin/sh", "-c", "exec node --max-old-space-size=${NODE_MEMORY_MB} dist/index.js"]
