# Journalist Service — Technical Documentation

## Overview

Consumes BitMEX WebSocket messages from RabbitMQ and flushes them to vault (where they're saved as date-partitioned CSV files). Journalist is the real-time counterpart to scribe (REST) and courier (S3 dumps).

```
broadcast → exchange:broadcast
                ↓  (pipe: topic:broadcast > topic:journalist)
         exchange:journalist → queue:journalist → journalist → vault
```

---

## Row Augmentation

Each BitMEX WebSocket message contains a `data` array of 0–N items. Before writing to vault, journalist adds the action field to every row (`partial`, `insert`, `update`, or `delete`).

Three tables carry no datetime field in the BitMEX spec: `connected`, `liquidation`, and `publicNotifications`. For these **timeless tables**, journalist injects a synthetic `ts` field (the current `streamTime`) into every row before buffering. Corresponding vault headers for these tables include `ts` at the end.

---

## Buffering and Flushing

Messages are not written to vault on arrival. Each table has its own in-memory buffer — a list of per-message entry arrays. A buffer is flushed when any of the following occurs:

- The **buffer holds 1,000 message batches** (size threshold).
- **1 second elapses** since the first buffered message (timer, reset on any earlier flush).
- A **day boundary** is detected (see below) — all tables are flushed synchronously before the async vault writes begin.
- `flushAll()` is called on shutdown.

All entries from a single WebSocket message always land in the same vault write — they are never split across files or days.

### How each message is handled on arrival

Messages are processed in arrival order. For each message:

**Timeless tables** (`connected`, `liquidation`, `publicNotifications`):
- If `streamTime` is not yet set: **drop silently**. There is no clock to stamp the entries with.
- Otherwise: inject `ts = streamTime` into every entry, then buffer.

**Partial messages from timed tables**:
- Buffer as-is. Partials do not advance `streamTime`.

**Non-partial messages from timed tables with no timestamp or date field**:
- Buffer as-is. `streamTime` is not changed.

**Non-partial messages from timed tables with a timestamp**:
- The **maximum timestamp** across all entries is used (`timestamp` field, falling back to `date`).
- If the message's day is **earlier** than `streamTime`'s day: **drop with a warning** (past-day message).
- If the message's day is **later** than `streamTime`'s day: trigger a **day boundary** (see below), then advance `streamTime`.
- If the message's timestamp is simply later within the same day: advance `streamTime`.
- Buffer the message.

---

## Day Boundary

When a non-partial message from a timed table arrives on a day later than the current `streamTime` day:

1. `closeDayBucket` is called with the **current** (old) day — before `streamTime` is updated.
2. Inside `closeDayBucket`:
  - a. All in-memory flush timers are cancelled synchronously.
  - b. All table buffers are drained synchronously (spliced to a local snapshot).
  - c. Each table's snapshot is written to vault under the **old day**.
  - d. Each table's vault file for the old day is closed.
3. `streamTime` is advanced to the new message's timestamp.
4. The triggering message is buffered normally.

The synchronous drain in step 2b ensures the new message (which belongs to the new day) is never mixed into the old day's vault write.

`streamTime` is driven entirely by timestamps in the stream — wall-clock time is never used. Both live feeds and replayed historical streams work identically.

---

## Startup

Journalist starts with `streamTime = null`. The first non-partial message from a timed table with a recognisable timestamp sets `streamTime`. Everything before that point is buffered (timed tables) or dropped (timeless tables).

On vault errors, journalist pauses and retries in a loop until the write succeeds. Back-pressure propagates: `receive()` blocks until vault recovers, so the RabbitMQ consumer stalls rather than losing messages.

---

## Output Format (Vault)

Rows are written via `POST /files/:table/:date/rows`. The body is an **array of message batches** — each inner array contains the entries from one WebSocket message:

```json
[
  [{ "action": "insert", "timestamp": "…", … }, …],
  [{ "action": "update", "timestamp": "…", … }]
]
```

The table name comes from the BitMEX message, with a **pool pseudo-table** suffix applied from the `x-bitmex-pool` header (`route.ts`): no pool, an empty header, or `Primary` keeps the base table (`orderBookL2`); any other pool becomes `<table>.<pool lowercased>` (`orderBookL2.secondary`). The pseudo-table is then just another table — its own buffer, write chain, day tracking, and vault directory follow from there. Journalist is agnostic about which tables may carry a pool; it honours the header value blindly (whether it makes sense is upstream's concern), and vault resolves the pseudo-table to its base for column lookup. The date (`YYYYMMDD`) is per the message's day at flush time.

---

## RabbitMQ Topology

Journalist owns and declares its own exchange and queue on startup:

| Resource              | Type  | Details                                |
|-----------------------|-------|----------------------------------------|
| exchange `journalist` | topic | Durable                                |
| queue `journalist`    | —     | Bound to exchange with routing key `#` |

The `broadcast` → `journalist` exchange binding is created by the `pipe` service in the journal module. Journalist has no knowledge of broadcast.

Prefetch is set to 100. On vault errors, `buffer.push()` blocks via an internal gate until vault recovers before returning — the message is acked only after the rows have been successfully handed to the buffer. This means the consumer stalls (holding up to `prefetch` messages) while vault is down, rather than nacking and requeueing.
