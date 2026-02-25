# Reader Service

Polls MongoDB collections at regular intervals and publishes discovered documents to RabbitMQ.

## Core Functionality

- **Collection polling** at configurable intervals
- **Automatic discovery** of newly inserted documents
- **Out-of-order resilience** - handles documents that arrive with non-sequential timestamps
- **State persistence** - resumes from checkpoint on restart (no duplicate publishing)
- **Health monitoring** - reports connection and activity status

## Installation

```bash
pnpm install
```

## Building

```bash
pnpm build
```

## Development

```bash
pnpm dev            # Watch mode with ts-node
pnpm test           # Run test suite
pnpm test:watch     # Watch mode tests
pnpm test:coverage  # Coverage report
```

## Running

```bash
pnpm start
```

## Configuration

**Required:**
- `MONGODB_URL` - MongoDB connection string
- `READER_DATABASE` - Source database name
- `RABBITMQ_URL` - RabbitMQ connection string
- `READER_EXCHANGE` - Destination topic exchange name
- `READER_QUEUE` - Destination queue name
- `READER_BATCH_SIZE` - RabbitMQ batch size (prefetch window)
- `READER_POLL_INTERVAL_MS` - Time between collection polls (milliseconds)

**Optional:**
- `READER_COLLECTIONS` - Comma-separated collection names to poll (default: all collections)

## Health Check

```bash
curl http://localhost:3000/health
```

Returns:
- **200 OK** - Service is healthy (MongoDB and RabbitMQ connected, recent polling activity)
- **503 Service Unavailable** - Missing connections or no activity for 60+ seconds

For implementation details, see [docs/services/READER.md](../../docs/services/READER.md).
