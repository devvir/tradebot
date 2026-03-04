# Codec Service - Technical Documentation

## Overview

The Codec service acts as a transformation bridge between two RabbitMQ queues. It consumes market data messages from an inbound queue, applies encoding or decoding transformations, and republishes to an outbound queue. This enables compact storage and later restoration of BitMEX market data.

## Transform Strategy

The transform strategy is selected via the `x-codec-strategy` AMQP header:

- **`encode`** (default): Brotli-compresses all messages. For `orderBookL2`, `trade`, `quote`, and `instrument` a table-specific field encoding step runs first to further reduce size; all other tables are compressed as-is.
- **`decode`**: Brotli decompression followed by table-specific field decoding. Reverses an encoded message back to its original structure.

If the header is absent, `encode` is assumed.

Codec subscribes to its own topic exchange (`codec.in`) and a queue with binding key '#' (`codec`).


## Architecture

### Message Flow

```
Inbound RabbitMQ Queue
    ↓ (consume from `codec` queue in `codec.in` topic exchange)
 Codec Service
    ├─ x-codec-strategy: encode (default) → encode + brotli compress → { table, action, b: <Buffer> }
    └─ x-codec-strategy: decode           → brotli decompress + decode → { table, action, data: [...] }
    ↓ (republish preserving original routing key and metadata headers)
 Outbound RabbitMQ Queue
    ↓ (publish to `codec.out` topic exchange)
 Downstream consumer (e.g., Writer)
```

### Transformation Modes

#### Encode Mode

Reduces message size and normalizes structure:

- All tables: data is Brotli-compressed and stored as `b` (a Buffer), replacing the original `data` array.
- For the 4 main tables (`orderBookL2`, `trade`, `quote`, `instrument`): a table-specific field encoding step runs first, converting enumerable fields to numeric ids and packing multiple values into single numbers.

**Result:** ~70% size reduction

#### Decode Mode

Brotli-decompresses `b` and reverses the table-specific encoding, recovering the original `data` array. A use case would be restoring a database from long-term storage or backup.

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RABBITMQ_URL` | Yes | - | RabbitMQ connection string |
| `CODEC_PREFETCH` | No | `1000` | RabbitMQ prefetch window (messages buffered per consumer) |
| `CODEC_BROTLI_QUALITY` | No | `1` | Brotli compression quality (0-11: 0=fastest, 11=best) |

- **Prefetch** Backpressure control: higher = faster throughput, lower = more balanced consumption
- **Compression** Throughput scales with Brotli quality setting (higher quality = slower compression)

## Dependencies

### External Runtime Dependencies
- **RabbitMQ** - For message consumption and publishing
- **@devvir/service** - Lifecycle management framework
- **@devvir/rabbitmq** - RabbitMQ broker abstraction
- **@tradebot/utils** - Utilities (logging, URL handling)
- **@tradebot/types** - BitMEX message type definitions
- **Node.js zlib** - Brotli compression

## Error Handling

### Transform Failures

- **Encode failure**: error is logged; the original message is republished unchanged (passthrough fallback).
- **Decode failure**: error is logged; message is NACKed without requeue (dead-lettered).

## Health Monitoring

### Health Check Endpoint

```
curl http://codec:3000/health
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
