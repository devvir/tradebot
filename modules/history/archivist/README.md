# Archivist Module

Subscribes to BitMEX WebSocket data via Broadcast, encodes and compresses each message via Codec, and stores the result in MongoDB.

## Services

- **Broadcast** — Connects to BitMEX WebSocket and publishes messages to `topic:broadcast`
- **archive-in** (Router) — Consumes from `topic:broadcast`, injects `x-codec-strategy=encode` and `x-writer-database=tradebot_archive`, publishes to `topic:codec.in`
- **Codec** — Encodes and compresses messages, publishes to `topic:codec.out`
- **archive-out** (Pipe) — Wires `topic:codec.out` to `topic:writer`
- **Writer** — Persists messages to MongoDB (`tradebot_archive`)
- **RabbitMQ** — Message broker
- **MongoDB** — Persistent storage

## Usage

```bash
tb up archivist          # Start all services
tb up archivist --build  # Rebuild and start
tb down archivist        # Stop all services
tb logs archivist        # Stream logs
tb ps archivist          # Check service status
```

## Configuration

Copy `.env.example` to `.env` and customize.

See each service's documentation for the full list of available environment variables:

- [Broadcast](../../../services/broadcast/README.md)
- [Codec](../../../services/codec/README.md)
- [Router](../../../services/router/README.md)
- [Writer](../../../services/writer/README.md)

For detailed technical documentation, see [docs/modules/ARCHIVIST.md](../../docs/modules/ARCHIVIST.md).
