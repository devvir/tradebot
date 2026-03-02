# Collector Module

The Collector module subscribes to the Broadcast service's topic exchange and stores all BitMEX market data in MongoDB via the Writer service.

## Components

- **Broadcast** — Feeds BitMEX WebSocket data into a topic exchange (default: `broadcast`)
- **Router** — Bridges the broadcast exchange to the Writer exchange, transforming routing keys (e.g. `message.trade` > `collect.trade`)
- **Writer** — Persists incoming messages to MongoDB
- **RabbitMQ** — Message broker
- **MongoDB** — Persistent storage

## Data Flow

```
BitMEX WS → Broadcast Module → topic:broadcast (key: message.trade, ...)
                                        ↓
                             Router (key transform: message.* → collect.*)
                                        ↓
                                topic:writer (key: collect.trade)
                                        ↓
                             Writer → MongoDB (<DATABASE_COLLECT>.trade)

## Quick Start

```bash
tb up collector          # Start all services
tb up collector --build  # Rebuild and start
tb down collector        # Stop all services
tb logs collector        # Stream logs
tb ps collector          # Check service status
```

## Configuration

Copy `.env.example` to `.env` and customize.

Router rules are set directly in `compose.yml`.

For detailed technical documentation, see [docs/modules/COLLECTOR.md](../../docs/modules/COLLECTOR.md).
