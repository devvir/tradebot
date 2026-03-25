# Unpacker Module — Technical Reference

## Overview

The Unpacker module reads compressed documents from MongoDB via Reader, decodes and decompresses each message via Codec, and writes the raw result to a new MongoDB collection. It is the inverse of the Archivist pipeline.

## Pipeline

```
Reader → topic:reader → unpack-in (Router) → topic:codec.in → Codec → topic:codec.out → unpack-out (Pipe) → topic:writer → Writer → MongoDB tradebot_unpacked
```

1. **Reader** scans the source MongoDB database, reconstructs the broadcast-compatible message envelope (`{ table, action, data: [doc] }`), and publishes to `topic:reader` with routing key `table.action.symbol`. The action and published timestamp are decoded from the document's `_id` field.

2. **unpack-in** (Router) consumes all messages from `topic:reader`, injects `x-codec-strategy=decode` and `x-writer-database=tradebot_unpacked` headers, and republishes to `topic:codec.in`.

3. **Codec** consumes from `topic:codec.in`, applies the `decode` strategy (Brotli decompress + decode), and republishes to `topic:codec.out`. All headers are passed through unchanged.

4. **unpack-out** (Pipe) wires `topic:codec.out` directly to `topic:writer` — a native E2E binding with no transformation.

5. **Writer** consumes from `topic:writer`, uses the `_id` already present in each document (no new `_id` generation needed), and inserts into MongoDB. Duplicate key errors are silently ACKed.

## AMQP Headers

| Header | Value | Set by | Effect |
|--------|-------|--------|--------|
| `x-codec-strategy` | `decode` | unpack-in (Router) | Instructs Codec to decompress and decode |
| `x-writer-database` | `tradebot_unpacked` | unpack-in (Router) | Selects the MongoDB database |
| `x-bitmex-published-at` | ISO timestamp | Reader | Reconstructed from `_id`; passed through |

## Error Handling

- **Reader** exits after scanning all documents; restart to re-scan.
- **unpack-in** (Router) durably buffers messages in RabbitMQ; NACKs with requeue on processing failure.
- **Codec** NACKs with requeue on processing failure.
- **Writer** silently ACKs duplicate key errors; NACKs other failures for retry.
- **RabbitMQ** durably buffers messages between pipeline stages; acknowledged only after successful persistence.
- **Graceful shutdown** allows in-flight messages to complete before exit.
