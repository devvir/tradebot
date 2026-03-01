# Archivist Module

## Overview

The Archivist module implements a complete data pipeline for subscribing to BitMEX market data streams and archiving them to MongoDB with optional encoding and compression.

## Pipeline

```
BitMEX WebSocket → Broadcast → Codec → Writer → MongoDB
```

1. **Broadcast** connects to BitMEX WebSocket endpoints and publishes all received market data messages to RabbitMQ.

2. **Codec** consumes messages from Broadcast's output, applies configurable transformation strategies, and republishes them. For archival, `encode,binary` is recommended — encoding compacts the representation (~10-20% reduction), then Brotli compression reduces it further (~40-70%).

3. **Writer** consumes transformed messages and persists each one to MongoDB.

Data flow between services is wired via RabbitMQ queue overrides in the module's `compose.yml`. Each service publishes to and consumes from configurable queues, connected together by the module configuration. See `.env.example` for available settings.

## Message Routing

Writer is a shared service — a single instance can serve multiple pipelines and databases. It makes no assumptions about where data comes from or where it goes. Instead, every message must carry its own routing information via AMQP headers:

- **`table`** (required) — Target MongoDB collection name. Set automatically by Broadcast (from the BitMEX channel name, e.g., `trade`, `orderBookL2`) and by Reader (from the source collection name).

Broadcast and Reader are agnostic about headers — they attach whatever the module configures via `*_HEADERS` without interpreting them. Codec passes all headers and the routing key through to the next stage, transparently and unconditionally. Writer is the consumer that gives these headers meaning: `database` selects the MongoDB database and `table` selects the collection. The message content is stored as-is — if upstream services (like Codec) need something in the document, they put it in the message payload.

## Usage

```bash
tb up archivist          # Start all services
tb up archivist --build  # Rebuild and start
tb down archivist        # Stop all services
tb logs archivist        # Stream logs
tb ps archivist          # Check service status
```

## Configuration

Copy `.env.example` to `.env` and customize. See each service's documentation for the full list of available environment variables:

- [Broadcast](../../services/broadcast/README.md)
- [Codec](../../services/codec/README.md)
- [Writer](../../services/writer/README.md)

## Resilience

- **Broadcast** reconnects automatically with exponential backoff on WebSocket failure
- **Writer** silently handles duplicate key errors (idempotent inserts) and NACKs other failures for retry
- **RabbitMQ** durably buffers messages between pipeline stages; acknowledged only after successful persistence
- **Graceful shutdown** allows in-flight messages to complete before exit
