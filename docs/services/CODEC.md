# Codec Service - Technical Documentation

## Overview

The Codec service acts as a transformable bridge between two RabbitMQ exchanges. It consumes market data messages from an inbound queue, optionally applies encoding and/or compression strategies, and republishes to an outbound exchange. This enables flexible data processing pipelines with pluggable transformation logic.

## Architecture

### Message Flow

```
Inbound RabbitMQ Queue
    ↓ (pull with prefetch)
 Codec Service
    ↓ (parse JSON)
 Strategy Selection
    ├─ Pass-through → unchanged
    ├─ Encode → compact representation
    ├─ Binary → compressed binary
    └─ Combinations (encode + binary)
    ↓ (enrich headers with metadata)
 Outbound RabbitMQ Exchange
    ↓ (topic routing)
 Subscriber queues (routing keys: channel names)
```

### Transformation Modes

#### Pass-Through (default)

- **Input:** Raw JSON BitMEX messages
- **Output:** Identical JSON
- **Use case:** Message routing, temporary buffering, testing

#### Encode Mode

Reduces message size and normalizes structure:

1. Parse BitMEX message into typed structure
2. Extract action type (e.g., "insert", "update", "delete")
3. Encode action as compact 1-byte prefix
4. Remove redundant fields: `table`, `keys`, `types`, `filter`
5. Build document ID from: `timestamp` + `action` + `apiVersion`
6. Output as JSON with document ID in metadata headers

**Result:** ~10-20% size reduction, structured metadata for database storage

#### Binary Mode

Applies Brotli compression to the full payload:

1. Serialize payload to JSON string
2. Compress with Brotli codec
3. Set content-type to `application/octet-stream`
4. Output as binary Buffer

**Result:** ~40-70% size reduction (varies by data type)

**Combined with Encode:** Compression applied to already-compact encoded data

#### Decode Mode

Reverses encoding and decompression (inverse of encode+binary):

1. Decompress Brotli if payload is binary
2. Parse compressed/encoded message structure
3. Decode action from 1-byte prefix
4. Reconstruct original message fields
5. Output as JSON equivalent to original BitMEX message

**Result:** Reconstructs original message format from encoded/compressed form. Used to restore archived data to usable format (e.g., for analysis or replay).

**Validation:** Cannot be combined with `encode` or `binary` (validation enforced in config).

### Strategy Combinations & Validation

| Strategy | Valid? | Use Case | Notes |
|----------|--------|----------|-------|
| (empty or `passthru`) | ✓ | Message routing, buffering | No transformation overhead |
| `encode` | ✓ | Compact representation | ~10-20% size reduction + metadata |
| `binary` | ✓ | Compression only | ~40-70% size reduction (binary output) |
| `encode,binary` | ✓ | Maximum compression | Encode first, then compress binary |
| `decode` | ✓ | Decompress & restore | Inverse of `encode,binary` |
| `encode` + `decode` | ✗ | *Invalid* | Decode cannot combine with encode/binary |
| `binary` + `decode` | ✗ | *Invalid* | Decode cannot combine with encode/binary |
| `encode,binary` + `decode` | ✗ | *Invalid* | Decode is mutually exclusive |

**Validation Rules:**
- Passthru (`passthru` or empty) cannot be combined with other strategies
- Decode is mutually exclusive—cannot be combined with `encode` or `binary`
- Encode and binary can be combined in either order

### Document ID Generation

When encoding is enabled, a document ID is generated from:
- **Timestamp** - Extracted from first data item in message (UTC ISO string)
- **Action type** - BitMEX action (insert, update, delete, etc.)
- **API version** - From message header (e.g., "2.0.0")

Result: 8-byte big-endian integer, included in message headers as `metadata._id` for MongoDB ingestion.

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RABBITMQ_URL` | Yes | - | RabbitMQ connection string |
| `CODEC_INBOUND_EXCHANGE` | Yes | - | Source topic exchange name |
| `CODEC_INBOUND_QUEUE` | Yes | - | Source queue name |
| `CODEC_OUTBOUND_EXCHANGE` | Yes | - | Destination topic exchange name |
| `CODEC_OUTBOUND_QUEUE` | Yes | - | Destination queue name |
| `CODEC_STRATEGY` | No | (empty) | `passthru` (same as empty), `encode`, `binary`, `encode,binary`, `decode` |
| `CODEC_PREFETCH` | No | `100` | RabbitMQ prefetch window (messages buffered per consumer) |
| `CODEC_BROTLI_QUALITY` | No | `4` | Brotli compression quality (0-11: 0=fastest, 11=best) |

### Queue Configuration

- **Inbound queue** declares from `CODEC_INBOUND_EXCHANGE` with routing key `#` (receive all messages)
- **Outbound exchange** publishes with routing key = source channel name (e.g., "trade", "orderBookL2")
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
- No messages processed within 60 seconds

### Metrics

- **`messagesProcessed`** - Cumulative count of messages consumed and published
- **`lastProcessedTime`** - Milliseconds since last message processed
- **`brokerConnected`** - Boolean indicating RabbitMQ connectivity

## Usage Modules

The Codec service is used by:
- **archivist module** - Feed → Codec → Writer (data consumption and compression for long-term archive)
- **rearchivist module** - Reader → Codec → Writer (data transformation, from raw to archive)
- **unarchivist module** - Reader → Codec → Writer (data transformation, from archive to raw)

Example configuration for archivist:
```bash
CODEC_INBOUND_EXCHANGE=ex.feed          # Consumes from feed output
CODEC_INBOUND_QUEUE=q.feed
CODEC_OUTBOUND_EXCHANGE=ex.archive      # Publishes to writer input
CODEC_OUTBOUND_QUEUE=q.archive
CODEC_STRATEGY=encode,binary            # Apply both transformations
CODEC_PREFETCH=100
CODEC_BROTLI_QUALITY=4
```

## Performance Characteristics

Throughput scales with:
- Prefetch window size
- Data size (compression overhead increases with larger payloads)
- Brotli quality setting (higher quality = slower compression)
