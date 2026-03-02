# Codec Service

A message transformation and encoding service that consumes market data messages from RabbitMQ, applies compression/encoding strategies (or the inverse: decode), and republishes them to another RabbitMQ queue.

## Core Functionality

- **Message consumption** from RabbitMQ `codec` queue in the `codec.in` topic exchange.
- **Flexible transformation modes**:
  - `encode` - Compact field-reduced representation
  - `compress` - Brotli compression on top of encode
  - `decode` - Decompress (if compressed), reverse encode
  - `passthru` - Add deduplicating `_id` without payload transformation
- **Document ID generation** - Embeds a deterministic numeric `_id` (53-bit safe integer) in every message for idempotent inserts. The `_id` encodes timestamp, API version, and action so documents are self-describing and directly queryable as plain numbers in JavaScript, MongoDB Compass, and mongosh.
- **Error handling** - Graceful fallback to raw payloads on transformation failures
- **Scalability** - Configurable prefetch for load balancing

## Development

```bash
pnpm install        # Install node dependencies
pnpm build          # Compile TypeScript to dist/
pnpm dev            # Watch mode with ts-node
pnpm test           # Run test suite
pnpm test:watch     # Watch mode tests
pnpm test:coverage  # Coverage report
pnpm start          # Run compiled service (requires RABBITMQ_URL and other env vars)
```

## Configuration

### Environment Variables

- `RABBITMQ_URL` - Connection string to RabbitMQ
- `CODEC_PREFETCH` - RabbitMQ prefetch window (default: 1000)
- `CODEC_BROTLI_QUALITY` - Compression quality for `compress` strategy (default: 1, where 0=fastest, 11=best compression)

## Health Check

```bash
GET /health
```

Returns:
- **200 OK** - Service is healthy (active connections, recent message processing)
- **503 Service Unavailable** - No active connections or stale data

Response includes:
- `messagesProcessed` - Cumulative message count
- `lastProcessedTime` - Time since last message (ms)
- `brokerConnected` - RabbitMQ connection status

For detailed implementation information, see [docs/services/CODEC.md](../../docs/services/CODEC.md). For encoding internals, see [encoding/README.md](src/encoding/README.md).
