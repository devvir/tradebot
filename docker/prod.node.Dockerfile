# Base Dockerfile for all Node.js services in the TradeBot monorepo

ARG NODE_VERSION=22.23-alpine3.24

# ============================================================================
# Builder Stage - Compile TypeScript, then deploy one service
# ============================================================================
FROM node:${NODE_VERSION} AS builder

# Enable corepack and install pnpm
RUN corepack enable

ENV CI=true

WORKDIR /app

# Dependencies first, from the lockfile alone: every package it pins is fetched
# into the store here, and this layer is reused until the lockfile, the
# workspace settings or the root manifest change
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# Copy entire monorepo (respects .dockerignore)
COPY . .

# Install all dependencies (including dev dependencies for build) from the
# store, exactly as the lockfile pins them: a lockfile out of step with
# package.json fails here
RUN pnpm install --frozen-lockfile --offline

# Build argument to specify which service to build
ARG SERVICE_NAME
RUN test -n "$SERVICE_NAME" || (echo "SERVICE_NAME build arg is required" && exit 1)

# Build the service and every workspace package it depends on
RUN pnpm --filter "{./services/${SERVICE_NAME}}..." run build

# Fail the build, rather than the container, when the entrypoint was not produced
RUN test -f services/${SERVICE_NAME}/dist/src/index.js \
  || (echo "missing dist/src/index.js for ${SERVICE_NAME}" && exit 1)

# The service on its own: its files, its production dependencies, and a copy of
# each workspace package it depends on, built, in its own node_modules. Each
# copy holds what the package would publish, which leaves out whatever an ignore
# file of its own names: .dockerignore keeps every .gitignore out of the context
RUN pnpm --filter "{./services/${SERVICE_NAME}}" deploy --prod /deploy

# Fail the build, rather than the container, when the deployed tree is short of
# a built file of the service or of any workspace package it depends on
RUN node docker/node/check-deploy.mjs /app /deploy

# Everything the runtime user reads must be readable whatever the host's umask
RUN chmod -R a+rX /deploy

# ============================================================================
# Runtime Stage - the deployed service on a plain node image
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

# Copy the deployed service
COPY --from=builder /deploy .

# Expose health check port (standard across all services)
EXPOSE 3000

# Run as the image's unprivileged user (uid 1000)
USER node

# DuckDB extensions to install into the image (space-separated, default none),
# into the runtime user's extension directory (~/.duckdb/extensions) with the
# DuckDB the service itself resolves. A service that loads them then finds them
# locally and needs no network at run time. The build fails when one cannot be
# installed.
ARG DUCKDB_EXTENSIONS=""
RUN if [ -n "$DUCKDB_EXTENSIONS" ]; then \
      node --input-type=module -e " \
        const { DuckDBInstance } = await import('@duckdb/node-api'); \
        const conn = await (await DuckDBInstance.create()).connect(); \
        for (const extension of process.argv.slice(1)) await conn.run('INSTALL ' + extension + '; LOAD ' + extension); \
      " $DUCKDB_EXTENSIONS; \
    fi

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start the service with configurable memory limits (default: 2GB)
CMD ["/bin/sh", "-c", "exec node --max-old-space-size=${NODE_MEMORY_MB} dist/src/index.js"]
