# Broadcast Service - Technical Documentation

## Overview

The Broadcast service maintains persistent WebSocket connections to BitMEX market data endpoints and relays all messages to a RabbitMQ topic exchange `broadcast`.

It also exposes an HTTP command interface on port 80 for runtime channel subscription management, including per-account authenticated connections coordinated via the Bouncer service.

## Architecture

### Connection Model

The service manages two kinds of connections:

**Guest connections** (permanent, established on startup):
1. **Realtime endpoint** (`wss://www.bitmex.com/realtime`) — core market data: instruments, quotes, trades, order books
2. **Platform endpoint** (`wss://www.bitmex.com/realtimePlatform`) — system announcements, chat, notifications

Both are configured with a preset channel set (see `BROADCAST_FEED_PRESET`) and subscribe on open.

**Authenticated connections** (on-demand, per-account):
- Created when a subscribe command arrives with an `x-account-id` header
- BitMEX credentials are fetched from the Bouncer service and embedded in the WebSocket URL as query parameters
- Keyed by `${accountId}:${endpointName}` in the connection pool
- Closed automatically when the last subscription for that account+endpoint is removed

All connections share the same message handler and publish to the same RabbitMQ exchange.

### Connection Pool

The pool (`src/pool.ts`) maintains a `Map<string, PoolEntry>` keyed as `${accountId}:${endpointName}`. Guest entries use an empty accountId (`:realtime`, `:platform`). A guest connection is just a connection with `accountId = undefined` — same code path, same subscribe/unsubscribe logic.

Each entry holds:
- **`ws`** — the active WebSocket, updated in place when the connection reconnects
- **`channels`** — a `Set<string>` of currently subscribed channels; authenticated connections are closed when this becomes empty (guest connections are always kept alive). Also used to resubscribe all channels on reconnect.

### WebSocket Lifecycle

A single `connect` function (`src/websocket.ts`) creates a WebSocket, sets up lifecycle handlers (heartbeat, pong, message forwarding), and handles reconnection with exponential backoff (200ms → 15s cap, reset on successful open). The function accepts optional `credentials` (appended as query params to the URL) and an `onReconnect` callback.

On reconnect, `onReconnect` provides the replacement WebSocket. The pool's handler updates the entry's `ws` in place and resubscribes all tracked channels once the new connection opens.

The connect function does not subscribe to channels — all subscriptions go through `subscribe()` in `commands/commands.ts`. On startup, preset channels are subscribed through the same code path as HTTP-driven subscriptions.

### Message Processing Flow

```
BitMEX WebSocket
    ↓ (raw JSON messages)
 Broadcast Service
    ├─ Control messages (info, subscribe confirmations) → logged, not published
    └─ Data messages → published to RabbitMQ
        │  routing key: <table>.<action>
        │  headers:
        │    x-message-count         — counter tracking message sequence (increments per publish)
        │    x-worker-uuid           — broadcast instance UUID for per-instance deduplication
        │    x-bitmex-version        — BitMEX WebSocket API version
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

## Runtime Command Interface

An HTTP server on **port 80** (`src/commands/`) accepts subscribe and unsubscribe commands.

### Endpoints

```
POST /subscribe/:channel
POST /unsubscribe/:channel
```

The optional `x-account-id` header selects the connection:
- Absent or empty → guest connection (permanent, shared)
- Present → authenticated per-account connection

### Subscribe flow

1. Determine the endpoint from the channel name: any channel in `PLATFORM_CHANNELS` → platform, everything else → realtime
2. Look up the pool entry for `accountId:endpointName`
3. If no entry (authenticated only): fetch credentials from Bouncer, establish a new connection, wait for open
4. Send `{ op: "subscribe", args: [channel] }` on the connection
5. Wait for BitMEX to confirm with `{ subscribe: channel, success: true }`, up to a **5-second total deadline** (covering credential fetch + open wait + confirmation wait combined)
6. Increment `subscriptionCount`

### Unsubscribe flow

1. Resolve the pool entry
2. Send `{ op: "unsubscribe", args: [channel] }`
3. Decrement `subscriptionCount`
4. If authenticated and count reaches 0: close the WebSocket and remove the entry from the pool

### HTTP response codes

| Code | Meaning |
|------|---------|
| 201 | Subscribe successful |
| 200 | Unsubscribe sent |
| 400 | Subscription rejected by BitMEX |
| 401 | Bouncer auth failure (invalid accountId or token) |
| 503 | Connection or subscription timed out; Bouncer unreachable |

### Bouncer integration

Authenticated connections require the Bouncer service to sign WebSocket credentials. Broadcast sends:

```http
POST /sign/ws
Authorization: Bearer {BOUNCER_TOKEN}
Content-Type: application/json

{ "accountId": "...", "expires": <unix_seconds + 60> }
```

Bouncer responds with `{ apiKey, expires, signature }`. Broadcast appends these as query parameters to the BitMEX WebSocket URL:

```
wss://www.bitmex.com/realtime?api-key=...&api-expires=...&api-signature=...
```

### Channel routing

Channels are routed to the realtime or platform endpoint based on `PLATFORM_CHANNELS` (defined in `src/channels.ts`). Any channel not in `PLATFORM_CHANNELS` is treated as a realtime channel.

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BITMEX_TESTNET` | No | `false` | Use BitMEX testnet (`true`) or live (`false`) |
| `BROADCAST_FEED_PRESET` | No | `feed` | Preset channel set for guest connections |

### Channel Presets (`BROADCAST_FEED_PRESET`)

| Preset | Channels |
|--------|---------|
| `feed` | All realtime channels (primary + secondary + redundant) |
| `archive` | Primary + secondary channels |
| `primary` | `instrument`, `orderBookL2`, `quote`, `trade` |
| `secondary` | `liquidation`, `settlement`, `funding`, `insurance` |
| `redundant` | Binned candle/quote channels |

## Reconnection Strategy

When a WebSocket connection fails:
1. Schedule reconnection after 200ms
2. Double the delay for next retry (capped at 15s)
3. Reset delay to initial value on successful connection

The delay is shared across all connections (single module-level counter). In practice this means a burst of simultaneous reconnects staggers naturally.

## Dependencies

### External Runtime Dependencies
- **RabbitMQ** — For message publishing. See [infra packs](../../modules/infra/README.md).
- **BitMEX API** — WebSocket endpoints (live or testnet)
- **Bouncer** — Signs WebSocket credentials for authenticated connections

### NPM Packages
- `ws` — WebSocket client library
- `express` — HTTP command server
- `@devvir/service-kit` — Service lifecycle management framework (includes RabbitMQ broker)
- `@tradebot/utils` — Utility functions (URL sanitization, logging)

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

- **`messagesProcessed`** — Cumulative count of all parsed messages
- **`lastProcessedTime`** — Milliseconds elapsed since last message received
- **Connection status fields** — Boolean true/false for each endpoint

## Error Handling

### WebSocket Failures

- **Parse errors** — Logged, message skipped, connection continues
- **Publication failures** — Logged, connection continues (RabbitMQ handles retries via broker)
- **Connection loss** — Logged, automatic reconnection scheduled

### Graceful Shutdown

On signal, WebSocket connections and the RabbitMQ broker are closed cleanly. See [service-kit: graceful shutdown](../../packages/service-kit/docs/guides/graceful-shutdown.md).
