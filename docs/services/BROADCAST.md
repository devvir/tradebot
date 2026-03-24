# Broadcast Service - Technical Documentation

## Overview

The Broadcast service maintains two persistent WebSocket connections to BitMEX market data endpoints and relays all messages to a RabbitMQ topic exchange `broadcast`. It provides a centralized, resilient data acquisition point for the platform.

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

Each connection maintains its own independent message counter and worker UUID for per-instance message tracking across the downstream pipeline.

### Message Processing Flow

```
BitMEX WebSocket
    ↓ (raw JSON messages)
 Broadcast Service
    ├─ Control messages (info, subscribe confirmations) → logged, not published
    └─ Data messages → published to RabbitMQ
        │  routing key: <table>.<action>.<symbol>  (symbol empty if absent or multi-symbol)
        │  headers:
        │    x-message-count         — counter tracking message sequence (increments per publish)
        │    x-worker-uuid           — broadcast instance UUID for per-instance deduplication
        │    x-bitmex-version        — BitMEX WebSocket API version
        │    x-bitmex-symbols        — comma-separated unique symbols in this message
        │    x-bitmex-published-at   — ISO-8601 timestamp of receipt
        ↓
 RabbitMQ Topic Exchange `broadcast`
    └─ Downstream consumers bind their own queues with routing key patterns
```

Broadcast declares the topic exchange only — no queues. Downstream services assert their own queues and bind to the routing key patterns they need. Headers carry all metadata; the routing key is purely for consumer-side filtering.

### Message Counter Semantics

The `x-message-count` header (combined with `x-worker-uuid`) enables downstream services to coordinate message ordering:
- **Incremental counter** — Starts at 1 for the first message published from this broadcast instance
- **Deduplication** — `(x-worker-uuid, x-message-count)` tuple uniquely identifies a message across all downstream services
- **Ordering** — Downstream services compare counters to reorder received messages and detect gaps

### Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BITMEX_TESTNET` | No | `true` | Use BitMEX testnet (`true`) or live (`false`) |
| `BROADCAST_RECONNECT_DELAY_MS` | No | `5000` | Initial reconnection delay in milliseconds |
| `BROADCAST_MAX_RECONNECT_DELAY_MS` | No | `60000` | Maximum reconnection delay (exponential backoff caps here) |
| `BROADCAST_MESSAGE_TTL` | No | `1800000` | RabbitMQ message TTL in milliseconds (30 min default) |

### Reconnection Strategy

When a WebSocket connection fails:
1. Schedule reconnection after `BROADCAST_RECONNECT_DELAY_MS`
2. Double the delay for next retry (capped at `BROADCAST_MAX_RECONNECT_DELAY_MS`)
3. Reset delay to initial value on successful connection

Example with defaults:
- 1st retry: 5s
- 2nd retry: 10s
- 3rd retry: 20s
- 4th retry: 40s
- 5th+ retry: 60s (capped)

## Dependencies

### External Runtime Dependencies
- **RabbitMQ** — For message publishing. See [infra packs](../../modules/infra/README.md).
- **BitMEX API** — WebSocket endpoints (live or testnet)

### NPM Packages
- `ws` - WebSocket client library
- `@devvir/service-kit` - Service lifecycle management framework (includes RabbitMQ broker)
- `@tradebot/utils` - Utility functions (URL sanitization, logging)

## Health Monitoring

### Health Check Endpoint

```bash
curl http://broadcast:3000/health
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

On signal, WebSocket connections and the RabbitMQ broker are closed cleanly. See [service-kit: graceful shutdown](../../packages/service-kit/docs/guides/graceful-shutdown.md).
