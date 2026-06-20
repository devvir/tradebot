# Broadcast Service - Technical Documentation

## Overview

The Broadcast service maintains persistent WebSocket connections to BitMEX market data endpoints and relays all messages to a RabbitMQ topic exchange `broadcast`.

It also exposes an HTTP command interface on port 80 for runtime channel subscription management, including per-account authenticated connections coordinated via the Bouncer service.

## Architecture

### Connection Model

Connections are keyed by three dimensions — **endpoint**, **account**, and **liquidity pool** — and created on demand the first time a subscription needs that combination, then reused.

**Endpoints:**
1. **Realtime** (`wss://www.bitmex.com/realtime`) — core market data: instruments, quotes, trades, order books
2. **Platform** (`wss://www.bitmex.com/realtimePlatform`) — system announcements, chat, notifications

**Guest connections** (permanent) are established on startup from the preset channel set (see `BROADCAST_FEED_PRESET`). Because pool-filtered subscriptions live on their own socket (see Pool Filtering), a guest with e.g. `BROADCAST_POOLS=primary,secondary` opens several realtime sockets — one per requested pool, plus a no-pool socket for the bare and non-fanned channels — alongside the single platform socket.

**Authenticated connections** (on-demand, per-account) are created when a subscribe command arrives with an `x-account-id` header; BitMEX credentials are fetched from the Bouncer service and embedded in the WebSocket URL. They are closed automatically when their last subscription is removed.

All connections share the same message handler and publish to the same RabbitMQ exchange.

### Connection Pool

The pool (`src/pool.ts`) maintains a `Map<string, PoolEntry>` keyed as `${accountId}:${endpointName}:${pool}` (`poolKey`). Every part is optional: a guest no-pool realtime socket is `:realtime:`, a guest Primary socket is `:realtime:Primary`, an authenticated socket is `acct-1:realtime:`. Different key → different socket; same key → reuse. No pool/account logic lives here — the caller derives the pool from the channel suffix (`parseChannel`) and passes it as a key part; the pool stays generic.

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
        │    x-account-id            — owning account for an authenticated stream (empty for guest)
        │    x-bitmex-pool           — the connection's pool filter (empty for the no-pool socket)
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
5. Wait for BitMEX to confirm with `{ subscribe: <base>, success: true }`, up to a **5-second total deadline** (covering credential fetch + open wait + confirmation wait combined). For pool-suffixed channels the ack carries the bare table plus `pool`, so confirmation matches on base channel + `ack.pool` (see Pool Filtering)
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
| `BROADCAST_POOLS` | No | `default` | Liquidity pools to collect per pool-filterable table (see Pool Filtering) |

### Channel Presets (`BROADCAST_FEED_PRESET`)

| Preset | Channels |
|--------|---------|
| `feed` | All realtime channels (primary + secondary + redundant) |
| `archive` | Primary + secondary channels |
| `primary` | `instrument`, `orderBookL2`, `quote`, `trade` |
| `secondary` | `liquidation`, `settlement`, `funding`, `insurance` |
| `redundant` | Binned candle/quote channels |

### Pool Filtering (`BROADCAST_POOLS`)

BitMEX splits market data into liquidity pools — **Primary** (the public book), **Secondary** (a protected book), and **Aggregated** (both blended, the default since the 2026-04-30 rollout). `BROADCAST_POOLS` (csv of `default`, `primary`, `secondary`, `aggregated`, case-insensitive) selects which pools the preset's channels are collected from. The pool is **not** selected by authentication — it is an explicit per-subscription filter.

For each requested non-`default` pool, the **fannable** channels are subscribed with the empty-symbol form `<channel>::<Pool>` (e.g. `orderBookL2::Primary`), which pool-filters every symbol in one subscription, **on that pool's own socket** (the connection key includes the pool). `default` keeps the bare subscription on the no-pool socket. Requesting `primary,secondary` opens a Primary socket and a Secondary socket, each subscribing the fannable channels once; both pools' messages flow to the same exchange/routing key, stamped with the connection's pool in the `x-bitmex-pool` header so downstream can split them without inspecting row contents. The per-pool socket is required because BitMEX keys a subscription by its bare topic and rejects the same topic twice on one connection.

A channel is fannable when it carries a `pool` **and** BitMEX honours its filter. The poolable set is `POOLED_CHANNELS` (`@tradebot/utils`); `fanByPool` (`src/pools.ts`) subtracts the `POOL_FILTER_IGNORED` exception. That exception is `instrument`: it is poolable (it has a `pool` field and accepts the filter) but BitMEX silently ignores the filter, so it is subscribed once, unfiltered, on the no-pool socket — since each pool has its own socket, fanning it would not be rejected as a duplicate; every pool's socket would just return the same full stream, duplicating the data. The exception is confined to `POOL_FILTER_IGNORED`; nothing downstream treats `instrument` specially. `default` and `aggregated` yield the same rows (bare vs explicit `::Aggregated`).

The subscribe ack drops the pool suffix — acking `orderBookL2::Primary` as `{ subscribe: "orderBookL2", pool: "Primary", success: true }` — so subscription confirmation matches on the **base channel + `ack.pool`** (`parseChannel` / `waitForSubscription`).

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
