<!-- Pending Review -->
# Writer Service

Consumes messages from a RabbitMQ topic exchange and persists them to MongoDB.

## Core Functionality

- **Topic exchange routing** — declares a `writer` exchange (type: topic) with three queues bound by routing key pattern
- **Message persistence** — stores message content as-is into MongoDB documents
- **Binary support** — handles both JSON and binary (compressed) message payloads
- **Idempotent writes** — silently acknowledges duplicate key errors (11000), retries other failures
- **Health monitoring** — exposes health check endpoint with activity metrics

## Routing

Messages are routed by publishing to the `writer` exchange with a routing key:

| Routing Key | Queue | Database | Collection |
|---|---|---|---|
| `archive.<collection>` | `archive` | `DATABASE_ARCHIVE` | `<collection>` |
| `collect.<collection>` | `collect` | `DATABASE_COLLECT` | `<collection>` |
| `custom.<db>.<col>` | `custom` | `<db>` | `<col>` |

Examples:
- `archive.orderBookL2` → `tradebot_archive.orderBookL2`
- `collect.trade` → `tradebot_collect.trade`
- `custom.mydb.mycol` → `mydb.mycol`

Messages with unresolvable routing keys are nacked without requeue and routed to the `writer.dead-letter` queue via the `writer.dlx` fanout exchange.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `MONGODB_URL` | Yes | — | MongoDB connection string |
| `RABBITMQ_URL` | Yes | — | RabbitMQ connection string |
| `WRITER_PREFETCH` | No | `1000` | RabbitMQ prefetch window |
| `DATABASE_ARCHIVE` | Yes | `tradebot_archive` | Database for `archive.*` messages |
| `DATABASE_COLLECT` | Yes | `tradebot_collect` | Database for `collect.*` messages |

## Scripts

```bash
pnpm build           # Compile TypeScript
pnpm start           # Run compiled service
pnpm dev             # Watch mode with ts-node
pnpm test            # Run test suite
pnpm test:watch      # Watch mode tests
pnpm test:coverage   # Coverage report
```

## Health Check

```bash
curl http://writer:3000/health
```

- **200 OK** — MongoDB and RabbitMQ connected, recent activity
- **503 Service Unavailable** — missing connections or no activity for 60+ seconds

Response includes:
- `messagesProcessed` — total messages acknowledged
- `lastProcessedTime` — milliseconds since last processed message

For detailed technical documentation, see [docs/services/WRITER.md](../../docs/services/WRITER.md).
