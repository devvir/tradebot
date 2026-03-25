# Broadcast Service

A WebSocket client that connects to BitMEX market data endpoints and publishes all received messages to RabbitMQ.

## Core Functionality

- **WebSocket connections** to BitMEX realtime and platform endpoints (with configurable live/testnet)
- **Message relay** - receives all BitMEX messages and publishes them to RabbitMQ
- **Automatic reconnection** with exponential backoff on connection loss
- **Health monitoring** - exposes health check endpoint reporting connection and activity status
- **Lifecycle management** - graceful shutdown, proper resource cleanup

The service maintains two independent WebSocket connections:

- **Realtime**: Market data (instruments, quotes, trades, order books)
- **Platform**: System announcements and chat

Both publish to the same RabbitMQ topic exchange with `<table>.<action>` as the routing key (e.g., `trade.insert`).

## Development

```bash
pnpm install   # Install dependencies
pnpm build     # Compile TypeScript
pnpm test      # Run tests
```

## Configuration

Requires RabbitMQ — see [infra packs](../../modules/infra/README.md).

- `BITMEX_TESTNET` - Use testnet (default: false)
- `BROADCAST_MESSAGE_TTL` - RabbitMQ message TTL in ms (default: 1800000 = 30 minutes)

For technical details, see [docs/services/BROADCAST.md](../../docs/services/BROADCAST.md).
