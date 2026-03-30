# Registrar Service — Technical Reference

## Overview

```
fanout:registrar  →  registrar  →  MongoDB tradebot / <table>
```

Registrar is the write endpoint of the customs pipeline. It consumes `record`
messages from the `registrar` fanout exchange, assigns each a deterministic `_id`,
and bulk-inserts them into the `tradebot` MongoDB database.

## Consumed Exchange

Registrar consumes from the `registrar` fanout exchange (queue: `registrar`). The
customs pipe binds two sources to this exchange:

- `topic:clerk` with routing key `item` — REST and S3 table rows from clerk
- `topic:assembled` — reconstructed WS messages from assembler

Both arrive as the same message shape: a document with an `x-table` header
identifying the target collection.

## Document _id

Every document receives a deterministic 53-bit integer `_id`:

```
_id = dateOffset × 2³⁹ + msgIndex × 2¹² + reserved
```

| Field | Bits | Range | Description |
|---|---|---|---|
| `dateOffset` | 14 | 0 – 16383 | Days since 2000-01-01 UTC; valid until ~2044 |
| `msgIndex` | 27 | 0 – 134217727 | Message position within the vault file |
| `reserved` | 12 | 0 | Always 0; 1–4095 reserved for future gap-fill events |

`msgIndex` comes from the `x-msg-index` AMQP header set by clerk. For WS tables it
is the group index (one per original WS message); for REST tables it is the row index.

The maximum value equals `Number.MAX_SAFE_INTEGER`, so `_id` is always representable
as a JavaScript number.

## Batching and Flush

Documents are accumulated in memory grouped by collection name. A flush timer runs
every `REGISTRAR_FLUSH_INTERVAL_MS` (default 50 ms) and calls `insertMany` for each
pending collection.

Batches are removed from the pending map before the MongoDB write returns, so new
messages for the same collection start accumulating immediately without waiting for
the in-flight write to complete.

## Error Handling

`insertMany({ ordered: false })` is used so that a single failure does not block
other documents in the batch.

| Error | Handling |
|---|---|
| `E11000` duplicate key | ACK silently — document already in database |
| Transient error | Retry up to 3 times with a 2 s delay between attempts |
| All retries exhausted | `nack(requeue=true)` all entries in the batch |

## Shutdown

On shutdown: stop consuming, clear the flush timer, then drain all pending batches
to MongoDB before exiting.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `REGISTRAR_PREFETCH` | No | `500` | Per-consumer prefetch count |
| `REGISTRAR_FLUSH_INTERVAL_MS` | No | `50` | Batch flush interval in milliseconds |
