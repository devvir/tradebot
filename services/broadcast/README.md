# Broadcast Service

A WebSocket client that connects to BitMEX market data endpoints and publishes all received messages to RabbitMQ.

## Core Functionality

- **WebSocket connections** to BitMEX realtime and platform endpoints (with configurable live/testnet)
- **Message relay** - receives all BitMEX messages and publishes them to RabbitMQ
- **Automatic reconnection** with exponential backoff on connection loss
- **Health monitoring** - exposes health check endpoint reporting connection and activity status
- **Lifecycle management** - graceful shutdown, proper resource cleanup

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

- `RABBITMQ_URL` - (Required) Connection string to RabbitMQ
- `BITMEX_TESTNET` - Use testnet (default: false)
- `BROADCAST_RECONNECT_DELAY_MS` - Initial reconnection delay in ms (default: 5000)
- `BROADCAST_MAX_RECONNECT_DELAY_MS` - Max reconnection delay in ms (default: 60000)
- `BROADCAST_MESSAGE_TTL` - RabbitMQ message TTL in ms (default: 1800000 = 30 minutes)

## Health Check

```bash
GET /health
```

Returns:
- **200 OK** - Service is healthy (at least one WebSocket connected, recent activity)
- **503 Service Unavailable** - No active connections or stale data

Response includes:
- `messagesProcessed` - Cumulative message count
- `lastProcessedTime` - Time since last message (ms)
- `realtimeConnected` - Realtime WebSocket status
- `platformConnected` - Platform WebSocket status

The service maintains two independent WebSocket connections:

- **Realtime**: Market data (instruments, quotes, trades, order books)
- **Platform**: System announcements and chat

Both publish to the same RabbitMQ topic exchange with `message.<table>` as the routing key (e.g., `trade`, `orderBookL2`, `instrument`). Broadcast declares the exchange only — no queues. Downstream consumers assert their own queues and bind to the patterns they need.

For detailed implementation information, see [docs/services/BROADCAST-WIP.md](../../docs/services/BROADCAST-WIP.md).
