# WebSocket Service - Technical Documentation

## Overview

The WebSocket service exposes a BitMEX-compatible WebSocket API (subscribe/unsubscribe, partial/insert/update/delete) and bridges it to internal data sources. Clients authenticate and subscribe as they would with BitMEX, but the underlying data comes from configurable upstreams (live market data, replayed history, test scenarios).

Snapshots are accumulated in-memory from the same delta stream the service consumes, via `@devvir/bitmex-database`. No external HTTP fetches are involved in the subscribe path.

## Architecture

### Components

```
RabbitMQ broadcast queue ──► delta consumer
                                │
                                ├─► snapshots.apply(delta, counter)   (in-memory state)
                                └─► bus emits 'delta:{table}:{action}'

WebSocket client ──► subscription handler
                        ├─ snapshots.get(table, symbol?, account?)   (local lookup)
                        └─ per-client elastic queue on the delta bus
```

The service owns a single `Snapshots` instance (a thin wrapper around `@devvir/bitmex-database`) that is updated on every incoming delta and read synchronously on every subscribe.

### Connection & Message Model

```
Client WS Connection
    ├─ on connect: send welcome message
    ├─ on subscribe: read snapshot locally, initialize per-client queue, activate or retry
    └─ on delta: delta arrives on bus → pushed into each subscribed queue → streamed if counter passes
```

### Client Subscription Flow

When a client sends `{"op": "subscribe", "args": ["table:symbol"]}`:

1. **Create per-client elastic queue** on the `delta:{table}:*` bus channel. Any delta arriving between now and activation is captured, not lost.

2. **Read the snapshot** via `snapshots.get(table, symbol?, account?)`:
   - If present → returns `{ snapshot, counter }`, the subscription activates immediately.
   - If absent → the table has no accumulated state yet. The service POSTs to `wsCommandsUrl/resubscribe/{table}` so that `broadcast` will begin streaming it. If broadcast rejects (HTTP 400) the table is genuinely unknown and the client receives an `Unknown table` error. Otherwise, the subscribe schedules a 5s retry loop until the first partial arrives and populates the snapshot.

3. **Activation:** send the snapshot as a `partial`, then stream the queue from the snapshot's counter forward. Messages with counters less than or equal to the snapshot counter are filtered out by the elastic queue.

### Routing Key

- **Public tables:** `{table}:{symbol}`, with `_` used when no symbol is requested (wildcard).
- **Private tables** (`order`, `position`, `margin`, `execution`, `transact`, `wallet`, `privateNotifications`, `affiliate`): `{table}:{accountId}`. Private subscriptions require an authenticated API key; deltas are only delivered to the matching account.

Wildcard subscribers (`_`) also receive deltas for any symbol on the same table.

## Snapshot Accumulation

The delta consumer applies every incoming BitMEX message (`partial`, `insert`, `update`, `delete`) to the in-memory state before emitting it to the bus:

- `partial` messages replace the table's content and register the table as available.
- `insert` / `update` / `delete` mutate state on the corresponding row keys.
- The latest `x-message-count` header value is stored per table and returned alongside the snapshot so clients can filter deltas by counter.

The service does **not** support pre-filtered partials (i.e. partials with `filter.symbol` set). BitMEX partials are always full-table; filtering is applied at read-time by `snapshots.get`.

## Message Ordering & Buffering

Per-client elastic queues with counter-based filtering guarantee strict ordering:

### Before Snapshot Arrives (retry loop)
- Queue captures all incoming deltas for the subscribed key.
- No messages are forwarded to the client yet.

### On Activation
- The snapshot is sent immediately as a `partial`.
- The queue begins streaming: each delta with `counter > snapshot.counter` is forwarded. Older deltas (captured before the snapshot's state took effect) are dropped.

### Counter Header Handling

- **Expected:** RabbitMQ header `x-message-count` with a numeric counter value.
- **Missing or `0`:** treated as counter `0`. Any positive counter then passes the filter, so there is no replay gap in fresh-snapshot scenarios.
- Counter-based ordering is the only mechanism — no timestamp fallback exists.

## RabbitMQ Integration

The service declares:
- **Queue:** `ws.deltas` (durable, non-exclusive)
- **Binding:** `broadcast` exchange → `ws.deltas` queue with pattern `*.*` (all tables, all actions)

Consumed messages are applied to the snapshot store, emitted on the event bus, and acknowledged individually. The `x-message-count` header provides ordering; the `x-account-id` header (present on private streams) routes deltas to the matching client.

## Broadcast Commands

The service makes one outbound HTTP call in the subscribe path: `POST {wsCommandsUrl}/resubscribe/{table}` when the requested table is not yet in the snapshot store. The response distinguishes "table in flight" (201 / other non-400 status → retry) from "genuinely unknown" (400 → reject the subscribe).

## Configuration

Requires RabbitMQ — see [infra packs](../../modules/infra/README.md).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WS_COMMANDS_URL` | yes | `` | Base URL of the provider's commands API (broadcast/digger) |
| `WS_PORT` | no | `` | WebSocket server port mapping on host |

## Lifecycle

1. **On start** — connect to RabbitMQ, start consuming deltas, listen for WebSocket connections.
2. **On delta (from RabbitMQ)** — apply to snapshot store, emit on bus.
3. **On client connect** — send welcome, register client, await subscribe commands.
4. **On subscribe** — create queue, read snapshot, activate (or signal broadcast + retry).
5. **On client close** — remove from all queues, clean up table listeners when idle.
6. **On shutdown** — close client connections, stop consuming from RabbitMQ, exit cleanly.

## Dependencies

### External Runtime
- **RabbitMQ** — consumes delta updates from the `broadcast` exchange. See [infra packs](../../modules/infra/README.md).
- **Broadcast service** — reached over HTTP when a subscribed table is not yet tracked.
- **Node.js 18+** — native WebSocket server and `fetch`.

### NPM Packages
- `ws` — WebSocket server library.
- `@devvir/bitmex-database` — in-memory BitMEX table state accumulator.
- `@devvir/elastic-queue` — per-client delta buffer.
- `@devvir/service-kit` — service lifecycle and RabbitMQ broker.
- `@tradebot/utils` — shared utilities (logger, private-channel list).

## Error Handling

### Subscribe
- **Table not yet accumulated** — broadcast signaled; retry every 5s.
- **Broadcast rejects (400)** — treated as `Unknown table`, client receives a 400 error.
- **Broadcast connection error** — retry loop continues; client stays in `awaitSnapshot`.

### Delta Processing
- **Malformed message** — logged, skipped, consumption continues.
- **Pre-filtered partial** — logged and dropped (unsupported).
- **Client send fails** — connection closed cleanly, state removed.

### Graceful Shutdown

On SIGTERM/SIGINT:
1. Stop consuming RabbitMQ messages.
2. Close all client WebSocket connections.
3. Exit, releasing all in-memory state.

See [service-kit: graceful shutdown](../../packages/service-kit/docs/guides/graceful-shutdown.md).

## Performance Characteristics

### Memory
- **Snapshot store** — one accumulated copy of every subscribed BitMEX table.
- **Per-client** — O(subscriptions) plus any deltas buffered during the (usually brief) activation window.

Large order books (e.g. `orderBookL2` with 10k rows) are held once centrally and read by reference on each subscribe.

### Latency
- **Subscribe activation** — synchronous local lookup; only the table's first-ever subscribe pays a network cost (broadcast signal + retry).
- **Delta broadcast** — in-memory bus emit + per-queue filter; dependent on connected client count.
