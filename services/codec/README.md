# Codec Service

A message transformation and encoding service that consumes market data messages from RabbitMQ, applies compression/encoding strategies (or the inverse: decode), and republishes them to another RabbitMQ queue.

# BSON Serialization

All published messages are BSON-serialized (content-type: application/bson) in order to preserve Buffers through rabbitMQ. Consumers should call `BSON.deserialize(message)` on messages received from Codec.

## Core Functionality

- **Message consumption** from RabbitMQ `codec` queue in the `codec.in` topic exchange.
- **Flexible transformation modes**:
- **Document ID generation** - embeds document IDs directly in the message payload for storage (except for `decode`)
- **Error handling** - graceful fallback to raw payloads on transformation failures
- **Scalability** - configurable prefetch for load balancing

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

For detailed implementation information, see [docs/services/CODEC.md](../../docs/services/CODEC.md).
