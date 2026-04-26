# Digger Service — Technical Reference

## What digger is

Digger is the broadcast analogue in the replay module.

Broadcast maintains persistent WebSocket connections to BitMEX and forwards every
incoming message to a RabbitMQ topic exchange (`broadcast`). Digger does the same
job from the other direction: it reads historical data from MongoDB and publishes
it to a separate topic exchange (`replay`) in exactly the same WS message format.

A pipe in the replay module adds an e2e binding to move messages from `replay` to
the `deltas` queue, where `ws` and other services consume them the same way they
would consume broadcast messages. Downstream services bind queues to whichever
exchange they are configured for. No code change is needed on consumers.

```
Live:   BitMEX WS ──→ broadcast ──→ topic:broadcast ──→ topic:deltas ──→ consumers
Replay: MongoDB   ──→ digger    ──→ topic:replay    ──→ topic:deltas ──→ consumers
```

In addition to the stream, digger runs a BitMEX-compatible REST API on the same
HTTP server. Clients can use this to query current table state or a time range of
historical records — swapping only the base URL from live BitMEX to digger.

---

## The session clock — why it lives at the session level

**Different BitMEX tables have data from different start dates with very
different confidence levels:**

| Era      | What's available                                                   |
|----------|--------------------------------------------------------------------|
| 2014+    | trade, quote                                                       |
| 2016+    | + synthetic instrument (low confidence)                            |
| 2019+    | + reliable instrument, synthetic orderBookL2                       |
| 2026+    | + real continuous L2 (high fidelity)                               |

Bot families pick a starting era based on what their strategy needs. A naive
bot that only consumes trade and quote can train from 2014. A market-maker
needing real L2 has to wait until 2026. Once a family commits to an era, it
runs **many** subscriptions and REST queries from that fixed point. The clock
is set **once** when the family boots, and rarely changed thereafter.

That is why the clock is **session-level**, not per-subscription:

- A single digger instance serves a coherent stream from one point in time.
- All subscribers pull from the same chronological cursor.
- Tying the clock to a per-table subscribe parameter would let two bots
  consuming the same digger pull data from different eras into the same
  exchange — producing a temporally inconsistent stream that nothing
  downstream can reason about.

Subscriptions and the REST API both read from a single shared clock variable.
The only way to move it is `POST /set-clock` (described below) or the
`DIGGER_START_TIME` env var at boot.

**Future agents reading this code:** if you find yourself wanting to add a
`from`/`startTime` parameter to a subscribe-style endpoint, stop and re-read
this section. The clock is deliberately not per-subscription.

---

## Default behaviour — nothing is consumed

Digger starts with no subscriptions. It does not read MongoDB, does not fill any
buffers, and does not publish anything until told to via the commands API.

If `DIGGER_START_TIME` is set, the clock is initialised at boot and subscribes
work immediately. If not, the clock stays null and subscribes return 400 until
`POST /set-clock` is called.

---

## Commands API

HTTP server on **port 80**.

### Endpoints

```
POST /set-clock?timestamp=<ISO|epoch>   set or change the replay clock
POST /subscribe/:table                  start replaying a table from the clock
POST /unsubscribe/:table                stop replaying a table
POST /resubscribe/:table                refresh a table (no clock change)
```

### Set clock — `POST /set-clock?timestamp=...`

The session-level seek operation. Accepts ISO-8601 or epoch ms.

Sequence:
1. Pause the streaming engine (`state.isPaused = true`) — no new publishes,
   no new MongoDB fetches.
2. Brief settle delay so any in-flight publish completes.
3. **Purge** the watched queues (`DIGGER_WAIT_IF`) — discard every old-clock
   message still sitting in the broker. We don't wait for consumers to
   process them: stale data is worse than no data once the clock has moved.
4. Set the clock to the new timestamp.
5. Reset the snapshots accumulator (its state was for the old clock).
6. Re-prime every existing subscription: drop its buffer, fresh partial,
   fresh initial fetch — all at the new clock position.
7. Resume the stream loop. New data flows from the new clock onwards.
8. Return 201.

Returning 201 means: queues are empty, clock is updated, fresh data is about
to start flowing. Clients can resume consuming with confidence that the next
message they see is on the new clock.

**In-flight unacked messages stay with their consumers** — purge only clears
the broker-side ready buffer. Consumer services are responsible for dropping
any in-process state when they observe a clock-change boundary. A future
orchestrator (planned) will sit above this and coordinate the wider reset:
e.g., resetting bot positions and wallets when stepping between training
periods (a common use case is training across the first month of each year,
advancing the clock and resetting between leaps).

Changing the clock mid-session is rare. Most bot families set it once at
startup and run indefinitely.

### Subscribe — `POST /subscribe/:table`

Starts consuming `table` from the current replay clock.

Steps before the 201 response:
1. Validate the table name against the registered handlers.
2. Validate the clock is set (else 400).
3. Allocate a `TableBuffer` and register the subscription.
4. Build and publish the `partial` for this table (see Partials section).
5. Run the initial MongoDB fetch into the buffer.

After subscribe returns, the stream loop picks up the new buffer naturally on
its next iteration.

No `from` parameter — the clock is the seek position. If you need to start
from a different time, call `POST /set-clock` first.

### Unsubscribe — `POST /unsubscribe/:table`

Drops the subscription and its buffer immediately. Documents already fetched
but not yet published are discarded.

### Resubscribe — `POST /resubscribe/:table`

Refresh a single table: drops its buffer and re-runs subscribe. Useful for
recovery (e.g., a table got out of sync) without changing the session clock.

### Response codes

| Code | Meaning |
|------|---------|
| 201  | Subscribe / resubscribe / set-clock successful |
| 200  | Unsubscribe successful |
| 400  | Bad input (unknown table, malformed timestamp, clock not set) |

---

## REST API

Mounted at `/api/v1`. Mirrors the public BitMEX REST API surface so clients can
swap the base URL between live and replay modes without code changes.

### Endpoints

```
GET /api/v1/trade
GET /api/v1/quote
GET /api/v1/funding
GET /api/v1/settlement
GET /api/v1/insurance
GET /api/v1/trade/bucketed      ?binSize=1m|5m|1h|1d
GET /api/v1/quote/bucketed      ?binSize=1m|5m|1h|1d

GET /api/v1/instrument
GET /api/v1/orderBook/L2
GET /api/v1/liquidation
GET /api/v1/announcement
GET /api/v1/chat
GET /api/v1/publicNotifications
```

### Query parameters

| Parameter   | Type    | Default | Notes |
|-------------|---------|---------|-------|
| `symbol`    | string  | —       | Filter by instrument symbol |
| `count`     | integer | 100     | Max results, capped at 500 |
| `start`     | integer | 0       | Skip this many results |
| `reverse`   | bool    | false   | Descending timestamp order |
| `startTime` | time    | —       | ISO-8601 or epoch ms |
| `endTime`   | time    | —       | ISO-8601 or epoch ms |
| `columns`   | string  | —       | Comma-separated field names |

**"Now" in replay:** when `reverse=true` and no `endTime` is provided, `endTime`
defaults to `clock.fetch() ?? Date.now()`.

### Two query strategies

**REST-origin tables** (`trade`, `quote`, `funding`, `settlement`, `insurance`,
bins) are queried directly from MongoDB using a `timestamp` range filter.

**WS-origin tables** are served from the in-memory snapshots accumulator. The
accumulator reflects exactly what has been published to the stream up to the
moment the request is received.

---

## How data is stored in MongoDB

### The pipeline

WS-collected data flows through:
```
BitMEX WS → scribe → vault → clerk → assembler → registrar → MongoDB
```

The **assembler** reconstructs WS messages from raw vault CSV rows. It re-attaches
the static `keys` and `types` fields onto `partial` messages.

The **registrar** inserts messages into MongoDB with a deterministic numeric `_id`:
```
_id = dateOffset × 2^39 + msgIndex × 2^12
```
where `dateOffset` is days since 2000-01-01. `_id` values sort chronologically and
page forward O(log n) against the default `_id` index.

### WS-origin document shape

Tables captured from the BitMEX WS stream are stored as complete reconstructed WS
messages, **minus the `table` field** (inferred from the collection name):

```javascript
// Non-partial (insert / update / delete)
{
  _id:    number,
  action: 'update',
  data:   [{ symbol: 'XBTUSD', lastPrice: 50000, ... }],
}

// Partial
{
  _id:    number,
  action: 'partial',
  data:   [...],
  keys:   ['symbol'],
  types:  { symbol: 'symbol', timestamp: 'timestamp', ... },
  filter: {},
}
```

Re-publishing: strip `_id`, inject `table` (via the `wsPayload()` helper),
publish everything else as-is.

### REST-origin document shape

Tables collected via the BitMEX REST API are stored as individual flat records:

```javascript
{
  _id:       number,
  timestamp: '2025-01-01T00:00:00.000Z',
  symbol:    'XBTUSD',
  ...
}
```

Re-publishing: wrap each record as `{ table, action: 'insert', data: [...] }`.

---

## Table origins — 22 tables

### WS-origin (9 tables)

| Table | Notes |
|-------|-------|
| `orderBookL2` | Full L2 delta stream |
| `orderBookL2_25` | Top-25 levels |
| `orderBook10` | Top-10 snapshots |
| `instrument` | partial + update |
| `liquidation` | insert/update/delete; no data timestamp (uses _id day) |
| `announcement` | platform announcements |
| `chat` | trollbox |
| `connected` | user counter (no data timestamp) |
| `publicNotifications` | system alerts |

### REST-origin (13 tables)

`trade`, `quote`, `funding`, `settlement`, `insurance`, plus `tradeBin1m/5m/1h/1d`
and `quoteBin1m/5m/1h/1d`.

---

## Partials

Live BitMEX always sends a `partial` immediately after a subscribe — schema +
current state. Replay must do the same.

### Three resolution paths

1. **Warm accumulator** (`snapshots.buildSnapshot(table)` returns non-null):
   the table has been streaming or was previously subscribed in this session.
   Reuse the accumulator's current state. Always preferred when available.

2. **Cold WS-origin — backfill** ([commands/backfill.ts](../../services/digger/src/commands/backfill.ts)):
   1. Find the most recent stored partial whose timestamp ≤ X (current clock).
   2. Apply that partial to the snapshots accumulator.
   3. Apply every delta between that partial and X (in `_id` order).
   4. Read the resulting snapshot and publish it as the partial.
   5. Side effect: `buffer.cursor` is set to the highest `_id` we processed,
      so the first stream fetch starts strictly after X — no double-publishing
      of the deltas already absorbed.

   WS partials happen at every BitMEX reconnect (~hourly), so the database is
   full of partials and one within a few hours of any X is essentially
   guaranteed.

3. **Cold REST-origin — static partial**: REST-origin tables don't have stored
   partials (they're flat record streams). The handler declares a static partial
   carrying just the schema (`makeEmptyPartial`).

The published partial is also fed into the accumulator so the table is warm
for any subsequent subscribers.

---

## Sweep reconstruction (trade)

The live BitMEX WS groups trades that share the same `timestamp + symbol` into a
single `insert` message. REST-stored data preserves individual records, so digger
reconstructs sweeps by grouping consecutive documents with matching
`timestamp + symbol`.

**Known edge cases (acceptable):**
- Two distinct sweeps with the same `timestamp + symbol` (~1% of multi-level
  sweeps) are merged into one insert.
- A sweep group may straddle two buffer fills, emitting as two smaller inserts.
  Mitigated by the 5k low-watermark.

---

## Replay clock

The replay clock (`clock/index.ts`) is a module-level `number | null` singleton:
the epoch-ms timestamp of the last published message.

| Function | Behaviour |
|----------|-----------|
| `set(ms)` | Jump to any point in time (called by `POST /set-clock`). |
| `update(ms)` | Forward-only advance, called once per published message. |
| `fetch()` | Current replay time, or `null` when nothing is set. |

Read by the REST routes to interpret "now" in time-bounded queries, and by the
fetcher to seed the first MongoDB query of each subscription.

---

## Snapshots accumulator

`snapshots/index.ts` wraps `@devvir/bitmex-database`. Three operations:

| Function | Use |
|----------|-----|
| `feed(msg)` | Apply a published WS message. Called once per outbound message and once per partial. |
| `buildSnapshot(table)` | Produce the current accumulator state as a `partial`, or null if cold. |
| `reset()` | Drop all state. Called by `set-clock` when jumping eras. |

Used by both subscribe (to produce partials) and the REST API (to serve
WS-origin endpoints).

---

## Buffers

Each subscribed table has its own `TableBuffer`:

```
entries:     MongoDoc[]   pre-fetched docs in _id ascending order
cursor:      number|null  _id of last fetched doc (or seeded by backfill)
isFetching:  boolean      guard preventing concurrent fetches
exhausted:   boolean      true once a batch returned fewer docs than batchSize
```

**Lifecycle:**
1. `createBuffer()` — allocated on subscribe.
2. Backfill (WS-origin cold) — may seed `cursor` so the first stream fetch
   skips the docs already absorbed into the snapshot.
3. `initialFill()` — blocking first fetch from cursor or the clock.
4. `triggerFetch()` — non-blocking refill when below `bufferLowWatermark`.
5. Buffer dropped on unsubscribe (or rebuilt by `set-clock`).

**Pagination:** all fetches after the first use `{ _id: { $gt: cursor } }`.

**Watermarks:**

| Variable | Default | Description |
|----------|---------|-------------|
| `DIGGER_LOW_WATERMARK` | 5000 | Buffer refetch trigger |
| `DIGGER_BATCH_SIZE` | 1000 | Documents per fetch |

---

## Stream loop — k-way merge

The stream loop ([websocket/stream.ts](../../services/digger/src/websocket/stream.ts))
runs until shutdown or until all subscribed buffers are exhausted.

**Per step:**
1. If `state.isPaused` (set-clock in progress), sleep 10ms and retry.
2. Call `pickNext(state)` — find the buffer whose head document has the
   globally smallest timestamp (k-way merge across all buffers).
3. Call `handler.take(buffer.entries)` — consume the next logical message.
4. For each resulting message: publish → feed snapshots → advance clock.
5. If the buffer dropped below `bufferLowWatermark`, trigger background refetch.

**Throttling:** RabbitMQ backpressure via `DIGGER_WAIT_IF`. When set,
`exchange.publish()` automatically blocks when watched queues exceed their
depth limits. The `BackpressureGuard` polls the management API on a timer
(every 30s normally, 3s when paused) — never on every publish call.

---

## Backpressure & queue purging

Two related but distinct mechanisms, both keyed on the queues listed in
`DIGGER_WAIT_IF`:

**Continuous backpressure**: during normal streaming, the publisher blocks
when watched queues exceed their max depth and resumes when they drop below
90% of max. Hysteresis prevents flapping. Polled every 30s.

**Purge-on-set-clock**: when the clock changes, digger calls
`@devvir/rabbitmq`'s `purgeQueues()` to immediately discard every ready
message in the watched queues via the management API. This avoids sending
stale (old-clock) data to consumers after a seek has been requested.

---

## Module structure and boundaries

```
src/
  clock/             replay clock singleton (set / update / fetch)
  snapshots/         in-memory WS state accumulator (feed / buildSnapshot / reset)

  websocket/         streaming engine
    stream.ts        main loop (respects state.isPaused)
    merge.ts         pickNext / allExhausted
    buffer.ts        FIFO operations
    fetcher.ts       MongoDB queries (uses clock.fetch() for first seek)
    publisher.ts     publish / publishPartial; broadcast-compatible headers

  commands/          control plane
    setClock.ts      POST /set-clock — pause, drain, set, reset, re-prime, resume
    subscribe.ts     subscribe / unsubscribe / resubscribe
    backfill.ts      cold WS-origin partial reconstruction
    routes.ts        Express Router

  rest/              BitMEX-compatible REST API
    params.ts        parse and normalise query parameters
    query.ts         queryRecords (MongoDB) + querySnapshot (accumulator)
    routes.ts        Express Router mounted at /api/v1

  tables/            per-table transform logic
    handler.ts       TableHandler interface + helpers (wsPayload, wrapAsInsert, ...)
    registry.ts      TABLE_HANDLERS map (22 handlers)
    ws/              9 WS-origin handlers
    rest/            13 REST-origin handlers

  setup/indexes.ts   ensureIndexes — symbol+timestamp on REST-origin collections
  http/server.ts     single Express app, two route groups on port 80

  types.ts           all interfaces and types
  config.ts          env var loading and validation
  service.ts         SKFactory declaration
  index.ts           entry point — seeds clock from DIGGER_START_TIME
```

---

## Publishing format

```
Exchange:    replay  (topic, declared by digger on startup)
Routing key: <table>.<action>     e.g. "trade.insert", "instrument.partial"
Body:        JSON-encoded WS message — { table, action, data, [keys, types, filter] }
```

### Headers (broadcast-compatible)

| Header | Value | Notes |
|--------|-------|-------|
| `x-worker-uuid` | digger instance UUID | Same as broadcast |
| `x-message-count` | incrementing counter | Same as broadcast |
| `x-bitmex-version` | `"2.0.0"` (constant) | Hardcoded — replay data was captured under this WS API version. If BitMEX bumps the wire format, the stored data and this constant need migrating together. |
| `x-bitmex-published-at` | ISO-8601 wall clock | Same as broadcast |

### Differences vs broadcast headers

| Header | Broadcast | Digger | Why |
|--------|-----------|--------|-----|
| `x-account-id` | present (empty for guest) | **absent** | Replay only handles public data. Authenticated streams are out of scope. |

---

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DB_DATABASE` | **Yes** | — | MongoDB database name |
| `DIGGER_LOW_WATERMARK` | No | 5000 | Buffer refetch trigger |
| `DIGGER_BATCH_SIZE` | No | 1000 | Documents per MongoDB fetch |
| `DIGGER_WAIT_IF` | No | — | Backpressure: `queueA:10000,queueB:5000` |
| `DIGGER_START_TIME` | No | — | Initial clock (ISO-8601 or epoch ms). When unset, subscribes return 400 until `POST /set-clock` is called. |

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `@devvir/service-kit` | Service lifecycle, RabbitMQ broker, logging |
| `@devvir/bitmex-database` | In-memory WS state accumulator |
| `@tradebot/types` | BitMEX table and field type definitions |
| `@tradebot/utils` | SKFactory, testing helpers |
| `mongodb` | MongoDB driver |
| `express` | HTTP server |

---

## Open / pending

**Buffer boundary sweep split** ([tables/rest/trade.ts](../../services/digger/src/tables/rest/trade.ts))
A sweep group may straddle two buffer fills, emitting as two smaller inserts.
Fix: trim the last fetch batch to the final complete timestamp boundary;
carry trailing docs into the next cursor. Mitigated by the 5k low-watermark.

**Exhausted buffer retry**
`exhausted = true` permanently halts fetching. For sessions where collection is
ongoing, change to a retry-after-delay approach.

**Pre-1970 / pre-2000 dates**
Registrar's `_id` encoding starts at 2000-01-01. Any data older than that
(unlikely but possible for synthetic backfills) would need a different indexing
strategy.
