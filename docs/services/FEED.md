# Feed-WIP Service: Technical Documentation

## Overview

The Feed-WIP service is a production-grade WebSocket client that connects to BitMEX's public market data feeds and publishes all messages to RabbitMQ. It provides a straightforward bridge: subscribe to predefined channels on two BitMEX endpoints, receive all messages, and forward them to RabbitMQ for downstream consumption.

## Service Architecture

### Two Independent Connections

The service maintains two unrelated WebSocket connections to BitMEX:

| Endpoint | Purpose | Channels |
|----------|---------|----------|
| `/realtime` | Market data | `instrument`, `orderBookL2`, `quote`, `trade`, `liquidation`, `settlement`, `funding`, `insurance` |
| `/realtimePlatform` | System messages | `announcement`, `chat`, `connected`, `publicNotifications` |

Both subscriptions are static (determined at startup from `config.ts`). Either endpoint can be down without affecting the other; the service is healthy if **at least one** is connected and messages are recent.

### Connection Lifecycle

```
                   WebSocket Connect
                          ↓
              ┌──────────────────────┐
              │  Subscribe to        │
              │  predefined channels │
              └──────────────────────┘
                        ↓
              ┌──────────────────────┐
              │  Start heartbeat     │
              │  (30s ping/pong)     │
              └──────────────────────┘
                        ↓
              ┌──────────────────────┐
              │  Receive & publish   │
              │  all messages         │
              └──────────────────────┘
                        ↓
         On close ─────→ Schedule reconnect
                        (exponential backoff)
```

### Message Flow

```
BitMEX WebSocket → Parse JSON
                 ↓
          Is data message?
          ├─ YES → Publish to RabbitMQ feed exchange
          │          (routing key: message.table)
          └─ NO  → Log control event (subscription, info, etc.)
                   Capture API version if present
```

## Core Components

### Configuration (`src/config.ts`)

Loads and validates:

- **Endpoint URLs**: Live or testnet based on `BITMEX_TESTNET`
- **Channel subscriptions**: Hardcoded lists in `REALTIME_CHANNELS` and `PLATFORM_CHANNELS`
- **RabbitMQ settings**: URL, message TTL
- **Connection settings**: Reconnect delays (starting and maximum)

### WebSocket Connection (`src/connection.ts`)

Exports `createConnections(state, config, onMessage)` which:

1. Defines two endpoints with their URLs and channel lists
2. Creates a `makeConnect` factory that returns a connection function for each endpoint
3. Sets up event handlers:
   - `open`: Reset reconnect delay, start heartbeat, subscribe to channels
   - `message`: Invoke `onMessage` callback
   - `close`: Schedule reconnect with exponential backoff
   - `error`: Log error
   - `ping`/`pong`: Handle WebSocket keep-alive

**Exponential Backoff**:
- Initial delay: 5000ms (configurable)
- Max delay: 60000ms (configurable)
- On each reconnect failure, delay doubles until reaching max

### Message Handler (`src/messages.ts`)

Exports `createMessageHandler(state)` which:

1. Updates `state.lastMessageTime` (used for health checks)
2. Parses incoming buffer as JSON
3. Returns early on parse errors (logs error)
4. Distinguishes message types:
   - **Data messages**: Publish to RabbitMQ `feed` exchange
   - **Info messages**: Capture API version (via `??=` to preserve first value)
   - **Control messages**: Log subscription/unsubscription events
   - **Unknown**: Log warning

Message headers include `api_version` for downstream consumers.

### RabbitMQ Setup (`src/rabbitmq.ts`)

Exports `connectToQueue(url)` which:

1. Connects to RabbitMQ broker
2. Declares `feed` topic exchange with `feed` queue
3. Binds queue to exchange with routing key `#` (matches all messages)
4. Returns broker instance for message publishing

### Health Checks (`src/health.ts`)

Exports `determineHealth(state, currentTime)` which checks:

- **At least one WebSocket connected**: `realtimeConnected OR platformConnected`
- **Messages recent**: Last message < 30 seconds old
- **Result**: 200 (healthy) or 503 (unhealthy)

Response body includes per-endpoint connection status and message staleness.

### Service Lifecycle (`src/lifecycle.ts`)

Exports `registerLifecycle(state)` which:

1. Registers SIGTERM/SIGINT handlers
2. Closes both WebSockets gracefully on shutdown
3. Disconnects RabbitMQ broker
4. Provides `getHealthState()` callback for health endpoint

### Entry Point (`src/index.ts`)

1. Load configuration
2. Initialize state object (WebSocket refs, api version, reconnect delay, ping interval)
3. Connect to RabbitMQ
4. Create message handler with state
5. Create WebSocket connections
6. Start connections (realtime first, then platform)
7. Register lifecycle handlers
8. Start health check HTTP server on port 3000

## Message Flow Example

**Incoming BitMEX message:**
```json
{
  "table": "trade",
  "action": "insert",
  "data": [
    {"timestamp": "2026-02-21T03:00:00.000Z", "symbol": "XBTUSD", "price": 45000, ...}
  ]
}
```

**Processing:**
1. Arrive on WebSocket, parse to object
2. Check `isBitmexDataMessage()` → true
3. Publish to RabbitMQ with:
   - Exchange: `feed`
   - Routing key: `trade` (from `message.table`)
   - Headers: `{ api_version: "..." }`
   - Payload: Original message (full object)

**Subscribers receive:**
Any service bound to `feed` exchange with routing key `trade` (or `#` for all) receives the message.

## Testing

Test file structure:

- `config.test.ts`: Endpoint selection, channel lists, connection settings
- `health.test.ts`: Health check logic (connection + staleness)
- `rabbitmq.test.ts`: Queue/exchange setup
- `roles.test.ts`: Service behavior (skipped—no role-based logic)
- `bitmex.test.ts`: Channel definitions (skipped—no symbol filtering)

Tests focus on **observable behavior** (what callers can measure) rather than internal implementation details.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| RabbitMQ unavailable on startup | Service crashes (fail fast) |
| RabbitMQ disconnects at runtime | Message publishing fails; logged but no reconnect (relies on external restart) |
| WebSocket closes | Automatic reconnect with exponential backoff |
| Parse error on message | Logged; service continues |
| Stale messages (> 30s) | Health check returns 503 |
| Both WebSockets down | Health check returns 503 (unhealthy) |

## Performance Considerations

### Throughput

Designed to handle BitMEX's typical data rates (hundreds to thousands of messages/second):

- Direct message publishing (no buffering)
- No filtering or transformation
- Single RabbitMQ connection (not per-subscriber)
- Heartbeat every 30 seconds (minimal overhead)

### Memory

- Two WebSocket connections
- Single RabbitMQ connection
- No message buffering (publish immediately)
- Exponential backoff timer (one per endpoint)
- Negligible in-memory state

### Scaling

Multiple instances can be deployed:
- One instance per environment (live vs testnet)
- Multiple instances per environment if needed (each maintains independent connections)
- Load balancing at RabbitMQ consumer level (not at data collection level)

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `BITMEX_TESTNET` | `true` | Use testnet endpoints (false = live) |
| `RABBITMQ_URL` | `amqp://guest:guest@rabbitmq:5672` | RabbitMQ broker address |
| `FEED_RECONNECT_DELAY_MS` | `5000` | Initial reconnect delay (ms) |
| `FEED_MAX_RECONNECT_DELAY_MS` | `60000` | Maximum reconnect delay (ms) |
| `FEED_MESSAGE_TTL` | `1800000` | Message time-to-live (30 min) |

### Health Endpoint

```bash
GET /health
```

**Response (200):**
```json
{
  "status": "healthy",
  "realtimeConnected": true,
  "realtimePlatformConnected": false,
  "lastMessage": 2000
}
```

**Response (503):**
```json
{
  "status": "unhealthy",
  "realtimeConnected": false,
  "realtimePlatformConnected": false,
  "lastMessage": 45000
}
```

## Potential Enhancements

- Metric collection (messages/sec, connection duration, reconnect count)
- Configurable heartbeat interval
- Per-endpoint health reporting (not just aggregate)
- Message rate throttling (if needed)
- Structured logging with correlation IDs for tracing message flow

## Related Services

- **Reader** / **Reader-WIP**: Consume from `feed` exchange, index messages into MongoDB
- **Archivist**: Archives all messages to long-term storage
- **Snapshots**: Creates periodic order book snapshots from feed data
