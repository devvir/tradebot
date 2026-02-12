# TradeBot Service Architecture

## Overview

TradeBot is built on a **service-oriented architecture** with two complementary organizational levels: **services** and **modules**.

This document describes the architectural principles that govern how services are designed, how they interact, and how they are composed into deployable units.

## Note

The examples in this file are NOT documentation of existing features; they're just meant to showcase the principles described. This document describes guidelines, not implementation details.

## Core Principles

### 1. Services Are Independent Units

Each **service** is a standalone, self-contained unit of functionality. Services have no knowledge of or dependency on other services at the code level.

- A service provides a specific capability (e.g., fetch data, store data, route messages)
- A service has zero assumptions about who is using it or how it will be deployed
- A service succeeds or fails on its own terms, not based on the availability of other services

**Implication:** If a service has upstream or downstream dependencies (another service it needs to function), those dependencies are specified via **environment variables at runtime**, not baked into the code.

### 2. Environment Variables Are the Contract

Services communicate with each other indirectly through environment variables that specify the location and credentials of other services.

**Example:**
- The `archivist` service needs to consume messages from RabbitMQ and write to MongoDB
- It doesn't contain hardcoded queue names or database URLs
- Instead, it reads:
  - `RABBITMQ_URL` - Where to find the queue
  - `MONGODB_URL` - Where to find the database
  - `BATCH_SIZE`, `BATCH_TIMEOUT_MS` - How to process

This allows:
- The same service code to work against different queue/database instances
- Different deployments to wire services together differently
- Services to be tested in isolation with mock/test versions of dependencies

### 3. Services Operate Independently of Their Consumers

A service does not fail just because nobody is using it. It simply exists and offers its services.

**Examples of this principle in practice:**

#### Feed Service Without Queue
The feed service can connect to BitMEX and fetch market data even if there is no downstream queue or consumer. Options:
- Fire-and-forget: Fetch data and send it without waiting for acknowledgement
- Log and ignore: Log the failure and move on
- Circuit breaker: Detect queue unavailability and gracefully degrade

The feed service succeeds in its job—fetching data—regardless of whether that data goes somewhere.

#### Queue Without Consumers
RabbitMQ can operate perfectly fine without any consumers listening. It will:
- Accept published messages
- Store them according to its configuration (durable queues, persistence, TTL)
- Deliver them when a consumer arrives
- Expire messages after TTL to prevent unbounded memory growth

The queue succeeds in its job—holding messages—regardless of consumption patterns.

#### Database Without Users
MongoDB runs and operates normally whether or not anything is writing to or reading from it. It doesn't care about its clients.

### 4. Services Are Infrastructure-Like

The best mental model is to think of services like actual infrastructure primitives: a database, a message queue, a cache.

A database:
- Doesn't know who will use it
- Doesn't validate that consumers understand its schema
- Doesn't fail if used incorrectly (it may return errors, but the database keeps running)
- Can be accessed by many clients simultaneously
- Offers its services unconditionally

Services in TradeBot should have this same mindset.

## Structure

### Service Folder Layout

Each service lives in its own folder under `services/` with a consistent structure:

```
services/<service-name>/
├── README.md              # Service documentation
├── docker/
│   ├── Dockerfile         # Container definition (if needed)
│   └── compose.yml        # Service definition for docker-compose
├── [source code]          # Language-specific structure (optional)
├── [build files]          # Language-specific: package.json, pyproject.toml, go.mod, etc. (optional)
└── [tests]                # Language-specific test structure (optional)
```

**Key principles:**
- **Infrastructure services** (rabbitmq, mongodb) have only `docker/` folder with no source code or build files
- **Application services** have source code + language-specific build files (Node: package.json, Python: pyproject.toml, Go: go.mod, etc.)
- `docker/compose.yml` defines how this service runs as a container
- `docker/compose.yml` is NOT a full multi-service compose file; it defines only this service
- Each service is self-documenting via README.md
- Source code structure and build system are language-specific and not mandated

**Examples of application service layouts:**

*Node/TypeScript service:*
```
src/
  index.ts
  config.ts
  logger.ts
package.json
tsconfig.json
tests/
  index.test.ts
```

*Python service:*
```
src/
  main.py
  config.py
  logger.py
pyproject.toml
# or: requirements.txt, setup.py
tests/
  test_main.py
```

*Go service:*
```
cmd/
  main.go
pkg/
  config.go
go.mod
Makefile
```

### Module Folder Layout

Modules are compositions of services. Each module lives in `modules/` with:

```
modules/<module-name>/
├── README.md              # Module documentation (high-level purpose)
├── .env                   # Default environment variables for this module
└── compose.yml            # Includes references to service compose files
```

A module's `compose.yml` uses Docker Compose's [`include` directive](https://docs.docker.com/compose/compose-file/compose-file-v3/#include) to reference service compose files without duplication:

```yaml
include:
  - ../../services/feed/docker/compose.yml
  - ../../services/rabbitmq/docker/rabbitmq.yml
  - ../../services/mongodb/docker/mongodb.yml
  - ../../services/archivist/docker/compose.yml
```

### Service Configuration

Services read their configuration from **environment variables only**. No static configuration files, no service discovery, no registry lookups.

Configuration precedence:
1. Environment variable (required)
2. Hardcoded default in code (if safe to default)
3. Throw error (if configuration is required and no default)

**This pattern is universal across all languages.** Example implementations:

*TypeScript (Node):*
```typescript
export const loadConfig = () => {
  return {
    bitmexWsUrl: process.env.BITMEX_WS_URL || 'wss://www.bitmex.com/realtime',
    rabbitmqUrl: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
  };
};
```

*Python:*
```python
import os

class Config:
    bitmex_ws_url = os.getenv('BITMEX_WS_URL', 'wss://www.bitmex.com/realtime')
    rabbitmq_url = os.getenv('RABBITMQ_URL', 'amqp://guest:guest@localhost:5672')
```

*Go:*
```go
import "os"

type Config struct {
    BitmexWsUrl string
    RabbitmqUrl string
}

func NewConfig() *Config {
    return &Config{
        BitmexWsUrl: getEnv("BITMEX_WS_URL", "wss://www.bitmex.com/realtime"),
        RabbitmqUrl: getEnv("RABBITMQ_URL", "amqp://guest:guest@localhost:5672"),
    }
}
```

The principle is identical: **load from environment, use defaults where safe, fail hard if required config is missing.**

## Communication Patterns

### Service-to-Service Communication

Services do **not** call each other directly in code. Communication is async and decoupled:

1. **Via message queue (async)**: Services publish to RabbitMQ topics; other services consume from those topics
2. **Via database (shared state)**: Services read from and write to MongoDB
3. **Via environment variables (static)**: One service publishes its endpoint; another reads it from env

**This ensures:**
- No circular dependencies
- No cascading failures (if service A is down, service B doesn't hang waiting for A)
- Services can be restarted, replaced, or redeployed without affecting others
- Testing can substitute mock services via environment variable injection

### Within a Module

When services are composed into a module (e.g., the "reader" module), they are wired together through the module's environment variables:

```bash
# In modules/reader/.env or docker-compose environment block
FEED_RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672
ARCHIVIST_RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672
ARCHIVIST_MONGODB_URL=mongodb://root:password@mongodb:27017
```

Each service reads these variables and knows how to reach the services it depends on.

## Adding a New Service

When adding a new service to the project, follow this checklist:

1. **Create folder** under `services/<name>/`
2. **Add docker definition** at `docker/compose.yml` defining:
   - Container image
   - Port mappings
   - Environment variable defaults
   - Health checks (if applicable)
   - Dependencies and networks
3. **Add README.md** describing:
   - What the service does
   - Its responsibilities
   - When it would be used
4. **If application service** (has code):
   - Add language-specific dependency files (package.json, pyproject.toml, go.mod, Cargo.toml, etc.)
   - Add language-specific build configuration (tsconfig.json, Makefile, setup.py, etc.)
   - Add `src/` or equivalent folder with implementation
   - Implement configuration loading from environment variables only
   - Add health check endpoint (HTTP GET, TCP port check, or language-specific equivalent)
   - Add structured logging (language-appropriate: pino for Node, logging for Python, etc.)
5. **Document all environment variables** in README.md
6. **No need to update hardcoded lists** - The orchestration scripts automatically discover services from the filesystem

## Adding a New Module

When creating a new module:

1. **Create folder** under `modules/<name>/`
2. **Add compose.yml** that includes the services needed:
   ```yaml
   include:
     - ../../services/service1/docker/compose.yml
     - ../../services/service2/docker/compose.yml
   ```
3. **Add .env** with module-specific defaults
4. **Add README.md** describing:
   - Purpose of the module
   - Which services it includes and why
   - Example use cases
   - How to run it
5. **No need to update hardcoded lists** - The orchestration scripts automatically discover modules

## Key Design Decisions

### Why No Direct Service Calls?

In a single-process monolith, services might call each other directly. In TradeBot:
- Each service can be a separate process/container
- Direct calls would require knowing each service's internal API (tight coupling)
- Each service can be written in a different language without problems
- Failures in one service don't cascade to another

### Why Environment Variables for Configuration?

- **Standard:** Docker/Kubernetes/cloud platforms all use environment variables for configuration
- **Testable:** Easy to substitute test values by changing environment variables
- **Flexible:** Same code works in dev, staging, production with different env values
- **No secrets in code:** Credentials are never hardcoded
- **No service discovery:** We don't need a service registry; the orchestrator provides addresses

### Why Modules Instead of Just Services?

- **Reusability:** A service can be used in multiple modules
- **Composition:** Different modules might need different combinations of services
- **Deployment:** Each module is a self-contained deployable unit
- **Testing:** Easy to stand up a full "mini app" (a module) for integration testing
- **Clarity:** It's clear what services work together and why

## Growth Implications

This architecture scales well as the application grows:

### Adding a 13th Service
- Create `services/service13/` with its compose.yml
- Set its dependencies in the env variables
- Existing services and modules are unaffected
- No hardcoded registries to update

### Added a 7th Module
- Create `modules/module7/` with compose.yml that includes the right services
- The scripts automatically list it in `npm run modules`
- No hardcoded module lists to maintain

### Changing How Services Connect
- Modify the module's env variables or compose.yml
- Services don't need to change (they just read new env vars)
- Modules can be independently tested without rebuilding services

### Running Only Part of the System
- Just run the needed module
- That module brings in exactly the services it needs
- Other services aren't touched

## Terminology

- **Service**: A single unit of functionality (feed, queue, database, etc.). Has a folder under `services/`. Can be written in any language (Node, Python, Go, PHP, Rust, etc.).
- **Application service**: A service with source code and a language-specific build process. Examples: feed service (Node), worker service (Python), analysis service (Go).
- **Infrastructure service**: A service that is purely a container image with no application code. Examples: RabbitMQ, MongoDB.
- **Module**: A composition of services into a deployable unit. Has a folder under `modules/`.
- **Orchestration script**: Tooling in `dx/` that manages services and modules automatically via filesystem discovery. Works with all languages and service types.
- **Configuration**: Environment variables that specify service locations, credentials, and behavior. Used uniformly regardless of service language.
- **Container**: Docker container running a service.
