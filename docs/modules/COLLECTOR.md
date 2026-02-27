# Collector Module - Technical Documentation

## Overview

The Collector module implements a data collection pipeline for subscribing to BitMEX market data streams and storing them in MongoDB. It handles WebSocket connection management, message routing, and persistent storage without transformation.

## Purpose

- Subscribe to all BitMEX market data channels (trades, order books, instruments, etc.)
- Collect all market data in raw format for future replay by other modules
- Persist all messages to MongoDB for analysis and downstream processing
- Implement automatic reconnection and graceful error handling

## Data Flow

```
BitMEX WebSockets
    ↓ (market data)
 Feed Service
    ↓ (RabbitMQ topic exchange)
 RabbitMQ (ex.collect)
    ↓ (routing key: channel name)
 Writer Service
    ↓ (MongoDB insertOne)
 MongoDB (collections by channel)
```

## Services

### Feed

Consumes market data from BitMEX WebSocket endpoints and publishes to RabbitMQ.

**Key Configuration:**
- `FEED_EXCHANGE` - Topic exchange for feed data (default: `ex.collect`)
- `FEED_QUEUE` - Queue name (default: `q.collect`)
- `BITMEX_TESTNET` - Use testnet data (optional)
- `FEED_MAX_RECONNECT_DELAY_MS` - Maximum reconnection backoff (default: 60000)

**See:** [services/feed documentation](../../services/feed/README.md)

### Writer

Persists messages to MongoDB collections, keyed by message routing key (channel name).

**Key Configuration:**
- `WRITER_DATABASE` - Target MongoDB database (required)
- `WRITER_EXCHANGE` - Source exchange (default: `ex.collect`)
- `WRITER_QUEUE` - Queue name (default: `q.collect`)
- `WRITER_BATCH_SIZE` - RabbitMQ prefetch window (default: 1000)

**See:** [services/writer documentation](../../services/writer/README.md)

## Infrastructure Services

### RabbitMQ

Message broker connecting Feed → Writer pipeline.

- Declares `ex.collect` topic exchange (auto-created by services)
- Handles message routing by channel/collection name
- TTL configured per module instance

**See:** [services/rabbitmq documentation](../../services/rabbitmq/README.md)

### MongoDB

Persistent document storage for collected market data.

- One collection per channel (e.g., `trades`, `orderBookL2`, `instrument`)
- Unique index on `_id` prevents duplicate documents
- Documents stored in raw format from BitMEX WebSocket

**See:** [services/mongodb documentation](../../services/mongodb/README.md)

## Module Management

### Starting the Module

```bash
tb up collector
```

Starts all services (Feed, Writer, RabbitMQ, MongoDB) in containers.

### Building Images

```bash
tb up collector --build
```

Rebuilds TypeScript services before starting.

### Stopping the Module

```bash
tb down collector
```

Gracefully shuts down all services and removes containers (data persists).

### Viewing Logs

```bash
tb logs collector
```

Streams logs from all running services in the module.

### Checking Service Status

```bash
tb ps collector
```

Shows status of all services in the module.

## Configuration

Configuration is managed via environment variables in `.env`:

### Service Replicas (Docker Swarm)

- `FEED_REPLICAS` - Number of Feed instances (default: 1)
- `WRITER_REPLICAS` - Number of Writer instances (default: 1)

### Feed Service

- `FEED_EXCHANGE` - RabbitMQ exchange (default: `ex.collect`)
- `FEED_QUEUE` - Queue name (default: `q.collect`)
- `FEED_RECONNECT_DELAY_MS` - Initial backoff (default: 5000)
- `FEED_MAX_RECONNECT_DELAY_MS` - Maximum backoff (default: 60000)
- `FEED_MESSAGE_TTL` - RabbitMQ message TTL (default: 1800000 = 30 min)

### Writer Service

- `WRITER_DATABASE` - MongoDB database name (default: `tradebot`)
- `WRITER_EXCHANGE` - Source exchange (default: `ex.collect`)
- `WRITER_QUEUE` - Queue name (default: `q.collect`)
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
- MongoDB write latency
- RabbitMQ prefetch window size

With default settings:
- Feed: ~100k+ messages/sec throughput
- Writer: Limited by MongoDB insert latency
- No transformation overhead

## Use Cases

**Data Collection & Replay**: Collector stores all BitMEX messages as they arrive. Other modules (Archivist, Unarchivist, etc.) consume from this unified stream, each applying their own transformations without needing to connect directly to BitMEX.

**Historical Analysis**: Raw messages in MongoDB enable retrospective analysis without worrying about storage format or compression schemes.

**Multi-Consumer Scenarios**: Multiple modules can independently process the same data stream at their own pace without interfering with each other.
