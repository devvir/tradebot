# Archivist Module

Subscribes to BitMEX market data streams and archives them to MongoDB with optional encoding and compression.

## Components

- **Feed** - Connects to BitMEX WebSocket and publishes all market data to RabbitMQ
- **Codec** - Transforms messages (optional encoding and compression)
- **Writer** - Persists transformed messages to MongoDB collections
- **RabbitMQ** - Message broker for Feed → Codec → Writer pipeline
- **MongoDB** - Persistent storage for archived market data

## Quick Start

Start the module:
```bash
tb up archivist
```

Build images and start:
```bash
tb up archivist --build
```

Stop the module:
```bash
tb down archivist
```

View logs:
```bash
tb logs archivist
```

## Configuration

Copy `.env.example` to `.env` and customize:
- `WRITER_DATABASE` - MongoDB database name (required)
- `CODEC_STRATEGY` - Transformation modes: `encode`, `binary`, or both (optional)
- Other configuration in `.env.example` with defaults documented

For detailed information about each service and the data pipeline, see [docs/modules/ARCHIVIST.md](../../docs/modules/ARCHIVIST.md).
