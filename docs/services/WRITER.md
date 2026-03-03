# Writer Service — Technical Documentation

## Overview

The Writer service consumes messages from a RabbitMQ topic exchange and persists them to MongoDB. It owns the `writer` exchange and three queues, routing each message to the correct database and collection based on the routing key. Message content is stored as-is.

## Architecture

### Topology

```
Exchange: writer.dlx (fanout, durable)
  └─ Queue: writer.dead-letter

Exchange: writer (topic, durable)
  ├─ Queue: writer.archive   ← binding: archive.*   (DLX → writer.dlx)
  ├─ Queue: writer.collect   ← binding: collect.*   (DLX → writer.dlx)
  └─ Queue: writer.custom    ← binding: custom.*.*  (DLX → writer.dlx)
```

All queues are durable and declared at startup. Nacked-without-requeue and expired messages are routed to the `writer.dead-letter` queue via the `writer.dlx` fanout exchange.

### Message Flow

```
Publisher → writer exchange (routing key)
    ↓
Queue (matched by binding pattern)
    ↓
Consumer (prefetch = WRITER_PREFETCH)
    ├─ resolveTarget(routingKey, config)
    │     ├─ archive.<col>       → { db: config.dbArchive, col }
    │     ├─ collect.<col>       → { db: config.dbCollect, col }
    │     ├─ custom.<db>.<col>   → { db, col }
    │     └─ unresolvable        → NACK (no requeue)
    ├─ Parse content (JSON)
    └─ Accumulate in per-collection batch
         ├─ Batch full (WRITER_BATCH_SIZE) → insertMany immediately
         └─ Timer fires (WRITER_FLUSH_INTERVAL_MS) → insertMany partial batch
              ├─ Success                     → ACK all messages in batch
              ├─ Partial failure (BulkWrite) → ACK succeeded, settle failed individually
              └─ Total failure               → fallback to insertOne per message
                   ├─ insertOne success     → ACK
                   ├─ Duplicate key (11000) → ACK (idempotent)
                   └─ Other failure
                        ├─ First attempt    → NACK (requeue)
                        └─ Redelivered      → NACK (dead-letter)
```

### Routing Key Resolution

The `resolveTarget()` function maps a routing key to a database and collection:

| Pattern | Database | Collection | Example |
|---|---|---|---|
| `archive.<collection>` | `DATABASE_ARCHIVE` | `<collection>` | `archive.orderBookL2` → `tradebot_archive.orderBookL2` |
| `collect.<collection>` | `DATABASE_COLLECT` | `<collection>` | `collect.trade` → `tradebot_collect.trade` |
| `custom.<db>.<col>` | `<db>` | `<col>` | `custom.mydb.mycol` → `mydb.mycol` |

Routing keys that don't match any pattern are nacked without requeue and routed to `writer.dead-letter` via the DLX.

### Document Creation

Writer does not modify, merge, or enrich the document — it stores exactly what it receives.

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MONGODB_URL` | Yes | — | MongoDB connection string |
| `RABBITMQ_URL` | Yes | — | RabbitMQ connection string |
| `WRITER_PREFETCH` | No | `1000` | RabbitMQ prefetch window (max unacked messages per consumer) |
| `WRITER_BATCH_SIZE` | No | `100` | Max documents accumulated per collection before flushing to MongoDB |
| `WRITER_FLUSH_INTERVAL_MS` | No | `50` | Max milliseconds to hold a partial batch before flushing |
| `DATABASE_ARCHIVE` | No | `tradebot_archive` | Database for `archive.*` messages |
| `DATABASE_COLLECT` | No | `tradebot_collect` | Database for `collect.*` messages |

### Topology Declaration

At startup, the service declares:

1. **Exchange** `writer.dlx` — type `fanout`, durable
2. **Queue** `writer.dead-letter` — durable, bound to `writer.dlx`
3. **Exchange** `writer` — type `topic`, durable
4. **Queue** `writer.archive` — durable, bound to `archive.*`, DLX → `writer.dlx`
5. **Queue** `writer.collect` — durable, bound to `collect.*`, DLX → `writer.dlx`
6. **Queue** `writer.custom` — durable, bound to `custom.*.*`, DLX → `writer.dlx`

All three consumer queues share the same consumer logic; only the routing key resolution differs. Dead-lettered messages from any queue end up in `writer.dead-letter`.

## Dependencies

### MongoDB

- **Connection:** Standard MongoDB driver with exponential backoff retry (10 attempts, 5s delay)
- **Operations:** `insertMany()` per batch (up to `WRITER_BATCH_SIZE` documents, flushed every `WRITER_FLUSH_INTERVAL_MS` ms)
- **Indexes:** The service assumes target collections have a unique index on `_id` (caller's responsibility)
- **Collections:** Created on-demand during first insert, no schema enforcement

### RabbitMQ

- **Broker wrapper:** `@devvir/rabbitmq` (`keepAlive` + `Broker.declares()`)
- **Consumption:** Manual ACK/NACK on each queue
- **Backpressure:** Prefetch window shared across all three consumer callbacks

## Error Handling

### Duplicate Key Errors (MongoDB code 11000)

1. Error is suppressed (no log)
2. Message is acknowledged (removed from queue)

Duplicate key errors indicate the document already exists. This is expected when messages are reprocessed and should not block the pipeline.

### Partial Batch Failure (MongoBulkWriteError)

When `insertMany({ordered: false})` partially fails, MongoDB reports which documents failed via `writeErrors` (each with an index into the original batch):

1. Documents **not** in `writeErrors` were inserted successfully → ACK
2. `writeErrors` with code 11000 (duplicate) → ACK
3. `writeErrors` with other codes → settled individually (see Poison Pill Protection)

### Total Failure (network, auth, unexpected)

When `insertMany` fails with a non-bulk error (nothing was inserted), the writer falls back to one-by-one `insertOne` to isolate the culprit:

1. `insertOne` succeeds → ACK
2. `insertOne` fails with duplicate key → ACK
3. `insertOne` fails with other error → settled individually (see Poison Pill Protection)

### Poison Pill Protection

To prevent infinite requeue loops from a single bad message:

1. **First attempt** (`msg.fields.redelivered = false`) — message is nacked with requeue, giving it one more chance
2. **Redelivered** (`msg.fields.redelivered = true`) — message has already failed before and is nacked **without** requeue, routing it to `writer.dead-letter` via the DLX

This guarantees at most two delivery attempts per message before dead-lettering.

### Unresolvable Routing Keys

1. Error is logged with the routing key
2. Message is nacked without requeue (`nack(msg, false, false)`)

These messages are routed to the `writer.dead-letter` queue via the DLX for inspection or replay.

### Malformed JSON

1. Error is logged with the routing key
2. Message is nacked without requeue (dead-lettered)

Unparseable payloads cannot be retried and are sent directly to the dead-letter queue.

## Health Monitoring

### Endpoint

```
GET /health
```

**Healthy (200):**
- MongoDB connected
- RabbitMQ broker connected
- Messages processed within last 60 seconds

**Unhealthy (503):**
- MongoDB disconnected, or
- RabbitMQ disconnected, or
- No message activity for 60+ seconds

### Metrics

- `messagesProcessed` — cumulative count of messages acknowledged (successful + duplicates)
- `lastProcessedTime` — milliseconds elapsed since last ACK

## Lifecycle

### Startup

1. Load and validate configuration
2. Connect to MongoDB (exponential backoff: 10 retries, 5s delay)
3. Connect to RabbitMQ broker (`keepAlive`)
4. Declare topology (exchange + queues + bindings)
5. Get channel, set prefetch, start consuming all three queues

### Shutdown

1. Disconnect RabbitMQ broker (stops consuming)
2. Allow in-flight messages to complete
3. Close MongoDB client
