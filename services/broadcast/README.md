# Broadcast Service

A WebSocket client that connects to BitMEX market data endpoints, and publishes all received messages to RabbitMQ.

It exposes an HTTP command interface for runtime channel subscription management.

## Core Functionality

- **WebSocket connections** to BitMEX realtime and platform endpoints (with configurable live/testnet)
- **Message relay** - receives all BitMEX messages and publishes them to RabbitMQ
- **Runtime subscriptions** - HTTP API on port 80 to subscribe/unsubscribe channels at runtime (including authenticated, per-account connections via Bouncer)
- **Automatic reconnection** with exponential backoff on connection loss
- **Health monitoring** - exposes health check endpoint reporting connection and activity status
- **Lifecycle management** - graceful shutdown, proper resource cleanup

The service maintains two persistent guest WebSocket connections (realtime + platform) for preset channels, plus an on-demand pool of authenticated connections for per-account channel subscriptions.

Both connection types publish to the same RabbitMQ topic exchange with `<table>.<action>` as the routing key (e.g., `trade.insert`).

## Development

```bash
pnpm install   # Install dependencies
pnpm build     # Compile TypeScript
pnpm test      # Run tests
```

## Configuration

Requires RabbitMQ and Bouncer — see [infra packs](../../modules/infra/README.md).

| Variable | Required | Default | Description |
|---|---|---|---|
| `BROADCAST_FEED_PRESET` | No | `none` | Preset channel set (`none`, `core`, `feed`, `archive`, `primary`, `secondary`, `redundant`) |
| `BROADCAST_PORT` | No | — | Broadcast Commands Server port mapping on host |

## Runtime Command API

```bash
# Subscribe to a channel (guest connection)
POST http://broadcast/subscribe/trade

# Subscribe to a channel (authenticated, per-account connection)
POST http://broadcast/subscribe/order
x-account-id: <accountId>

# Unsubscribe
POST http://broadcast/unsubscribe/trade
```

For technical details, see [docs/services/BROADCAST.md](../../docs/services/BROADCAST.md).
