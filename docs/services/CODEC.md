# Codec Service - Technical Documentation

## Overview

The Codec service acts as a transformation bridge between two RabbitMQ queues. It consumes market data messages from an inbound queue, applies encoding, decoding or compression strategies, and republishes to an outbound queue. This enables flexible data processing pipelines with pluggable transformation logic.

## Transform strategy

The transform strategy is defined by the first part of the routingKey of the consumed messages:

- **Encode**: compact representation with field reduction (e.g. routingKey = `encode.trade`)
- **Compress**: Brotli compression, on top of `encode` (e.g. routingKey = `compress.trade`)
- **Decode**: decompress and decode (inverse of encode and compress) (e.g routingKey = `decode.trade`)
- **Passthru**: add unique deduplicating `_id` field without transforming payload (e.g. routingKey = `passthru.trade`)

Codec subscribes to all strategies in its own exchange (`codec.in`) and queue (`codec`).


## Architecture

### Message Flow

```
Inbound RabbitMQ Queue
    ↓ (consume from `codec` queue in its own `codec.in` topic exchange)
 Codec Service
    ↓ (transform)
 Strategy Selection
    ├─ Decode → recover original message
    ├─ Encode → compact representation
    ├─ Compress → compressed binary (brotli)
    ↓ (republish preserving original properties and metadata)
 Outbound RabbitMQ Queue
    ↓ (publish to `codec.out` topic exchange)
 Downstream consumer (e.g., Writer)
```

### Transformation Modes

#### Encode Mode

Reduces message size and normalizes structure:

1. Parse BitMEX message into typed structure
2. Extract action type (e.g., "insert", "update", "delete")
3. Remove redundant fields: `table`, `keys`, `types`, `filter`
4. Convert enumerable fields (enum-like) to numeric
5. Pack several fields into single numbers (encode)
5. Build document ID from: `timestamp(42 bits)` + `apiVersion(9 bits)` + `action(2 bits)` = 53 bits
6. Embed document ID (`_id`) directly in the message payload as a plain number

**Result:** ~60% size reduction

#### Compress Mode

Applies Brotli compression to the encoded payload (i.e. implies `encode`):

1. Serialize payload to JSON string
2. Apply encode strategy
3. Compress with Brotli codec

**Result:** ~75% size reduction (varies by data type)

#### Decode Mode

Reverses encoding and/or compression (inverse of encode and compress):

1. Decompress Brotli if payload is compressed
2. Parse compressed/encoded message structure
3. Reconstruct original message fields
4. Output as JSON equivalent to original BitMEX message

**Result:** Reconstructs original message. Used to restore archived data to usable format (e.g., for analysis or replay).

#### Passthru Mode

Adds a unique deduplicating `_id` field without transforming the payload:

1. Generate unique `_id` from timestamp + action + API version (same 53-bit layout as encode mode)
2. Embed `_id` directly in the message payload
3. Publish unchanged payload with new `_id` field

**Result:** Original message with identity field for idempotent inserts in MongoDB. Used in pipelines like Collector where data is stored without compression.

### Document ID Generation

Every message processed by the codec receives a deterministic numeric `_id`. This `_id` is a 53-bit integer that fits within JavaScript's `Number.MAX_SAFE_INTEGER`, so it can be queried as a plain number in MongoDB Compass, mongosh, and application code without `NumberLong()` wrappers.

The `_id` is computed from:
- **Timestamp** (42 bits) - milliseconds since 2000-01-01, extracted from the first data item
- **API version** (9 bits) - from the `api_version` message header (e.g., "2.0.0")
- **Action** (2 bits) - BitMEX action type (partial=0, insert=1, update=2, delete=3)

Bit layout (MSB → LSB): `timestamp(42) | apiVersion(9) | action(2)`

The `_id` is managed exclusively by `transform.ts`. Strategies do not set `_id`; they return the payload, and `transform` adds or preserves the `_id` via `getIdempotentId()`, which:
1. Checks for an existing numeric `_id` on the incoming message (preserves it)
2. Generates a new one from message metadata if none exists

For detailed encoding and table-specific implementation, see [encoding/README.md](../../services/codec/src/encoding/README.md).

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RABBITMQ_URL` | Yes | - | RabbitMQ connection string |
| `CODEC_PREFETCH` | No | `1000` | RabbitMQ prefetch window (messages buffered per consumer) |
| `CODEC_BROTLI_QUALITY` | No | `1` | Brotli compression quality (0-11: 0=fastest, 11=best) |

### Queue Configuration

- **Prefetch** controls backpressure: higher = faster throughput, lower = more balanced consumption

## Dependencies

### External Runtime Dependencies
- **RabbitMQ** - For message consumption and publishing
- **@devvir/service** - Lifecycle management framework
- **@devvir/rabbitmq** - RabbitMQ broker abstraction
- **@tradebot/utils** - Utilities (logging, URL handling)
- **@tradebot/types** - BitMEX message type definitions
- **Node.js zlib** - Brotli compression

## Error Handling

### Parse/Transform Failures

When a message fails to parse or transform:
1. Error is logged with context (table, action, first data item preview)
2. Message is republished in raw (unchanged) form
3. Processing continues with next message
4. Consumer NACKs with requeue to prevent message loss

**Result:** Malformed messages don't stop the pipeline; they degrade gracefully to pass-through mode.

## Health Monitoring

### Health Check Endpoint

```
GET /health
```

**Response (200 - Healthy):**
```json
{
  "messagesProcessed": 567890,
  "lastProcessedTime": 1500,
  "brokerConnected": true
}
```

**Response (503 - Unhealthy):**
Returned when:
- RabbitMQ broker not connected
- No messages processed within 3 minutes

## Usage Modules

The Codec service is used by:
- **archivist module** - Broadcast → Codec → Writer (data consumption and compression for long-term archive)
- **rearchivist module** - Reader → Codec → Writer (data transformation, from raw to archive)
- **unarchivist module** - Reader → Codec → Writer (data transformation, from archive to raw)

## Performance Characteristics

Throughput scales with:
- Prefetch window size
- Data size (compression overhead increases with larger payloads)
- Brotli quality setting (higher quality = slower compression)
