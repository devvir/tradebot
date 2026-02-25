# Feed Service

A WebSocket client that connects to BitMEX market data endpoints and publishes all received messages to RabbitMQ.

## Core Functionality

- **WebSocket connections** to BitMEX realtime and platform endpoints (with configurable live/testnet)
- **Message relay** - receives all BitMEX messages and publishes them to RabbitMQ
- **Automatic reconnection** with exponential backoff on connection loss
- **Health monitoring** - exposes health check endpoint reporting connection and activity status
- **Lifecycle management** - graceful shutdown, proper resource cleanup

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
docker build -t feed-service .
docker run -e RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672 \
           -e FEED_EXCHANGE=ex.feed \
           -e FEED_QUEUE=q.feed \
           feed-service
```

## Configuration

**Required:**
- `RABBITMQ_URL` - Connection string to RabbitMQ
- `FEED_EXCHANGE` - Topic exchange name to publish to
- `FEED_QUEUE` - Queue name for the service

**Optional:**
- `BITMEX_TESTNET` - Use testnet (default: false; set to true for testnet data)
- `FEED_RECONNECT_DELAY_MS` - Initial reconnection delay in ms (default: 5000)
- `FEED_MAX_RECONNECT_DELAY_MS` - Max reconnection delay in ms (default: 60000)
- `FEED_MESSAGE_TTL` - RabbitMQ message TTL in ms (default: 1800000 = 30 minutes)

## Health Check

```bash
curl http://localhost:3000/health
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

Both publish to the same RabbitMQ exchange with routing keys based on message type.

For detailed implementation information, see [docs/services/FEED-WIP.md](../../docs/services/FEED-WIP.md).
