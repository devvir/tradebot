# Docker Base Images

This directory contains reusable base Dockerfiles for TradeBot services.

## Node.js Service Base Dockerfile

**File**: `node.Dockerfile`

A standardized multi-stage Dockerfile for all Node.js/TypeScript services in the monorepo.

**Companion file**: [../.dockerignore](../.dockerignore) - Controls what gets copied into the build context

### Features

- **Multi-stage build**: Separate builder and production stages
- **Full workspace support**: Copies entire monorepo via `COPY . .` (respects `.dockerignore`)
- **Optimized layers**: Production stage only includes runtime dependencies
- **Low maintenance**: No need to update Dockerfile when directory structure changes
- **Standard health checks**: Exposes port 3000 for health endpoints
- **Proper signal handling**: Uses dumb-init for graceful shutdowns
- **Memory limits**: Sets reasonable Node.js heap size (2GB)

### Usage

In your service's `docker/compose.yml`:

```yaml
services:
  your-service:
    build:
      context: ../../..
      dockerfile: docker/node.Dockerfile
      args:
        SERVICE_NAME: your-service
        NODE_MEMORY_MB: 2048          # Optional: Node.js heap size in MB (default: 2048)
```

**Build Arguments**:
- `SERVICE_NAME` (required): Must match folder name under `services/`
- `NODE_MEMORY_MB` (optional): Node.js `--max-old-space-size` in MB. Defaults to 2048 (2GB). Examples:
  - `1024` for 1GB heap
  - `4096` for 4GB heap

### Build Process

1. **Builder Stage**:
   - Copies entire monorepo via `COPY . .` (excluding items in `.dockerignore`)
   - Installs all dependencies including dev: `npm ci`
   - Builds specified service TypeScript code: `npm run build`

2. **Production Stage**:
   - Copies only what's needed: root `package*.json`, `packages/`, `shared/`, and service `package*.json`
   - **Inside the service directory**: Installs production-only dependencies for that service: `npm ci --omit=dev`
   - Copies compiled `dist/` from builder stage
   - Exposes port 3000 for health checks
   - Minimal final image with only the specific service's dependencies

### .dockerignore

The `.dockerignore` file controls what gets copied into both build stages:

**Excluded (not copied)**:
- `node_modules/` - Fresh install for each stage
- `dist/` - Rebuilds from `src/`
- `docs/` - Documentation only needed locally
- `.git/`, `.github/` - Version control & CI config
- `.env*` - Environment files (use env vars instead)
- Test artifacts, IDE config, dev tools

**Included (copied)**:
- All `package*.json` files
- `tsconfig.json`
- Source code (`src/` in all packages and services)
- Test files (used during build for TypeScript compilation)
- All workspace directories needed for npm resolution

### Requirements

Each Node.js service must have:
- `package.json` with `build` script
- TypeScript source in `src/`
- Health check endpoint on port 3000
- Entry point at `dist/index.js`

### Customization

To override defaults (e.g., different ports, memory limits), extend the base Dockerfile or override `CMD` in compose.yml.
