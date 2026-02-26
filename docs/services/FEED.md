# Feed Service - Technical Documentation

## Overview

The Feed service maintains two persistent WebSocket connections to BitMEX market data endpoints and relays all messages to RabbitMQ. It provides a centralized, resilient data acquisition point for the platform.

## Architecture

### Connection Model

The service manages two independent WebSocket connections:

1. **Realtime endpoint** (`wss://www.bitmex.com/realtime` or testnet equivalent)
   - Core market data: instruments, quotes, trades, order books
   - High-frequency, mission-critical channel

2. **Platform endpoint** (`wss://www.bitmex.com/realtimePlatform` or testnet equivalent)
   - System announcements, chat, notifications
   - Lower-frequency, informational channel

Both connections subscribe to predefined channel sets on startup. If either connection fails, automatic reconnection with exponential backoff kicks in independently.

### Message Processing Flow

```
BitMEX WebSocket
    ↓ (raw JSON messages)
 Feed Service
    ↓ (parse + classify)
├─ Control messages (subscriptions, info) → logged
├─ Data messages → published to RabbitMQ
    ↓ (with routing key = channel name)
 RabbitMQ Exchange
    ↓ (topic ex.feed)
 Subscribe clients (routing keys: e.g., "trade", "orderBookL2")
```

### Subscribed Channels

**Realtime:**
- `instrument` - Contract specifications and definitions
- `orderBookL2` - Level 2 order book updates
- `quote` - Best bid/ask snapshots
- `trade` - Individual trade executions
- `liquidation` - Liquidation events
- `settlement` - Settlement records
- `funding` - Funding rate events
- `insurance` - Insurance fund updates

**Platform:**
- `announcement` - System announcements
- `chat` - Chat messages
- `connected` - Connection status messages
- `publicNotifications` - Broadcast notifications

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BITMEX_TESTNET` | No | `true` | Use BitMEX testnet (`true`) or live (`false`) |
| `RABBITMQ_URL` | Yes | - | RabbitMQ connection string (e.g., `amqp://guest:guest@localhost:5672`) |
| `FEED_EXCHANGE` | Yes | - | RabbitMQ topic exchange name (e.g., `ex.feed`) |
| `FEED_QUEUE` | Yes | - | RabbitMQ queue name (e.g., `q.feed`) |
| `FEED_RECONNECT_DELAY_MS` | No | `5000` | Initial reconnection delay in milliseconds |
| `FEED_MAX_RECONNECT_DELAY_MS` | No | `60000` | Maximum reconnection delay (exponential backoff caps here) |
| `FEED_MESSAGE_TTL` | No | `1800000` | RabbitMQ message TTL in milliseconds (30 min default) |

### Reconnection Strategy

When a WebSocket connection fails:
1. Schedule reconnection after `FEED_RECONNECT_DELAY_MS`
2. Double the delay for next retry (capped at `FEED_MAX_RECONNECT_DELAY_MS`)
3. Reset delay to initial value on successful connection

Example with defaults:
- 1st retry: 5s
- 2nd retry: 10s
- 3rd retry: 20s
- 4th retry: 40s
- ... continues doubling ...
- 5th+ retry: 60s (capped)

## Dependencies

### External Runtime Dependencies
- **RabbitMQ** - For message publishing
- **BitMEX API** - WebSocket endpoints (live or testnet)

### NPM Packages
- `ws` - WebSocket client library
- `@devvir/service` - Service lifecycle management framework
- `@devvir/rabbitmq` - RabbitMQ connection broker
- `@tradebot/utils` - Utility functions (URL sanitization, logging)

## Health Monitoring

### Health Check Endpoint

```
GET /health
```

**Response (200 - Healthy):**
```json
{
  "messagesProcessed": 1234567,
  "lastProcessedTime": 2500,
  "realtimeConnected": true,
  "platformConnected": false,
  "brokerConnected": true
}
```

**Response (503 - Unhealthy):**
Returned when:
- No WebSocket connections are open
- No RabbitMQ connection
- No messages received within 60 seconds

### Metrics

- **`messagesProcessed`** - Cumulative count of all parsed messages
- **`lastProcessedTime`** - Milliseconds elapsed since last message received
- **Connection status fields** - Boolean true/false for each endpoint

## Error Handling

### WebSocket Failures

- **Parse errors** - Logged, message skipped, connection continues
- **Publication failures** - Logged, connection continues (RabbitMQ handles retries via broker)
- **Connection loss** - Logged, automatic reconnection scheduled

### Graceful Shutdown

On `SIGTERM` or `SIGINT`:
1. Stop accepting new WebSocket operations
2. Close both WebSocket connections
3. Cancel pending heartbeat timers
4. Close RabbitMQ broker connection
5. Exit cleanly

## Usage Modules

The Feed service is used by:
- **archivist module** - Feed + Codec + Writer pipeline for data storage
- **collector module** - Feed + Writer for minimal data persistence
- **transform module** - Feed + Codec for data transformation workflows

Each module configures the service via environment variables and consumes messages from the `FEED_EXCHANGE` using RabbitMQ routing keys.
