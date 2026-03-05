# Writer Service — Technical Reference

## Overview

Writer is a stateless consumer that reads from a RabbitMQ topic exchange and bulk-inserts documents into MongoDB. Its two responsibilities are `_id` generation (guaranteed to be unique for each bitmex message on a table basis) and batched persistence. It does not transform or enrich message content, other than removing the redundant `table` and `action` root fields; `table` is inferred from the target collection, and `action` is embedded in the `_id`.

## Topology

```
Exchange: writer (topic, durable)
  └─ Queue: writer   ← binding: #   (DLX → writer.dlx)

Exchange: writer.dlx (fanout, durable)
  └─ Queue: writer.dead-letter
```

The queue accepts all routing keys (`#`). Routing keys are not used to route to different queues or determine the database — they are preserved for downstream filtering only.

## AMQP Headers

| Header | Values | Default | Description |
|---|---|---|---|
| `x-writer-database` | any string | `tradebot` | Target MongoDB database |

The target **database** comes from the `x-writer-database` header. The target **collection** comes from the `table` field in the message body.

Headers are injected at the module level by router rules (e.g. in a module's `compose.yml`), so each pipeline can configure writer behavior independently.

## Document ID Generation

Every document gets a numeric `_id` computed from the message body and the `x-bitmex-published-at` header.

**Layout (53 bits):**

```
[ tsMs: 41 bits ][ discriminator: 10 bits ][ action: 2 bits ]
```

- **tsMs** — milliseconds since 2000-01-01T00:00:00Z, taken from `x-bitmex-published-at` (falls back to `Date.now()` if absent)
- **discriminator** — partitioned into 4 slots of 256 each. Each writer instance occupies one slot, so up to 4 instances can consume from the same queue without ID collisions. On a collision, the instance rotates to the next slot automatically. Up to 255 documents per millisecond per (table, action) pair per instance before overflowing into the next millisecond's timestamp bits
- **action** — `partial=0, insert=1, update=2, delete=3`, read from `doc.action` in the message body

Formula: `tsMs * 4096 + discriminator * 4 + ACTION_ID[action]`

The discriminator state is held in 10 rotating 1-second buckets (10s window). Every second, the bucket about to be reused is cleared. On overflow (≥ 256 per slot), the excess seeds the next millisecond's bucket to prevent future collisions there.

**Slot rotation on collision:** When a duplicate-key error is detected, the instance advances to the next slot (0→1→2→3→0…) and suspends message processing for a random delay of 1–5 seconds before resuming. The delay acts as a jitter barrier: if two instances collide simultaneously and both rotate, the randomness makes it unlikely they land on the same new slot. A `warn` log is emitted on each rotation (`Duplicate-key collision detected — rotating partition slot`), which is the intended signal for monitoring. Under normal operation this should never fire; if it fires repeatedly it indicates more than 4 writer instances are competing, or a genuine data issue worth investigating.

If a document already has `_id` set (e.g. it originated from a database restore), the existing value is used as-is and generation is skipped.

## Batch Pipeline

The handler accumulates documents in a `Map<"db|collection", Batch>`. A flush is triggered by the `WRITER_FLUSH_INTERVAL_MS` timer → flush all pending batches.

Flushed batches are handed off asynchronously to `persistBatch` and removed from the pending map immediately, so new messages for the same collection start a fresh batch without waiting for the MongoDB write to complete.

## Error Handling

### Happy path

`insertMany({ ordered: false })` succeeds → ACK all messages in the batch.

### Partial failure (`MongoBulkWriteError`)

MongoDB reports exactly which documents failed via `writeErrors` (each carrying the original document index and error code):

- Succeeded documents → ACK
- `writeErrors` with code 11000 (duplicate key) → ACK silently, rotate partition slot
- `writeErrors` with other codes → individual settlement (see below)

### Total failure

When `insertMany` throws a non-bulk error (nothing was inserted), the batch falls back to one-by-one `insertOne` for isolation:

- Success → ACK
- Duplicate key (11000) → ACK silently, rotate partition slot
- Other error → individual settlement (see below)

### Individual settlement (poison pill protection)

For any single message that fails outside of duplicate-key:

1. `redelivered = false` → NACK with requeue (one more attempt)
2. `redelivered = true` → NACK without requeue → dead-lettered to `writer.dead-letter`

This caps each bad message at two delivery attempts before it is quarantined.

## Health Monitoring

```bash
curl http://writer:3000/health
```

- **200** — MongoDB connected, RabbitMQ connected, a message was processed within the last 60 seconds
- **503** — any of the above conditions is not met

Response body includes `messagesProcessed` (cumulative ACK count) and `lastProcessedTime` (ms since last ACK).
