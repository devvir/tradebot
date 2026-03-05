# Reader Service

Polls MongoDB collections at regular intervals and publishes discovered documents to RabbitMQ.

## Core Functionality

- **Collection polling** at configurable intervals
- **Automatic discovery** of newly inserted documents
- **Out-of-order resilience** - handles documents that arrive with non-sequential timestamps
- **State persistence** - resumes from checkpoint on restart (no duplicate publishing)
- **Health monitoring** - reports connection and activity status

## Development

```bash
pnpm install   # Install dependencies
pnpm build     # Compile TypeScript
pnpm test      # Run tests
```

## Configuration

**Required:**
- `RABBITMQ_URL` - RabbitMQ connection string
- `MONGODB_URL` - MongoDB connection string
- `READER_DATABASE` - Database name to read from
- `READER_POLL_INTERVAL_MS` - Time between collection polls (milliseconds)

**Optional:**
- `READER_COLLECTIONS` - Comma-separated collection names to poll (default: all non-system collections)
- `READER_MAX_READY` - Max messages in the `reader` queue before publishing pauses (default: `1000000`; `0` disables backpressure)

The service publishes to a `reader` topic exchange with routing key `reader.<database>`, and asserts a durable `reader` queue bound to that exchange. Downstream consumers (e.g. the router in each module) consume from this queue directly.

For technical details, see [docs/services/READER.md](../../docs/services/READER.md).
