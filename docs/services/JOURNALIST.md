# Journalist Service — Technical Documentation

## Overview

Consumes BitMEX WebSocket messages from RabbitMQ and flushes them to vault (where they're saved as date-partitioned CSV files). Journalist is the real-time counterpart to scribe (REST) and courier (S3 dumps).

```
broadcast → exchange:broadcast
                ↓  (pipe: topic:broadcast > topic:journalist)
         exchange:journalist → queue:journalist → journalist → vault
```

---

## Consuming

Journalist consumes the `journalist` queue with a prefetch of 100. Each delivery must be a BitMEX **data** message (`isBitmexDataMessage` — carries `table` and `action`); anything else is logged and ignored.

One header drives routing:

- **`x-bitmex-published-at`** — the collector's publish/reception time. It is **required**: a message without it cannot be filed and is logged as an error and acked (dropped). This value is stored verbatim as the `_date_` column and is the fallback bucket key (see [Day Bucketing](#day-bucketing)).

A message is acked only after it has been handed to the buffer, and a `message` event is emitted for metrics.

---

## Table Routing

`route.ts` maps a message's data to its vault table(s) in two steps: `routeMessage` (split by content) then `vaultTable` (pool → table name).

`routeMessage` splits `trade` by `size`: real prints (`size !== 0`) go to `trade`, and referential index prints (`size === 0`, on `.`-prefixed index symbols) go to the derived `tick` table — mirroring how the two are collected from REST. Every other table passes straight through as one group.

`vaultTable` then resolves the group's actual vault table. For most tables that's just the table name — `pool` rides along as an ordinary column, all pools sharing one bucket (`trade`, `quote`, `instrument`). But **pooled-fanout tables** (`POOL_FANOUT_CHANNELS` — the order-book family and bins, collected with one WS client per pool) route their non-`Primary` data to a per-pool pseudo-table: `orderBookL2` → `orderBookL2.secondary`. `Primary` and pool-less data keep the base name. This keeps each pool's bucket independent, so a lagging pool client can never stall or truncate another pool's file — and it lets `data prepare` merge each pool's sources on its own. A message's rows all share one pool (per-pool subscription), so the first row decides.

Each resulting group is then just another table, with its own buffer, write chain, day tracking, and vault directory.

---

## Day Bucketing

`route.ts`'s `bucketDay` decides the day (`YYYYMMDD`) a message is filed under, from the **exchange event time** — the **maximum** `timestamp` across the message's data items. A delta (`insert`/`update`/`delete`) shares one `timestamp` across all items, so the max equals that single value. A `partial` is a full-state snapshot whose items each carry their own *last-update* time (often spanning back a day, in any order), so the max is the snapshot's emission boundary — no item is newer. A message is never split across days; it lands whole in the day of its newest item.

Timeless tables (`connected`, `liquidation`, `publicNotifications` — no `timestamp` field in the BitMEX spec) and empty `data` arrays have no event time, so they fall back to the reception date (`x-bitmex-published-at`). Only the bucket is affected — the stored `_date_` column is always the reception time. `bucketDay` picks the day only; a message's position *within* the day (relative to surrounding deltas) is set later by `data prepare`'s sort.

Bucketing by event time rather than reception time keeps an event and its duplicates together: ghost-subscription copies and the same event recorded by different collectors arrive with varying lag, but all carry the identical exchange `timestamp`, so they land in the same day file regardless of when each copy was received.

---

## Buffering and Flushing

Messages are not written to vault on arrival. Each table has its own in-memory buffer holding `{ day, message }` entries. A buffer is flushed when any of the following occurs:

- The buffer reaches **1,000 entries** (`FLUSH_SIZE`).
- **1 second elapses** since a flush was scheduled for that buffer (`FLUSH_INTERVAL`).
- `flushAll()` is called — on shutdown, or by the closer just before it seals a day (see [Closing Day Buckets](#closing-day-buckets)).

On flush, a buffer's entries are grouped by day and **one write is enqueued per day**. Each table owns a promise chain that serializes its writes, so a table's vault writes never overlap or reorder. All rows from a single WebSocket message always travel together in one write — never split across files or days.

---

## Writing to Vault and the `.tail` Safety Valve

`vault.ts`'s `writeToVault` issues `POST /files/:table/:date/rows` (with `?suffix=` when a vault suffix is configured). The body is a JSON array of WS message objects `{ action, date, data }`; vault encodes `_date_` and `_action_` onto the first row of each message and leaves them empty on continuation rows. The call returns one of three outcomes:

- **`ok`** — rows accepted (2xx).
- **`closed`** — the bucket is sealed or mid-close (HTTP 409).
- **`unavailable`** — vault is throttled, unhealthy, or unreachable (429 / 503 / 5xx / network error).

`writeWithRetry` (in `buffer.ts`) acts on the outcome:

- **`unavailable`** → engage the back-pressure gate and retry the same write after a recovery pause (`waitForVault`, 5 s) until it clears. The gate stalls `receive()` across all tables while vault is down, so the consumer holds (up to `prefetch` messages) rather than losing data.
- **`closed`** → the day's bucket was already sealed, meaning a message arrived more than the close grace period late. Rather than drop the rows, they are re-sent to a sibling file under the suffix `<suffix>.tail` (e.g. `20260623.local` → `20260623.local.tail`). Tail files are **never closed**, and because vault lists files by exact suffix tag they are never seen by the closer's base-suffix sweep, so they simply accumulate as `<day>.<suffix>.tail.csv.gz.tmp`. A tail write can therefore only return `ok` or `unavailable`. A tail file is an operator signal that an assumption broke — the late data is preserved for manual handling rather than silently lost.

---

## Closing Day Buckets

`closer.ts` records the latest day seen per table and, on a strictly later day (or the first day after startup), schedules a close **5 minutes later** (`SCHEDULE_DELAY_MS`), giving late/lagging writes for the prior day time to land. **All of the close logic and the knowledge it needs live in `closer.ts` alone** — the rest of the service just computes the agnostic day (`timestamp ?? date`) and notifies `track`; it knows nothing of endpoints or date-vs-timestamp.

A bucket is "done" once the clock it's bucketed by has crossed midnight:
- **date-driven** tables (the timeless ones — `connected`, `liquidation`, `announcement`, `chat`, `publicNotifications`; no `timestamp` field) are done when the **collector** crosses, i.e. their `_date_` ticks over (≈ on time).
- **timestamp-driven** tables (`instrument`, `orderBookL2`) are done when the **data** crosses, i.e. their max exchange `timestamp` ticks over. Because reception `_date_` ≥ emit `timestamp`, a data crossing always happens *after* the collector crossed — so it's the safe (late) signal.

Clients run independently and can lag each other, so a close is scoped to an **endpoint** and never seals a table on another client. `platform` is steady; `realtime` can fall tens of minutes behind under backpressure. The endpoint is resolved from `REALTIME_CHANNELS` / `PLATFORM_CHANNELS`. **Pooled-fanout tables go further:** each is collected by one client per pool (`orderBookL2` and `orderBookL2.secondary` are separate buckets), so any pool can lag the others — each seals strictly in isolation, neither triggering nor joining an endpoint sweep (they're filtered out of it via `isPooledFanout`).

Closes fire on the safe signal:

- **platform table crosses** → close the platform endpoint.
- **realtime timestamp-driven table crosses** → close the realtime endpoint (the data has crossed, so every date-driven bucket on it — `liquidation` — is already complete and safe to sweep). Pooled-fanout tables are excluded — they never ride another table's crossing.
- **realtime date-driven table (`liquidation`) crosses** → close **just that table** — so it still seals if no timestamped realtime table is being collected, and promptly rather than waiting for the endpoint sweep.
- **pooled-fanout table crosses** (any pool) → close **just that pool's bucket**.
- **past day (replay) or a table in neither channel set** → close **just that table**.

This is why a midnight `connected` (platform) no longer seals the lagging realtime buckets: it closes only platform. The single-client realtime tables seal when *their own* data crosses (~their own lag later), and each pooled-fanout pool seals on its own crossing — so late rows land in the bucket, not the `.tail` valve.

Before a close reaches vault, `beforeClosing` (the buffer's `flushAll`) drains buffered writes so anything still pending for the day being sealed lands first. `closeOpenBucketsBefore` then lists vault's files for the table(s) and closes every open bucket strictly before the target day. Close calls retry internally in `vault.ts`.

---

## Startup and Shutdown

On startup journalist connects to RabbitMQ, builds the buffer and closer, and begins consuming. The day a message belongs to comes entirely from its own `timestamp` (no wall clock), so live feeds and replayed historical streams behave identically.

On shutdown the consumer is stopped and `flushAll()` drains every table's buffer before the process exits.

---

## Output Format (Vault)

Rows are written via `POST /files/:table/:date/rows`. The body is a JSON array of WS message objects — each carries the `action`, reception `date`, and the `data` items of one WebSocket message:

```json
[
  { "action": "insert", "date": "2026-06-23T00:00:01.500Z", "data": [ { "timestamp": "…", "…": "…" } ] },
  { "action": "update", "date": "2026-06-23T00:00:01.700Z", "data": [ { "timestamp": "…", "…": "…" } ] }
]
```

The table name is the message's routed vault table (`route.ts` — the message's own table, or `tick` for referential `trade` prints). The date path segment (`YYYYMMDD`) is the message's [event-time day](#day-bucketing). A `?suffix=` query tags the file when a vault suffix is configured.

---

## RabbitMQ Topology

Journalist owns and declares its own exchange and queue on startup:

| Resource              | Type  | Details                                |
|-----------------------|-------|----------------------------------------|
| exchange `journalist` | topic | Durable                                |
| queue `journalist`    | —     | Bound to exchange with routing key `#` |

The `broadcast` → `journalist` exchange binding is created by the `pipe` service in the journal module. Journalist has no knowledge of broadcast.

Prefetch is set to 100. While vault is unavailable the back-pressure gate blocks `receive()` until vault recovers, so the consumer stalls (holding up to `prefetch` messages) rather than nacking and requeueing — messages are acked only after their rows have been handed to the buffer.
