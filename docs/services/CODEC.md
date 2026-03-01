# Codec Service - Technical Documentation

## Overview

The Codec service acts as a transformation bridge between two RabbitMQ queues. It consumes market data messages from an inbound queue, applies encoding, decoding or compression strategies, and republishes to an outbound queue. This enables flexible data processing pipelines with pluggable transformation logic.

# BSON Serialization

All published messages are BSON-serialized (content-type: application/bson) in order to preserve Buffers through rabbitMQ. Consumers should call `BSON.deserialize(message)` on messages received from Codec.

## Transform strategy

The transform strategy may be `encode`, `compress` or `decode`, and it's defined by the first part of the routingKey of the consumed messages:

- Encode: compact representation with field reduction (e.g. routingKey = `encode.trade`)
- Compress: Brotli compression, on top of `encode` (e.g. routingKey = `compress.trade`)
- Decode: decompress and decode (inverse of encode and compress) (e.g routingKey = `decode.trade`)

Codec subscribes to all three topics in its own exchange (`codec.in`) and queue (`codec`).


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
5. Build document ID from: `timestamp` + `action` + `apiVersion` + `encoder_version`
6. Embed document ID (`_id`) directly in the message payload

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

### Document ID Generation

When encoding is enabled, a document ID is generated from:
- **Timestamp** - Extracted from first data item in message (UTC ISO string)
- **Action type** - BitMEX action (partial, insert, update, or delete)
- **API version** - From message header (e.g., "2.0.0")
- **Encoder version** - From message header (e.g., "1.0.0")

Result: 8-byte big-endian integer, embedded as `_id` in the message payload.

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
- **Node.js bson** - Bson serialization for safe RabbitMQ transport

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
