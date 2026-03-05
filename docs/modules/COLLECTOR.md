# Collector Module — Technical Reference

## Overview

The Collector module subscribes to BitMEX WebSocket data via Broadcast and stores every incoming message in MongoDB. There is no transformation — messages are stored as-is with a deduplicating `_id` added by Writer.

## Pipeline

```
Broadcast → topic:broadcast → collect (Router) → topic:writer → Writer → MongoDB tradebot_collect
```

1. **Broadcast** connects to the BitMEX WebSocket and publishes each incoming message to `topic:broadcast` with routing key `table.action.symbol` (e.g. `trade.insert.XBTUSD`).

2. **collect** (Router) consumes all messages from `topic:broadcast`, injects the `x-writer-database=tradebot_collect` header, and republishes to `topic:writer`.

3. **Writer** consumes from `topic:writer`, derives a unique `_id` from message headers (timestamp + discriminator + action bits), and inserts the document into MongoDB. Duplicate key errors are silently ACKed (the partition slot rotates automatically to prevent future collisions).

## AMQP Headers

| Header | Value | Set by | Effect |
|--------|-------|--------|--------|
| `x-writer-database` | `tradebot_collect` | collect (Router) | Selects the MongoDB database |

## Error Handling

- **Broadcast** reconnects automatically with exponential backoff on WebSocket failure.
- **collect** (Router) durably buffers messages in RabbitMQ; NACKs with requeue on processing failure.
- **Writer** silently ACKs duplicate key errors and rotates the partition slot to prevent future collisions; NACKs other failures for retry.
- **RabbitMQ** durably buffers messages between pipeline stages; acknowledged only after successful persistence.
- **Graceful shutdown** allows in-flight messages to complete before exit.
