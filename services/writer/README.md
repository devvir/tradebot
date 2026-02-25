# Writer Service

Consumes messages from RabbitMQ queue and persists them to MongoDB collections.

## Core Functionality

- **Queue consumption** from RabbitMQ with configurable prefetch
- **Message routing** - uses routing key to determine target MongoDB collection
- **Metadata merging** - combines message headers and content into documents
- **Binary support** - handles both JSON and binary (compressed) message payloads
- **Graceful error handling** - silently handles duplicate key errors, retries other failures
- **Health monitoring** - exposes health check endpoint with activity metrics

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
- `WRITER_DATABASE` - Target database name
- `RABBITMQ_URL` - RabbitMQ connection string
- `WRITER_EXCHANGE` - Source topic exchange name
- `WRITER_QUEUE` - Source queue name
- `WRITER_BATCH_SIZE` - RabbitMQ prefetch window (messages buffered per consumer)
- `WRITER_BATCH_TIMEOUT_MS` - Batch timeout in milliseconds

## Health Check

```bash
curl http://localhost:3000/health
```

Returns:
- **200 OK** - Service is healthy (MongoDB and RabbitMQ connected, recent activity)
- **503 Service Unavailable** - Missing connections or no activity for 60+ seconds

Response includes:
- `messagesProcessed` - Total messages ACKed
- `lastProcessedTime` - Milliseconds since last processed message

For detailed implementation information, see [docs/services/WRITER.md](../../docs/services/WRITER.md).
