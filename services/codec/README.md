# Codec Service

A message transformation and encoding service that consumes market data messages, optionally applies compression/encoding strategies, and republishes them to another RabbitMQ exchange.

## Core Functionality

- **Message consumption** from a configurable RabbitMQ inbound queue
- **Flexible transformation modes**:
  - Pass-through: republish unchanged
  - Encode: compact representation with field reduction
  - Binary: Brotli compression of payloads
  - Decode: decompress and decode (inverse of encode+binary)
- **Metadata enrichment** - generates document IDs for database storage
- **Error handling** - graceful fallback to raw payloads on transformation failures
- **Scalability** - configurable prefetch for load balancing

## Installation

```bash
pnpm install
```

## Building

```bash
pnpm build          # Compile TypeScript to dist/
```

## Development

```bash
pnpm dev            # Watch mode with ts-node
pnpm test           # Run test suite
pnpm test:watch     # Watch mode tests
pnpm test:coverage  # Coverage report
```

## Running

### Standalone

```bash
pnpm start          # Run compiled service (requires RABBITMQ_URL and other env vars)
```

See [configuration](#configuration) section below for required environment variables.

### In Docker

```bash
docker build -t codec-service .
docker run -e RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672 \
           -e CODEC_INBOUND_EXCHANGE=ex.feed \
           -e CODEC_INBOUND_QUEUE=q.feed \
           -e CODEC_OUTBOUND_EXCHANGE=ex.transform \
           -e CODEC_OUTBOUND_QUEUE=q.transform \
           codec-service
```

## Configuration

### Required Environment Variables

- `RABBITMQ_URL` - Connection string to RabbitMQ
- `CODEC_INBOUND_EXCHANGE` - Source exchange to consume from
- `CODEC_INBOUND_QUEUE` - Source queue name
- `CODEC_OUTBOUND_EXCHANGE` - Destination exchange to publish to
- `CODEC_OUTBOUND_QUEUE` - Destination queue name

### Optional Environment Variables

- `CODEC_STRATEGY` - Comma-separated transformation modes (default: empty = pass-through):
  - `encode` - Compact field encoding
  - `binary` - Brotli compression
  - `decode` - Decompress and decode (inverse of encode+binary)
  - Examples: `encode`, `binary`, `encode,binary`, `decode`, or empty
- `CODEC_PREFETCH` - RabbitMQ prefetch window (default: 100)
- `CODEC_BROTLI_QUALITY` - Compression quality 0-11 (default: 4, where 0=fastest, 11=best compression)

## Transformation Modes

### Pass-Through Mode (default)

When `CODEC_STRATEGY` is empty or unset:
- Messages republished unchanged
- Minimal processing overhead
- Useful for message routing/buffering

### Encode Mode

When `CODEC_STRATEGY` includes `encode`:
- Strips redundant BitMEX fields (table, keys, types, filter)
- Encodes action as 1-byte prefix
- Builds document ID from timestamp + action + API version
- Metadata headers added for downstream document creation
- Reduces payload size by ~10-20%

### Binary Mode

When `CODEC_STRATEGY` includes `binary`:
- Applies Brotli compression to full payload
- Can be combined with `encode` mode
- Compression quality configurable via `CODEC_BROTLI_QUALITY`
- Content-Type set to `application/octet-stream`
- Results in 40-70% size reduction depending on data

### Example Combinations

```bash
# Pass-through (no transformation)
CODEC_STRATEGY=

# Encode only
CODEC_STRATEGY=encode

# Compress only
CODEC_STRATEGY=binary

# Encode and compress
CODEC_STRATEGY=encode,binary

# Compress with higher quality
CODEC_STRATEGY=binary
CODEC_BROTLI_QUALITY=8
```

## Health Check

```bash
curl http://localhost:3000/health
```

Returns:
- **200 OK** - Service is healthy (active connections, recent message processing)
- **503 Service Unavailable** - No active connections or stale data

Response includes:
- `messagesProcessed` - Cumulative message count
- `lastProcessedTime` - Time since last message (ms)
- `brokerConnected` - RabbitMQ connection status
