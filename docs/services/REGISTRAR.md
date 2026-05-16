# Registrar Service — Technical Reference

## Overview

```
            data + control
              from clerk
                 │
                 ▼
   fanout:registrar ──→ queue:registrar ──→ registrar
                                              ├─ MongoDB tradebot.<table>
                                              └─ Redis customs:<table>:<date>
```

Registrar is the write endpoint of the customs pipeline. It consumes every
message routed into the `registrar` fanout queue and dispatches on routing key:

- `message` / `record` — data documents → assigned a deterministic `_id` and
  bulk-inserted into MongoDB.
- `control` — a `complete` signal from clerk → the bucket's goal index.

Registrar is the **ground truth** for what has been safely stored. It owns the
`customs:<table>:<date>` Redis keys; clerk reads them but never writes them.

## Document _id

Every data document receives a deterministic 53-bit integer `_id`:

```
_id = dateOffset × 2³⁹ + msgIndex × 2¹² + reserved
```

| Field | Bits | Range | Description |
|---|---|---|---|
| `dateOffset` | 14 | 0 – 16383 | Days since 2000-01-01 UTC; valid until ~2044 |
| `msgIndex` | 27 | 0 – 134217727 | Message position within the vault file |
| `reserved` | 12 | 0 | Always 0; 1–4095 reserved for future gap-fill events |

`msgIndex` comes from the `x-msg-index` AMQP header set by clerk. For WS
tables it is the group index (one per original WS message); for REST tables
it is the row index.

The maximum value equals `Number.MAX_SAFE_INTEGER`, so `_id` is always
representable as a JavaScript number.

## Insert Batching

Documents are accumulated in memory grouped by collection (= `x-table`
header). A flush timer runs every `REGISTRAR_FLUSH_INTERVAL_MS` (default
50 ms) and calls `insertMany({ ordered: false })` for each pending collection.

Batches are removed from the pending map before the MongoDB write returns, so
new messages for the same collection start accumulating immediately without
waiting for the in-flight write.

### Error handling

| Error | Handling |
|---|---|
| `E11000` duplicate key | ACK silently — document already in database |
| Transient error | Retry up to 3 times with a 2 s delay between attempts |
| All retries exhausted | `nack(requeue=true)` all entries in the batch |

The progress counter (see below) is bumped on successful insert **and** on
`E11000` — both mean "this document is in the database."

## Progress Tracking

Registrar holds an in-memory `BucketState` per `(table, date)`:

| Field | Meaning |
|---|---|
| `counter` | Highest `msgIndex` confirmed stored so far. Starts at `-1`. |
| `goal`    | The bucket's last `msgIndex`, set when clerk's `complete` control message arrives. `null` until then. |

- Every successful `insertMany` (or `E11000`) calls `record(table, date,
  msgIndex)`, which advances the bucket's `counter` to `max(counter, msgIndex)`.
- A `complete` control message calls `recordControl({ table, date,
  highestIndex })`, which sets the bucket's `goal`.

### Redis flush

A timer running every `REGISTRAR_PROGRESS_INTERVAL_MS` (default 1000 ms)
walks every in-memory bucket. Each tick is an MGET of all bucket keys followed
by per-bucket SETs:

- If the existing Redis value starts with `'done'` → **skip the write** and
  drop the bucket from memory. Done buckets are immutable; this guard
  prevents a late or repeated message from resurrecting a closed bucket and
  overwriting its done marker with a fresh counter.
- Else if `goal !== null && counter === goal` → write `'done:<count>'` to
  `customs:<table>:<date>` and drop the bucket from memory.
  `count = goal + 1` — the total number of messages in the bucket, since
  `goal` is the 0-based highest msgIndex.
- Otherwise → write `String(counter)` to `customs:<table>:<date>`.

So the stored value transitions from a numeric `counter` (the highest
msgIndex stored so far) to a non-numeric `done:<count>` (the total message
count). The semantic shifts from "highest index reached" to "total messages",
deliberately — once a bucket is closed, the index is no longer useful and the
count is.

The flush is reentrancy-guarded — if Redis is slow, overlapping flushes can't
stack. The counter is strictly increasing, so out-of-order writes are
acceptable (a stale flush always writes a smaller value, which is replaced
on the next tick).

## Recovery Model

Restart-from-scratch is safe:

- Data messages are persistent in the broker (subject to the queue being
  durable). Unacked messages are redelivered after a consumer restart.
- The `complete` control message uses the broker default (persistent) so it
  survives a broker restart too.
- Deterministic `_id` makes re-inserts idempotent (`E11000`).

There is one in-memory state that does **not** survive a registrar restart:
the `BucketState.counter`. A fresh process starts every bucket's counter at
`-1`. If a control message arrives before any data, the next flush would
write `-1` for that bucket, briefly regressing the Redis value below what
was stored before. The mistake is self-correcting: subsequent data messages
push the counter past the previous value, and the next flush overwrites
Redis with the higher number. Worst case is one extra clerk re-publish
of already-stored rows, which `E11000` absorbs.

## Shutdown

On shutdown: stop consuming, clear both timers (flush + progress), then drain
the pending insert batches to MongoDB before exiting. Any progress state still
in memory is discarded — the next start re-establishes it from incoming
messages.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `REGISTRAR_PREFETCH` | `500` | Per-consumer prefetch count |
| `REGISTRAR_FLUSH_INTERVAL_MS` | `50` | Insert batch flush interval |
| `REGISTRAR_PROGRESS_INTERVAL_MS` | `1000` | Redis progress flush interval |
