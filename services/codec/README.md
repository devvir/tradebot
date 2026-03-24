# Codec Service

A message transformation service that consumes market data messages from RabbitMQ, applies encoding or decoding, and republishes them.

## Core Functionality

- **Message consumption** from RabbitMQ `codec` queue in the `codec.in` topic exchange.
- **Transformation modes** selected via `x-codec-strategy` AMQP header:
  - `encode` (default) — field reduction + Brotli compression
  - `decode` — decompress + decode, restoring the original message
- **Scalability** - Configurable prefetch for load balancing

## Development

```bash
pnpm install   # Install dependencies
pnpm build     # Compile TypeScript
pnpm test      # Run tests
```

## Configuration

### Environment Variables

Requires RabbitMQ — see [infra packs](../../modules/infra/README.md).

- `CODEC_PREFETCH` - RabbitMQ prefetch window (default: 1000)
- `CODEC_BROTLI_QUALITY` - Brotli compression quality for encode mode (default: 1, where 0=fastest, 11=best)

For technical details, see [docs/services/CODEC.md](../../docs/services/CODEC.md).
