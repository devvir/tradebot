# BitMEX Feed Service (WIP)

A lightweight WebSocket client that connects to BitMEX market data endpoints and publishes all received messages to RabbitMQ.

## What It Does

- **Connects** to BitMEX realtime and platform WebSocket endpoints
- **Subscribes** to predefined market data channels (instruments, quotes, trades, order books, announcements, etc.)
- **Publishes** all incoming messages to a RabbitMQ `feed` topic exchange
- **Monitors** connection health and automatically reconnects on failure
- **Exposes** a health check endpoint for orchestration systems

## Why This Service

This service centralizes market data acquisition, eliminating:

- Multiple independent WebSocket connections to BitMEX (wasting resources and risking rate limits)
- Scattered reconnection logic across the application
- Coordination problems between services consuming the same data

Any service that needs BitMEX data binds to the `feed` exchange and receives messages matching its routing key patterns. No changes to this service needed when consumers come and go.

## Getting Started

### Environment

```bash
BITMEX_TESTNET=true          # Use testnet (default: true)
RABBITMQ_URL=amqp://...      # RabbitMQ connection
FEED_RECONNECT_DELAY_MS=5000 # Initial reconnect delay
```

### Running

```bash
pnpm dev            # Development (watch mode)
pnpm build          # Compile TypeScript
pnpm start          # Run compiled service
pnpm test           # Run tests
```

### Health Check

```bash
curl http://localhost:3000/health
```

Returns 200 (healthy) when at least one WebSocket is connected and messages are recent, 503 otherwise.

## Architecture

The service maintains two independent WebSocket connections:

- **Realtime**: Market data (instruments, quotes, trades, order books)
- **Platform**: System announcements and chat

Both publish to the same RabbitMQ exchange with routing keys based on message type.

For detailed implementation information, see [docs/services/FEED-WIP.md](../../docs/services/FEED-WIP.md).
