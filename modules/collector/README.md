# Collector Module

Subscribes to BitMEX WebSocket data via Broadcast and stores all market data messages in MongoDB.

## Services

- **Broadcast** — Connects to BitMEX WebSocket and publishes messages to `topic:broadcast`
- **collect** (Router) — Consumes from `topic:broadcast`, injects `x-writer-database=tradebot_collect`, publishes to `topic:writer`
- **Writer** — Persists messages to MongoDB (`tradebot_collect`)
- **RabbitMQ** — Message broker
- **MongoDB** — Persistent storage

## Usage

```bash
tb up collector          # Start all services
tb up collector --build  # Rebuild and start
tb down collector        # Stop all services
tb logs collector        # Stream logs
tb ps collector          # Check service status
```

## Configuration

Copy `.env.example` to `.env` and customize.

See each service's documentation for the full list of available environment variables:

- [Broadcast](../../services/broadcast/README.md)
- [Router](../../services/router/README.md)
- [Writer](../../services/writer/README.md)

For detailed technical documentation, see [docs/modules/COLLECTOR.md](../../docs/modules/COLLECTOR.md).
