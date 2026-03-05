# Archivist Module — Technical Reference

## Overview

The Archivist module subscribes to BitMEX WebSocket data via Broadcast, encodes and compresses each message via Codec, and stores the result in MongoDB. Encoding compacts the JSON representation (~10–20% reduction); Brotli compression reduces it further (~40–70%).

## Pipeline

```
Broadcast → topic:broadcast → archive-in (Router) → topic:codec.in → Codec → topic:codec.out → archive-out (Pipe) → topic:writer → Writer → MongoDB tradebot_archive
```

1. **Broadcast** connects to the BitMEX WebSocket and publishes each incoming message to `topic:broadcast` with routing key `table.action.symbol` (e.g. `trade.insert.XBTUSD`).

2. **archive-in** (Router) consumes all messages from `topic:broadcast`, injects `x-codec-strategy=encode` and `x-writer-database=tradebot_archive` headers, and republishes to `topic:codec.in`.

3. **Codec** consumes from `topic:codec.in`, applies the `encode` strategy (encode + Brotli compress), and republishes to `topic:codec.out`. All headers are passed through unchanged.

4. **archive-out** (Pipe) wires `topic:codec.out` directly to `topic:writer` — a native E2E binding with no transformation.

5. **Writer** consumes from `topic:writer`, derives a unique `_id` from message headers, and inserts the compressed document into MongoDB. Duplicate key errors are silently ACKed (the partition slot rotates automatically to prevent future collisions).

## AMQP Headers

| Header | Value | Set by | Effect |
|--------|-------|--------|--------|
| `x-codec-strategy` | `encode` | archive-in (Router) | Instructs Codec to encode and compress |
| `x-writer-database` | `tradebot_archive` | archive-in (Router) | Selects the MongoDB database |

## Error Handling

- **Broadcast** reconnects automatically with exponential backoff on WebSocket failure.
- **archive-in** (Router) durably buffers messages in RabbitMQ; NACKs with requeue on processing failure.
- **Codec** NACKs with requeue on processing failure.
- **Writer** silently ACKs duplicate key errors and rotates the partition slot to prevent future collisions; NACKs other failures for retry.
- **RabbitMQ** durably buffers messages between pipeline stages; acknowledged only after successful persistence.
- **Graceful shutdown** allows in-flight messages to complete before exit.
