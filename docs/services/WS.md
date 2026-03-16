# WebSocket Service - Technical Documentation

## Overview

The WebSocket service translates an external BitMEX WebSocket API surface (subscribe/unsubscribe, partial/insert/update/delete messages) and bridges it to internal data sources. Clients authenticate and subscribe as they would with BitMEX, but the underlying data comes from configurable sources (live market data, replayed history, test scenarios).

## Architecture

### Connection & Message Model

```
Client WS Connection
    ├─ on connect: send welcome message
    ├─ on subscribe: fetch snapshot via HTTP, initialize per-client queue
    └─ on message: add to client queue → apply filter → stream if passes
        ↓
 Per-Client Queue State
    ├─ size: buffer capacity (100 before snapshot, 0 after)
    ├─ drop: bool (true before snapshot, false after)
    ├─ counter: minimum counter to send (0 before snapshot, snapshot.counter after)
    ├─ data: FIFO message buffer
    └─ filter: ! drop && msg.counter >= counter
```

### Client Subscription Flow

When a client sends `{"op": "subscribe", "args": ["table:symbol"]}`:

1. **Initialize per-client message queue:**
   - `size = 100` (buffer up to 100 messages while waiting for snapshot)
   - `drop = true` (overflow discards oldest messages)
   - `counter = 0` (filter blocks all messages: `! true && msg.counter >= 0` = false)
   - All incoming deltas enqueued; overflow discards based on policy

2. **Fetch snapshot via HTTP** from `SNAPSHOTS_URL/snapshot/{table}`
   - If 404 → retry with 5s exponential backoff
   - If 200 → extract `{ table, action: "partial", data, keys, counter, ... }`

3. **On snapshot arrival:**
   - Send snapshot to client immediately
   - If `snapshot.counter === 0`: flush queue (send all buffered messages, pass-through filter)
   - Reconfigure queue: `drop = false, size = 0, counter = snapshot.counter`
   - Queue now operates as pass-through with counter-based filtering

4. **Live updates:**
   - All incoming deltas added to queue
   - Queue filter (`! drop && msg.counter >= counter`) applied
   - Messages passing filter sent to client immediately

### Queue Processing

All deltas from RabbitMQ flow through per-client queues:

```
Delta arrives (counter from x-message-count header)
    ↓
Add to all client queues
    ↓
If queue.size >= capacity: drop oldest (if drop=true) or skip (if drop=false)
    ↓
Apply filter: ! queue.drop && delta.counter >= queue.counter
    ↓
If passes: send to client | If fails: stay buffered
```

**FIFO guarantee:** Since all messages enter and exit via the same queue, FIFO order is preserved at least as well as during direct streaming.

**Elastic sizing:** By tuning `size` and `drop` policy, queue can buffer aggressively before snapshot (size=100, drop=true) or transparently after (size=0, pass-through).

## Message Ordering & Buffering

The WebSocket service uses per-client message queues with counter-based filtering for strict message ordering:

### Before Snapshot Arrives
- Queue buffering: size = 100 (drop oldest on overflow)
- Filter: blocks all messages (counter = 0)
- Result: up to 100 deltas buffered, none sent until snapshot arrives
- **Bounds the pending time:** If snapshot never arrives, clients don't wait indefinitely (100 messages max buffer, then oldest discarded)

### After Snapshot Arrives
- Queue buffering: size = 0 (transparent pass-through, no buffering)
- Filter: `! drop && msg.counter >= snapshot.counter`
- Result: only deltas with counter > snapshot counter are sent (gaps discarded, out-of-order handled)
- **If snapshot.counter === 0:** queue flushed immediately (all buffered messages sent), then filter toggles to pass-through

### Counter Header Handling

- **Expected:** RabbitMQ header `x-message-count` with numeric counter value
- **If missing or `0`:** Treated as counter 0 (before snapshot, queue blocks; after snapshot, queue flushed and enters pass-through with counter = 0, so all deltas pass)
- Counter-based ordering is the only mechanism — no timestamp fallback exists

## State & Data Structures

### Per-Client Message Queue

| Field | Type | Purpose |
|-------|------|---------|
| `size` | number | Buffer capacity (100 before snapshot, 0 after) |
| `drop` | bool | Overflow policy (true before snapshot, false after) |
| `counter` | number | Minimum counter filter (0 before snapshot, snapshot.counter after) |
| `data` | Buffered[] | FIFO message buffer |

### Global Maps

| Map | Key | Value | Lifetime |
|-----|-----|-------|----------|
| `clientQueues` | WebSocket instance | Queue state + buffer | Until client closes |
| `subs` | `{table}:{symbol}` | `Set<WebSocket>` | Until unsubscribe or client closes |
| `clients` | WebSocket instance | `Set<keys>` | Entire connection duration |

**Note:** No persistence — state exists only in RAM. On service restart, clients must refetch snapshots and resubscribe.

## RabbitMQ Integration

The service declares:
- **Queue:** `ws.deltas` (durable, non-exclusive)
- **Binding:** `broadcast` exchange → `ws.deltas` queue with pattern `*.*` (all tables, all actions)

No snapshot queue — snapshots are fetched via HTTP from the snapshots service on demand.

Messages are consumed and acknowledged individually. The `x-message-count` header is extracted and used for ordering.

## HTTP Server

### GET /snapshot/{table}

The service makes HTTP GET requests to the snapshots service at startup of a client subscription.

**Expected response (200):**
```json
{
  "table": "orderBookL2",
  "action": "partial",
  "keys": ["symbol", "id", "side", "size", "price"],
  "data": [["XBTUSD", 1, "Buy", 100, 20000], ...],
  "counter": 42
}
```

Retried on 404 with 5-second delay. Timeout/connection error → logged, client put in pending state waiting for snapshot availability.

## Trade-offs & Design Notes

### Bounded Buffering Before Snapshot
- Pre-snapshot queue (size = 100) ensures clients never wait indefinitely for snapshot
- After 100 deltas arrive, oldest are discarded (not relayed to client)
- Once snapshot arrives, full counter-based filtering kicks in
- **Implication:** If snapshot fetch takes a very long time AND many deltas arrive for different symbols during that time, clients for slow symbols may miss some early deltas (worst case: 100 deltas dropped)

### Slow Tables / Symbols (Now Bounded)
- **Old behavior:** Client could wait indefinitely for first delta to arrive
- **New behavior:** Client waits at most for ~100 deltas to pass on the table/symbol; after that, pending queue discards oldest
- Still not ideal for truly dormant symbols, but no indefinite waits

### Time-Based Pruning (Future Improvement)
- Current design prunes based on queue size only
- Could add timeout: if snapshot not received after N seconds, activate with pending queue + `counter = 0` flush
- Would guarantee max latency even for slow/dormant symbols

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RABBITMQ_URL` | yes | — | RabbitMQ connection string |
| `WS_PORT` | no | `8180` | WebSocket server port |
| `SNAPSHOTS_URL` | no | `http://snapshots:3001` | Base URL for snapshots service (used as `{SNAPSHOTS_URL}/snapshot/{table}`) |

## Lifecycle

1. **On start** — Connect to RabbitMQ, start consuming deltas, listen for WebSocket connections
2. **On client connect** — Send welcome, register client, await subscribe commands
3. **On subscribe** — Fetch snapshot, check buffer, serve or defer
4. **On delta (from RabbitMQ)** — Buffer, flush pending, broadcast to active
5. **On client close** — Remove from all subs, cleanup pending entries, cleanup clients map
6. **On shutdown** — Close all client connections, stop consuming from RabbitMQ, exit cleanly

## Public vs. Private Streams (Future)

Currently the service handles all tables uniformly. The architecture supports future split into:
- **Public streams** — from `broadcast` exchange (no authentication required)
- **Private streams** — from `account` exchange (require API key signature authentication)

Authentication would intercept at connection time, before subscribe is processed.

## Dependencies

### External Runtime
- **RabbitMQ** — For consuming delta updates from the `broadcast` exchange
- **Snapshots service** — For HTTP snapshot fetches on client subscribe
- **Node.js 18+** — For native WebSocket server and fetch API

### NPM Packages
- `ws` — WebSocket server library
- `@devvir/service-kit` — Service lifecycle and RabbitMQ broker
- `@tradebot/utils` — Shared utilities (logger)

## Error Handling

### Snapshot Fetch Failures
- **404** — Retry every 5 seconds until available
- **Connection error** — Log, subscribe remains pending until resolved
- **Timeout** — Same as connection error

### Delta Processing
- **Malformed message** — Logged, skipped, consumption continues
- **Client send fails** — Close connection cleanly, cleanup state

### Graceful Shutdown

On SIGTERM/SIGINT:
1. Stop accepting new RabbitMQ messages
2. Close all client WebSocket connections
3. Exit, releasing all in-memory state

See [service-kit: graceful shutdown](../../packages/service-kit/docs/guides/graceful-shutdown.md).

## Performance Characteristics

### Memory
- **Per-client overhead** — O(subscriptions) plus buffered deltas (30s window)
- **Per-table overhead** — O(snapshot size) + O(buffer size) shared across all clients

Large order books (e.g., orderBookL2 with 10k rows) are buffered for all clients of that table. Consider memory limits when scaling client count.

### Latency
- **Snapshot fetch** — HTTP round-trip to snapshots service (typically <10ms locally)
- **Delta broadcast** — In-memory Set iteration, network I/O (dependent on client count)

### Concurrency
- **Multiple simultaneous subscribes** — Handled by async subscribe with separate HTTP fetches
- **Pending flush** — O(pending clients) on each delta; typically small (fast move to active)
