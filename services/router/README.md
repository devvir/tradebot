# Router Service

Consumes messages from RabbitMQ queues and republishes them to other queues and exchanges, with
routing key rewrites and injected headers. One message can go to several destinations.

Deployed by: no module.

## Core Functionality

- **Rule-based routing** — source queue → destination queues and exchanges, set in `ROUTER_RULES`
- **Exchange bindings** — sources and destinations use the default exchange or a named exchange,
  which the router declares along with the queues
- **Routing key rewrites** — a static key, or a replaced key prefix
- **Header injection** — static AMQP headers added per destination
- **Fan-out** — one source to many destinations, each published at least once
- **Backpressure** — publishing pauses while watched queues are too full
- **Connection handling** — the publishing connection reconnects; losing the consuming connection
  ends the process for the container to restart it

## Development

```bash
pnpm install   # Install dependencies
pnpm build     # Compile TypeScript
pnpm test      # Run tests
```

## Configuration

Requires RabbitMQ — see [infra packs](../../modules/infra/README.md).

**Required:**
- `QUEUE_URL` — AMQP URL of the broker
- `ROUTER_RULES` — routing rules

The optional prefetch and backpressure settings, and what the router does with each rule, are in
the Configuration table and the rest of [docs/services/ROUTER.md](../../docs/services/ROUTER.md).
The rule syntax is the [rule grammar](../../shared/utils/README.md#rule-grammar) of `@tradebot/utils`.
