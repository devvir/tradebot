# Router Service

Routes messages between RabbitMQ queues and exchanges with configurable routing key transforms and header injection. Supports fan-out to multiple destinations and flexible exchange bindings.

## Core Functionality

- **Queue-based routing** — configurable source queue → destination queue/exchange mappings
- **Flexible exchange binding** — sources/destinations can use the default exchange or bind to explicit exchanges
- **Routing key transforms** — static routing keys or string replacement on incoming routing keys
- **Header injection** — inject static AMQP headers into republished messages per destination
- **Fan-out routing** — single source to multiple destinations
- **Durable queues** — messages persist across router restarts
- **Automatic reconnection** — via service-kit provider retry

## Development

```bash
pnpm install   # Install dependencies
pnpm build     # Compile TypeScript
pnpm test      # Run tests
```

## Configuration

**Required:**
- `RABBITMQ_URL` — RabbitMQ connection string
- `ROUTER_RULES` — Routing rules (see tech docs for syntax)

For technical details, see [docs/services/ROUTER.md](../../docs/services/ROUTER.md).
