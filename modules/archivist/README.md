# Archivist Module

Subscribes to BitMEX market data streams and archives them to MongoDB with optional encoding and compression.

## Components

- **Broadcast** - Connects to BitMEX WebSocket and publishes all market data to RabbitMQ
- **Codec** - Transforms messages (optional encoding and compression)
- **Writer** - Persists transformed messages to MongoDB collections
- **RabbitMQ** - Message broker for Broadcast → Codec → Writer pipeline
- **MongoDB** - Persistent storage for archived market data

## Quick Start

```bash
tb up archivist
tb up archivist --build
tb down archivist
tb logs archivist
```

## Configuration

Copy `.env.example` to `.env` and customize.

See each service's documentation for the full list of available environment variables.

For detailed information about the data pipeline, see [docs/modules/ARCHIVIST.md](../../docs/modules/ARCHIVIST.md).
