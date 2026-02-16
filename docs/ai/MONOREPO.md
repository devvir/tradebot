# TradeBot Monorepo Structure & Conventions

## Overview

This monorepo uses **npm workspaces** to organize code into independent, publishable packages (`packages/`), TradeBot-specific utilities (`shared/`), microservices (`services/`), and orchestration modules (`modules/`).

**Key principle**: Each directory under `packages/`, `shared/`, and `services/` is a self-contained unit with its own `package.json`, TypeScript config, and tests.

---

## Directory Structure

```
tradebot/
├── packages/                  ← Generic, reusable npm packages
│   └── rabbitmq/              @devvir/rabbitmq (can be published)
│       ├── src/               ← TypeScript source
│       ├── tests/             ← Jest tests
│       ├── dist/              ← Compiled JavaScript (built, not committed)
│       ├── package.json       (name: @devvir/rabbitmq)
│       ├── tsconfig.json
│       ├── jest.config.js
│       └── README.md
│
├── shared/                    ← TradeBot-specific utilities
│   └── types/                 @tradebot/types (internal use only)
│       ├── src/
│       ├── package.json
│       └── tsconfig.json
│
├── services/                  ← Microservices (TradeBot internal)
│   ├── feed/                  @tradebot/feed (consumer service)
│   ├── archivist/             @tradebot/archivist (persistence service)
│   ├── bitmex-ws/             @tradebot/bitmex-ws (websocket service)
│   ├── codec/                 @tradebot/codec (encoding service)
│   ├── mongodb/               (MongoDB broker, not a workspace)
│   ├── rabbitmq/              (RabbitMQ broker, not a workspace)
│   └── snapshots/             (Python service, not a workspace)
│
├── modules/                   ← Deployable application modules
│   ├── bitmex/                (bitmex-ws + codec combined)
│   └── reader/                (feed + archivist combined)
│
├── dx/                        ← Development orchestrator (Git submodule)
│   ├── commands/              ← CLI commands
│   ├── tests/
│   └── utils/
│
├── tsconfig.json              ← Root TypeScript config (path aliases)
├── package.json               ← Root workspace definition
└── docs/ai/                   ← Agent guidance (this file)
```

---

## Workspace Definition

### Root `package.json` Workspaces

```json
{
  "workspaces": [
    "packages/*",
    "shared/*",
    "services/*",
    "dx"
  ]
}
```

**Usage**: After `npm install`, all workspace packages are symlinked and can be imported directly:

```typescript
import { connect } from '@devvir/rabbitmq';        // From packages/
import { TradeConfig } from '@tradebot/types';     // From shared/
```

---

## Naming Conventions

### Package Scopes

| Directory | Scope | Use Case | Example |
|-----------|-------|----------|---------|
| `packages/` | `@devvir` | Generic, publishable packages | `@devvir/rabbitmq` |
| `shared/` | `@tradebot` | TradeBot-specific utilities | `@tradebot/types` |
| `services/` | `@tradebot` | Internal microservices | `@tradebot/feed` |
| `dx/` | Unscoped | Development tooling | `dx` (in monorepo context) |

### Publishing

- **`@devvir/*`** packages CAN be published to npm independently
- **`@tradebot/*`** packages are private (monorepo internal only)
- Set `"private": true` in `package.json` to prevent accidental publishing

---

## Path Aliases

### TypeScript `tsconfig.json`

```jsonc
{
  "paths": {
    "@devvir/rabbitmq": ["packages/rabbitmq/src"],
    "@tradebot/types": ["shared/types/src"]
  }
}
```

**Usage in services**:

```typescript
// These work automatically due to path aliases
import { Broker } from '@devvir/rabbitmq';
import type { Account } from '@tradebot/types';
```

**Note**: Paths are resolved at compile time. To add a new package, update `tsconfig.json`.

---

## Each Package/Service Structure

Every workspace package follows this pattern:

```
[package-name]/
├── src/                       ← TypeScript source code
│   ├── index.ts               ← Main export
│   ├── [module-name]/         ← Feature modules
│   └── types.ts               ← Type definitions (if relevant)
│
├── tests/                     ← Jest test files
│   └── [feature].test.ts
│
├── dist/                      ← Built JavaScript (generated, .gitignore)
│   ├── index.js
│   ├── index.d.ts             (TypeScript declarations)
│   └── [files].js
│
├── package.json               ← Must define:
│                                 - "name" (with scope)
│                                 - "main": "dist/index.js"
│                                 - "types": "dist/index.d.ts"
│                                 - "scripts": build, test, etc.
│
├── tsconfig.json              ← Extends root config
│
├── jest.config.js             ← Test configuration
│
└── README.md                  ← Package-specific docs
```

---

## Quick Tasks for Agents

### Adding a New Generic Package (publishable)

1. **Create directory**: `mkdir -p packages/[name]`
2. **Create structure**:
   ```bash
   cd packages/[name]
   mkdir -p src tests
   touch package.json tsconfig.json jest.config.js README.md
   ```
3. **Set `package.json`**:
   ```json
   {
     "name": "@devvir/[name]",
     "version": "1.0.0",
     "main": "dist/index.js",
     "types": "dist/index.d.ts",
     "scripts": { "build": "tsc", "test": "jest" }
   }
   ```
4. **Update root `tsconfig.json`**:
   ```jsonc
   "paths": {
     "@devvir/[name]": ["packages/[name]/src"]
   }
   ```
5. **Run**: `npm install` to link the workspace

### Adding a New TradeBot Service

1. **Create directory**: `mkdir -p services/[name]`
2. **Set `package.json`**:
   ```json
   {
     "name": "@tradebot/[name]",
     "private": true,
     "main": "dist/index.js",
     "scripts": { "build": "tsc", "test": "jest" }
   }
   ```
3. **Add service files**:
   ```bash
   mkdir -p src tests docker
   touch src/index.ts src/logger.ts src/config.ts
   ```
4. **Update root workspaces** in `package.json` if needed (usually auto-included via `services/*`)

### Adding a New Module (Deployment Unit)

Modules combine multiple services. Create in `modules/[name]/`:

```
modules/[name]/
├── compose.yml        ← Docker Compose with all services
├── README.md
└── .env.example       ← Environment template
```

### Importing Between Packages

**Generic package imports generic package**:
```typescript
// In packages/cache/src/index.ts
import { connect } from '@devvir/rabbitmq';
```

**Service imports generic package**:
```typescript
// In services/feed/src/index.ts
import { keepAlive } from '@devvir/rabbitmq';
```

**Service imports shared types**:
```typescript
// In services/archivist/src/index.ts
import type { TradeEvent } from '@tradebot/types';
```

**RULE**: Services should NOT import from other services. Use shared types or generic packages instead.

---

## Build & Test

### Build All Packages

```bash
npm run build
```

Builds TypeScript in all workspaces to `dist/` directories.

### Build Single Package

```bash
cd packages/rabbitmq
npm run build
```

### Test All

```bash
npm test
```

### Test Single Package

```bash
cd packages/rabbitmq
npm test
```

### Watch Mode

```bash
cd packages/rabbitmq
npm run test:watch
```

---

## Publishing to npm

**For `@devvir/*` packages only**:

1. **Ensure `package.json` has `"private": false`** (or omitted)
2. **Update version**: `npm version [major|minor|patch]`
3. **Publish**:
   ```bash
   cd packages/[name]
   npm publish
   ```

**From root**: Cannot publish directly; must `cd` into package directory.

---

## Environment & Configuration

### TypeScript

- **Root `tsconfig.json`**: Base configuration, path aliases for all packages
- **Each package's `tsconfig.json`**: Extends root, adds local overrides
- **Pattern**: `"extends": "../../tsconfig.json"` (adjust path as needed)

### Jest

- **Each package has `jest.config.js`** with its own:
  - Test root directory
  - Coverage thresholds
  - Module mapping

### Environment Variables

- **Service-specific**: `.env` files in `services/[name]/.env`
- **Module-level**: `modules/[name]/.env`
- **Local development**: Copy `.env.example` to `.env`

### Build Output

- All `dist/` folders are in `.gitignore`
- Built files are generated on `npm run build`
- CI/CD should run `npm run build` before tests/deployment

---

## Common Import Patterns

### Pattern 1: Import Entire Package

```typescript
import * as RabbitMQ from '@devvir/rabbitmq';
const broker = RabbitMQ.connect(...);
```

### Pattern 2: Named Imports

```typescript
import { connect, keepAlive } from '@devvir/rabbitmq';
```

### Pattern 3: Type-Only Imports

```typescript
import type { Broker, ConnectionOptions } from '@devvir/rabbitmq';
```

### Pattern 4: Submodule Imports

```typescript
import { Queue } from '@devvir/rabbitmq/queue';
import * as connection from '@devvir/rabbitmq/connection';
```

---

## Dependency Graph

```
packages/rabbitmq
  ↓ (imported by)
┌─────────────────────────────┐
│                             │
services/feed           services/archivist
services/bitmex-ws      services/codec
  ↓
modules/bitmex
modules/reader

shared/types
  ↓ (imported by)
┌─────────────────────────────┐
│                             │
All services                All packages (optionally)
```

**Rule**: Packages are at the bottom; services depend on packages and shared utilities.

---

## Docker & Containerization

### Base Dockerfile for Node.js Services

All Node.js/TypeScript services use a shared base Dockerfile: **`docker/node.Dockerfile`**

This eliminates duplicate Dockerfile logic across services. Each service specifies only its name via build arg.

#### Usage in Service Compose Files

```yaml
services:
  your-service:
    build:
      context: ../../..              # Monorepo root
      dockerfile: docker/node.Dockerfile
      args:
        SERVICE_NAME: your-service   # Required: Must match folder name
        NODE_MEMORY_MB: 2048         # Optional: Node.js heap size in MB (default: 2048)
```

**Build Arguments**:
- `SERVICE_NAME` (required): Folder name under `services/`
- `NODE_MEMORY_MB` (optional): Node.js `--max-old-space-size` in MB. Examples:
  - `1024` = 1GB
  - `2048` = 2GB (default)
  - `4096` = 4GB

#### What the Base Dockerfile Does

**Builder Stage**:
- Copies entire monorepo via `COPY . .` (respects `.dockerignore` to exclude dev artifacts)
- Installs all dependencies: `npm ci` (includes dev dependencies for compilation)
- Builds specified service TypeScript code: `npm run build`

**Production Stage**:
- Copies monorepo root and all workspace directories (includes `packages/` and `shared/`)
- Installs production-only dependencies: `npm ci --omit=dev`
- Copies compiled `dist/` from builder stage
- Exposes port 3000 for health checks
- Uses dumb-init for proper signal handling
- Sets Node.js memory limit (2GB)

**Why this approach?**
- Uses `.dockerignore` to exclude dev artifacts (`node_modules/`, `dist/`, `docs/`, etc.)
- Copies entire monorepo once instead of listing explicit directories
- Low maintenance: no need to update Dockerfile when directory structure changes
- npm workspaces create symlinks that need actual directories to exist in containers

#### Service Requirements

Each Node.js service must have:
- `package.json` with `"build": "tsc"` script
- TypeScript source in `src/`
- Entry point at `dist/index.js`
- Health check endpoint on port 3000

#### Why Copy packages/ and shared/ to All Containers?

npm workspaces create symlinks in `node_modules/` (e.g., `node_modules/@devvir/rabbitmq → ../../packages/rabbitmq`). For these symlinks to work in containers, the actual directories must exist. Since the shared libraries are small, it's simpler to include them in all containers rather than tree-shaking per service.

#### .dockerignore Configuration

The root `.dockerignore` file controls what gets copied into the build context:

**Excluded (not needed in container)**:
- `node_modules/` - Fresh install for each build stage
- `dist/` - Rebuilt from source
- `docs/` - Documentation only needed locally
- `.git/`, `.github/` - Version control & CI config
- `.env*` - Environment/secret files
- Test artifacts, IDE config, formatter configs

**Included (needed for build)**:
- All `package*.json` files
- `tsconfig.json`
- Source code in `src/`
- Test files (used during TypeScript compilation)
- All workspace directories

---

## Troubleshooting

### Module Not Found Error

**Problem**: `Cannot find module '@devvir/rabbitmq'`

**Solution**:
1. Verify `tsconfig.json` has the path alias
2. Run `npm install` in root
3. Check `src/index.ts` exports the symbol

### Path Alias Not Resolving

**Problem**: TypeScript shows error, but compiles anyway

**Solution**:
1. IDE cache issue: Restart IDE/VSCode
2. Rebuild: `npm run build`
3. Verify `tsconfig.json` path is correct

### Circular Dependencies

**Problem**: Package A imports B, B imports A

**Solution**:
1. Move common code to shared types
2. Services should not import from services
3. Use generic packages for cross-cutting concerns

### Build Fails on Missing Declarations

**Problem**: `dist/index.d.ts` not generated

**Solution**:
1. Check `package.json` has `"types": "dist/index.d.ts"`
2. Verify `tsconfig.json` has `"declaration": true`
3. Run `npm run build` again

---

## Files to Update When Adding Items

| Action | Files to Update |
|--------|-----------------|
| Add new package | `tsconfig.json` (paths) + `package.json` (workspaces if not using glob) |
| Add new service | Usually just create the directory; glob patterns handle it |
| Add new type | Update relevant service's imports |
| Change package name | Root `tsconfig.json` paths + all imports across codebase |
| Publish a package | Update `package.json` version + ensure `"private": false` |

---

## For Agent Development Tasks

### When Creating New Services

1. Copy structure from existing service (e.g., `services/feed/`)
2. Update `package.json` name to `@tradebot/[name]`
3. Set `"private": true`
4. Update imports from `@tradebot/feed` to `@tradebot/[name]`
5. Test locally: `cd services/[name] && npm test`

### When Creating New Packages

1. Decide: Will it be published? Yes → `packages/`, No → `shared/`
2. Use `@devvir/` for `packages/`, `@tradebot/` for `shared/`
3. Add path alias to root `tsconfig.json`
4. Export public API from `src/index.ts`
5. Add comprehensive tests
6. Add README with usage examples

### When Migrating Code Between Packages

1. Create source in new location
2. Export from `src/index.ts`
3. Update all imports across codebase
4. Remove old code
5. Run tests: `npm test`

---

## Key Files

| File | Purpose |
|------|---------|
| `/package.json` | Workspace definition, root scripts |
| `/tsconfig.json` | Path aliases for all packages |
| `packages/[name]/package.json` | Package metadata, dependencies, scripts |
| `services/[name]/package.json` | Service metadata, dependencies, scripts |
| `/dx/` | Development tools (git submodule) |
| `/docs/ai/` | Agent guidance (this file + others) |

---

## Related Documentation

- [SHARED_UTILS_MIGRATION.md](./SHARED_UTILS_MIGRATION.md) - Service migration process
- [service-architecture.md](./service-architecture.md) - Architecture decisions
- Individual `README.md` in each package/service for specific details
