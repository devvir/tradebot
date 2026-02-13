# Reader Module

Data ingestion pipeline combining feed reader, archivist, and supporting infrastructure.

Includes:
- **feed** - BitMEX WebSocket reader
- **archivist** - Data deduplication and archival
- **rabbitmq** - Message queue for data flow
- **mongodb** - Persistent storage

## ⚠️  First-Time Setup

**BEFORE running this module**, you MUST change the default credentials:

1. Copy `.env.example` to `.env` if you haven't already
2. Replace user and password placeholders with real credentials
3. Use strong, unique passwords for both RabbitMQ and MongoDB

**Why?** Both RabbitMQ and MongoDB are configured to allow remote connections. Using default or placeholder credentials exposes your services to unauthorized access.

## Configuration

See `.env.example` for all available configuration options.

Key settings:
- `RABBITMQ_USER` / `RABBITMQ_PASS` - Queue access credentials
- `MONGODB_USER` / `MONGODB_PASS` - Database access credentials
- `FEED_CHANNELS` - BitMEX data channels to subscribe to
- `FEED_SYMBOLS` - Trading pairs to monitor
