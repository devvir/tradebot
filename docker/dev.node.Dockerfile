# Base Dockerfile for all Node.js services in the TradeBot monorepo

ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION}

# Redeclare build args for this stage
ARG NODE_MEMORY_MB=2048
ARG SERVICE_NAME

# Install runtime utilities only (no build tools)
RUN apk add --no-cache dumb-init curl bash

# Enable corepack for pnpm
RUN corepack enable

WORKDIR /live

# Expose health check port (standard across all services)
EXPOSE 3000

# Persist runtime bound ARGs as ENV vars (for CMD/entrypoint)
ARG NODE_MEMORY_MB=2048
ENV NODE_MEMORY_MB=${NODE_MEMORY_MB}

ARG SERVICE_NAME
ENV SERVICE_NAME=${SERVICE_NAME}

# For pnpm
ENV CI=true

USER node

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Install and build at startup (volume is mounted by then), then run the service
CMD ["/bin/sh", "-c", "pnpm install && ./tb build ${SERVICE_NAME} && exec node --max-old-space-size=${NODE_MEMORY_MB} services/${SERVICE_NAME}/dist/index.js"]