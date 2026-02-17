# Codec Service

Stateless transformation service that consumes BitMEX market data from RabbitMQ, applies custom transformations, and publishes transformed messages to downstream processors for persistence.

## Features

- Consumes messages from the `bitmex-feed` queue
- Applies configurable message transformations (pass-through by default)
- Publishes transformed data to the `archivist` queue
- No external database dependencies
- Stateless and horizontally scalable
- Health check endpoint for monitoring
- Automatic reconnection with exponential backoff

## Quick Start

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RABBITMQ_URL` | `amqp://guest:guest@rabbitmq:5672` | RabbitMQ connection URL |
| `LOG_LEVEL` | `info` | Logging level (debug, info, warn, error) |

### Architecture

```
bitmex-feed queue → codec service → archivist queue
```

The codec acts as a transformation layer between the feed and persistence, allowing for:
- Data normalization and validation
- Encoding/decoding (for compression or serialization)
- Filtering or enrichment
- Custom business logic on incoming data

### Health Check

The service exposes a health endpoint at `:3000/health` that returns:
- Connection status to RabbitMQ
- Message processing statistics
- Last activity timestamp

## Documentation

For detailed architecture and usage, see [docs/services/CODEC.md](../../docs/services/CODEC.md).

