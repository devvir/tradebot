# Archivist Module - Technical Documentation

## Overview

The Archivist module implements a complete data pipeline for subscribing to BitMEX market data streams and archiving them to MongoDB. It handles WebSocket connection management, optional message transformation, and persistent storage.

## Purpose

- Subscribe to all BitMEX market data channels (trades, order books, instruments, etc.)
- Optionally encode and/or compress messages to reduce storage footprint
- Persist all market data to MongoDB for analysis, backtesting, and compliance
- Implement automatic reconnection and graceful error handling

## Data Flow

```
BitMEX WebSockets
    ↓ (market data)
 Feed Service
    ↓ (RabbitMQ topic exchange)
 RabbitMQ (ex.feed)
    ↓ (routing key: channel name)
 Codec Service
    ↓ (transformation)
 RabbitMQ (ex.archive)
    ↓ (routing key: collection name)
 Writer Service
    ↓ (MongoDB insertOne)
 MongoDB (collections by channel)
```

## Services

### Feed

Consumes market data from BitMEX WebSocket endpoints and publishes to RabbitMQ.

**Key Configuration:**
- `FEED_EXCHANGE` - Topic exchange for raw feed data (default: `ex.feed`)
- `FEED_QUEUE` - Queue name (default: `q.feed`)
- `BITMEX_TESTNET` - Use testnet data (optional)
- `FEED_MAX_RECONNECT_DELAY_MS` - Maximum reconnection backoff (default: 60000)

**See:** [services/feed documentation](../../services/feed/README.md)

### Codec

Optionally transforms messages between Feed and Writer.

**Transformation Modes:**
- **Pass-through** (default) - No transformation
- **Encode** - Compact representation, ~10-20% size reduction
- **Binary** - Brotli compression, ~40-70% reduction
- **Both** - Encode then compress

**Key Configuration:**
- `CODEC_INBOUND_EXCHANGE` - Source exchange (default: `ex.feed`)
- `CODEC_OUTBOUND_EXCHANGE` - Destination exchange (default: `ex.archive`)
- `CODEC_STRATEGY` - Modes: `encode` and/or `binary` (optional)
- `CODEC_BROTLI_QUALITY` - Compression quality 0-11 (default: 4)
- `CODEC_PREFETCH` - Message buffer size (default: 100)

**See:** [services/codec documentation](../../services/codec/README.md)

### Writer

Persists messages to MongoDB collections, keyed by message routing key (channel name).

**Key Configuration:**
- `WRITER_DATABASE` - Target MongoDB database (required)
- `WRITER_EXCHANGE` - Source exchange (default: `ex.archive`)
- `WRITER_QUEUE` - Queue name (default: `q.archive`)
- `WRITER_BATCH_SIZE` - RabbitMQ prefetch window (default: 1000)

**See:** [services/writer documentation](../../services/writer/README.md)

## Infrastructure Services

### RabbitMQ

Message broker connecting Feed → Codec → Writer pipeline.

- Declares `ex.feed` and `ex.archive` topic exchanges (auto-created by services)
- Handles message routing by channel/collection name
- TTL configured per module instance

**See:** [services/rabbitmq documentation](../../services/rabbitmq/README.md)

### MongoDB

Persistent document storage for archived market data.

- One collection per channel (e.g., `trades`, `orderBookL2`, `instrument`)
- Unique index on `_id` prevents duplicate documents
- Documents include metadata (timestamp, action, API version) from Codec service

**See:** [services/mongodb documentation](../../services/mongodb/README.md)

## Module Management

### Starting the Module

```bash
tb up archivist
```

Starts all services (Feed, Codec, Writer, RabbitMQ, MongoDB) in containers.

### Building Images

```bash
tb up archivist --build
```

Rebuilds TypeScript services before starting.

### Stopping the Module

```bash
tb down archivist
```

Gracefully shuts down all services and removes containers (data persists).

### Viewing Logs

```bash
tb logs archivist
```

Streams logs from all running services in the module.

### Checking Service Status

```bash
tb ps archivist
```

Shows status of all services in the module.

## Configuration

Configuration is managed via environment variables in `.env`:

### Global

- `MODULE_NAME` - Container name prefix (default: `archivist`)

### Service Replicas (Docker Swarm)

- `FEED_REPLICAS` - Number of Feed instances (default: 1)
- `CODEC_REPLICAS` - Number of Codec instances (default: 1)
- `WRITER_REPLICAS` - Number of Writer instances (default: 1)

### Feed Service

- `FEED_EXCHANGE` - RabbitMQ exchange (default: `ex.feed`)
- `FEED_QUEUE` - Queue name (default: `q.feed`)
- `FEED_RECONNECT_DELAY_MS` - Initial backoff (default: 5000)
- `FEED_MAX_RECONNECT_DELAY_MS` - Maximum backoff (default: 60000)
- `FEED_MESSAGE_TTL` - RabbitMQ message TTL (default: 1800000 = 30 min)

### Codec Service

- `CODEC_INBOUND_EXCHANGE` - Source exchange (default: `ex.feed`)
- `CODEC_INBOUND_QUEUE` - Source queue (default: `q.feed`)
- `CODEC_OUTBOUND_EXCHANGE` - Destination exchange (default: `ex.archive`)
- `CODEC_OUTBOUND_QUEUE` - Destination queue (default: `q.archive`)
- `CODEC_STRATEGY` - Transformation modes: `encode`, `binary`, or both (optional)
- `CODEC_PREFETCH` - Message buffer size (default: 100)
- `CODEC_BROTLI_QUALITY` - Compression quality 0-11 (default: 4)

### Writer Service

- `WRITER_DATABASE` - MongoDB database name (required)
- `WRITER_EXCHANGE` - Source exchange (default: `ex.archive`)
- `WRITER_QUEUE` - Queue name (default: `q.archive`)
- `WRITER_BATCH_SIZE` - RabbitMQ prefetch (default: 1000)
- `WRITER_BATCH_TIMEOUT_MS` - Batch timeout (default: 5000)

## Error Handling & Resilience

- **Feed connection loss:** Automatic reconnection with exponential backoff (capped at max delay)
- **Duplicate documents:** MongoDB unique index on `_id` silently ignores duplicates
- **Processing failures:** Messages NACKed and requeued on error (except near-duplicates at MongoDB level)
- **Service crashes:** Checkpointed state allows recovery without data loss

## Performance Characteristics

Pipeline throughput depends on:
- BitMEX market data volume (market activity)
- Codec transformation mode and compression quality
- MongoDB write latency
- RabbitMQ prefetch window sizes

With default settings:
- Feed: ~100k+ messages/sec throughput
- Codec (pass-through): Minimal overhead
- Codec (binary+encode): ~5-15k messages/sec
- Writer: Limited by MongoDB insert latency

Horizontal scaling: Run multiple instances of Feed, Codec, or Writer to increase throughput (Docker Swarm deployment).

## Data Safety

- All market data persisted to MongoDB before processing completes
- RabbitMQ messages acknowledged only after successful persistence
- Graceful shutdown allows in-flight messages to complete before exit

## Monitoring

Health checks expose metrics:
- `Feed`: WebSocket connection status, messages published, last activity
- `Codec`: Message count, last activity time
- `Writer`: Messages stored, last activity time
- RabbitMQ & MongoDB: Connection status
