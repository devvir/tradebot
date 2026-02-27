# Modules Quick Reference

## Infrastructure (shared Storage, Message Broker and Cache services)

| Group | Module | Description | Services | Status | Links |
|-------|--------|-------------|----------|--------|-------|
| Infra | **Infra** | Core infrastructure services | **Infra**: [rabbitmq](../../services/rabbitmq/README.md), [mongodb](../../services/mongodb/README.md), [redis](../../services/redis/README.md) | Done | [README](./infra/README.md) |
| Collect | **Collector** | Collects and stores raw RT data from Bitmex WS | **Infra**: [rabbitmq](../../services/rabbitmq/README.md), [mongodb](../../services/mongodb/README.md)<br>**Services**: [feed](../../services/feed/README.md), [writer](../../services/writer/README.md) | Done | [README](./collector/README.md) |
| Collect | **Archivist** | Collects, compresses and stores RT data from Bitmex WS | **Infra**: [rabbitmq](../../services/rabbitmq/README.md), [mongodb](../../services/mongodb/README.md)<br>**Services**: [feed](../../services/feed/README.md), [codec](../../services/codec/README.md), [writer](../../services/writer/README.md) | Done | [README](./archivist/README.md) |
| Transform | **Rearchivist** | Convert stored raw data to compressed format and store it in a new collection | **Infra**: [rabbitmq](../../services/rabbitmq/README.md), [mongodb](../../services/mongodb/README.md)<br>**Services**: [codec](../../services/codec/README.md), [writer](../../services/writer/README.md), [reader](../../services/reader/README.md) | WIP | [README](./rearchivist/README.md) |
| Transform | **Unarchivist** | Convert archived data to raw format and store it in a new collection | **Infra**: [rabbitmq](../../services/rabbitmq/README.md), [mongodb](../../services/mongodb/README.md)<br>**Services**: [codec](../../services/codec/README.md), [writer](../../services/writer/README.md), [reader](../../services/reader/README.md) | WIP | [README](./unarchivist/README.md) |
| Consume | **Bitmex** | Mimics and proxies Bitmex WS in real time for local consumers | **Infra**: [rabbitmq](../../services/rabbitmq/README.md)<br>**Services**: [feed](../../services/feed/README.md), [snapshots](../../services/snapshots/README.md), *bitmex-ws (missing)* | Draft | [README](./bitmex/README.md) |
| Test | **ServiceKit** | Test module for @devvir/service-kit library | **Infra**: [mongodb](../../services/mongodb/README.md), [rabbitmq](../../services/rabbitmq/README.md), [redis](../../services/redis/README.md)<br>**Services**: servicekit-1, servicekit-2, servicekit-3 | Tmp | [README](./servicekit/README.md) |

## Status Legend

- **Done**: Module is fully functional and stable
- **WIP**: Work in progress; core functionality present but may have incomplete features
- **Draft**: Early-stage module; may reference services not yet implemented or lack complete documentation
- **Tmp**: Temporary module for testing or validation; will be removed once no longer needed

## Common Operations

```bash
# Start a module
tb up <module-name>

# Stop a module
tb down <module-name>

# Follow logs (all services)
tb logs <module-name> -f

# Follow logs for specific service
tb logs <module-name> -f <service-name>

# Rebuild and restart (useful after code changes)
tb up <module-name> --build

# View running containers
tb ps
```

## Notes

- Each module can be deployed independently
- Infra services (rabbitmq, mongodb, redis) are shared infrastructure; use the **Infra** module to launch independently, or include them in other modules
- See individual module READMEs for configuration and detailed documentation
- See [services/](../../services/) for service-specific documentation and implementation details
