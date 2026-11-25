# Base Dockerfile for all Node.js services in the TradeBot monorepo

ARG NODE_VERSION=22.23-alpine3.24

# ============================================================================
# Builder Stage - Compile TypeScript
# ============================================================================
FROM node:${NODE_VERSION} AS builder

WORKDIR /app

# Copy entire monorepo (respects .dockerignore)
COPY . .

# Enable corepack and install pnpm
RUN corepack enable

# Install all dependencies (including dev dependencies for build), exactly as
# the lockfile pins them: a lockfile out of step with package.json fails here
RUN CI=true pnpm install --frozen-lockfile

# Build argument to specify which service to build
ARG SERVICE_NAME
RUN test -n "$SERVICE_NAME" || (echo "SERVICE_NAME build arg is required" && exit 1)

# Build all packages and services from root
RUN pnpm run build

# Fail the build, rather than the container, when the entrypoint was not produced
RUN test -f services/${SERVICE_NAME}/dist/src/index.js \
  || (echo "missing dist/src/index.js for ${SERVICE_NAME}" && exit 1)

# Everything the runtime user reads must be readable whatever the host's umask
RUN chmod -R a+rX /app

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

# Copy the pre-built workspace (preserves structure needed for relative imports)
COPY --from=builder /app .

# Set working directory to service
WORKDIR /app/services/${SERVICE_NAME}

# Expose health check port (standard across all services)
EXPOSE 3000

# Run as the image's unprivileged user (uid 1000)
USER node

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start the service with configurable memory limits (default: 2GB)
CMD ["/bin/sh", "-c", "exec node --max-old-space-size=${NODE_MEMORY_MB} dist/src/index.js"]
