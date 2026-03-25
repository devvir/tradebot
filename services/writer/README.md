# Writer Service

Consumes messages from a RabbitMQ topic exchange and persists them to MongoDB. It is the single write path for all market data in the system.

## What it does

Messages arrive on the `writer` queue. The target database is read from the `x-writer-database` AMQP header (default: `tradebot`); the target collection is read from the `table` field in the message body. Writer batches documents by collection, flushes on a timer, and stores each with a generated `_id`.

Duplicate key errors are silently ACKed and trigger a partition slot rotation (see docs for details). Messages that fail for other reasons twice are dead-lettered to `writer.dead-letter` for inspection.

## Configuration

Requires RabbitMQ and MongoDB — see [infra packs](../../modules/infra/README.md).

| Variable | Default | Description |
|---|---|---|
| `WRITER_PREFETCH` | `1000` | Max unacked messages per consumer |
| `WRITER_FLUSH_INTERVAL_MS` | `50` | Max ms to hold a partial batch |
| `WRITER_REPLICAS` | `1` | Number of writer container instances |

## Development

```bash
pnpm install   # Install dependencies
pnpm build     # Compile TypeScript
pnpm test      # Run tests
```

For technical details, see [docs/services/WRITER.md](../../docs/services/WRITER.md).
