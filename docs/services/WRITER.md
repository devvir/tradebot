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
Consumer (prefetch = batchSize)
    ├─ resolveTarget(routingKey, config)
    │     ├─ archive.<col>       → { db: config.dbArchive, col }
    │     ├─ collect.<col>       → { db: config.dbCollect, col }
    │     ├─ custom.<db>.<col>   → { db, col }
    │     └─ unresolvable        → NACK (no requeue)
    ├─ Parse content (JSON or binary)
    └─ insertOne(document) → MongoDB[database][collection]
         ├─ Success              → ACK
         ├─ Duplicate key (11000)→ ACK (idempotent)
         └─ Other error          → NACK (requeue)
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
| `WRITER_PREFETCH` | No | `1000` | RabbitMQ prefetch (messages buffered per consumer) |
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
- **Operations:** Single `insertOne()` per message
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

### Unresolvable Routing Keys

1. Error is logged with the routing key
2. Message is nacked without requeue (`nack(msg, false, false)`)

These messages are routed to the `writer.dead-letter` queue via the DLX for inspection or replay.

### Other Errors

1. Error is logged with context
2. Message is nacked with requeue (`nack(msg, false, true)`)

Covers network timeouts, MongoDB connection drops, validation failures, etc.

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
