# Collector Module

## Overview

The Collector module subscribes to the Broadcast service's topic exchange and stores all BitMEX market data in MongoDB via the Writer service.

## Pipeline

```
Broadcast → topic:broadcast → Router → topic:codec.in → Codec → topic:codec.out → Router → topic:writer → Writer → MongoDB
```

1. **Broadcast** subscribes to BitMEX WebSocket channels and publishes all messages into a `topic:broadcast` exchange, with routing key `message.<table>` (e.g., `message.trade`).

2. **Router** (collect-in) transforms the routing key prefix from `message` to `passthru` and republishes to `codec.in`.

3. **Codec** applies the `passthru` strategy: adds a unique, deduplicating `_id` field to each message without transforming the payload.

4. **Router** (collect-out) transforms the routing key prefix from `passthru` to `collect` and republishes to the `writer` topic exchange.

5. **Writer** consumes from its `writer.collect` queue (bound with key `collect.*`) and writes each message to MongoDB. The `_id` field enables idempotent inserts: duplicate `_id` values are silently skipped (duplicate key error).

## Message Routing

Destination is determined by the AMQP routing key on the `writer` exchange:

| Routing key | Queue | Database | Collection |
|---|---|---|---|
| `collect.<table>` | `writer.collect` | `DATABASE_COLLECT` | `<table>` |

For example, a BitMEX `trade` message arrives at the broadcast fanout with key `message.trade`. The collector-router transforms it to `collect.trade`. Writer routes it to `<DATABASE_COLLECT>.trade`.

## Usage

```bash
tb up collector          # Start all services
tb up collector --build  # Rebuild and start
tb down collector        # Stop all services
tb logs collector        # Stream logs
tb ps collector          # Check service status
```

## Configuration

Copy `.env.example` to `.env` and customize. Router rules are set directly in `compose.yml`. See each service's documentation for the full list of available environment variables:

- [Broadcast](../../services/broadcast/README.md)
- [Router](../../services/router/README.md)
- [Writer](../../services/writer/README.md)

## Resilience

- **Broadcast** (in Broadcast) reconnects automatically with exponential backoff on WebSocket failure
- **Router** durably buffers via the `collect` queue; requeues on failure for automatic retry
- **Writer** silently handles duplicate key errors (idempotent inserts) and NACKs other failures for retry
- **RabbitMQ** durably buffers messages between pipeline stages; acknowledged only after successful persistence
- **Graceful shutdown** allows in-flight messages to complete before exit
