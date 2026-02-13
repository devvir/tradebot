# Docker Compose Strategy

## Service Reusability and Composition

TradeBot uses a two-level composition strategy to maintain service reusability while enabling module-specific configurations:

### Level 1: Generic Services (`include`)

Services define themselves with **no assumptions about their context or dependencies**. Each service is wholly self-contained in its compose file under `services/<service-name>/docker/compose.yml`.

Services should NOT declare `depends_on` on other services, or networks. This keeps them decoupled and reusable across different modules.

**Example:** [services/feed/docker/compose.yml](../../services/feed/docker/compose.yml)

### Level 2: Module Composition (`extends`)

Modules compose services using two complementary mechanisms:

#### A. Basic Infrastructure (`include`)
Services that don't have external dependencies (like RabbitMQ, MongoDB) are simply `include`d as-is:

```yaml
include:
  - path: ../../services/rabbitmq/docker/compose.yml
  - path: ../../services/mongodb/docker/compose.yml
```

#### B. Application Services (`extends`)
Services that depend on infrastructure are extended at the module level to inject `depends_on`:

```yaml
services:
  feed:
    extends:
      file: ../../services/feed/docker/compose.yml
      service: feed
    depends_on:
      - rabbitmq

  archivist:
    extends:
      file: ../../services/archivist/docker/compose.yml
      service: archivist
    depends_on:
      - rabbitmq
      - mongodb
```

This approach:
- **Preserves service genericity**: The feed service in `services/feed/docker/compose.yml` remains a standalone, reusable unit
- **Enables composition flexibility**: Different modules can compose the same service with different dependencies
- **Centralizes orchestration logic**: Module-level compose files own the wiring, not the services themselves
- **Scales across contexts**: A service used in multiple modules only needs to be defined once

### Reference Implementation

See [modules/reader/compose.yml](../../modules/reader/compose.yml) for a complete example using both `include` and `extends`.

## Merge Rules

When using `extends`, Docker Compose applies standard merge rules:
- **Mappings** (e.g., `environment`, `labels`): Values override, new keys merge in
- **Sequences** (e.g., `ports`, `volumes`): Items append with duplicates removed
- **Scalars** (e.g., `image`, `command`): First definition wins

For detailed merge semantics, see [Docker Compose Merge Documentation](https://docs.docker.com/reference/compose-file/merge/).
