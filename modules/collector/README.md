# Collector Module

The Collector module subscribes to the Broadcast service's topic exchange and stores all BitMEX market data in MongoDB via the Writer service.

## Components

- **Broadcast** — Feeds BitMEX WebSocket data into a topic exchange (default: `broadcast`)
- **Codec** — Adds a unique, deduplicating numeric `_id` field using the `passthru` strategy (no payload transformation)
- **Writer** — Persists incoming messages to MongoDB with idempotent inserts (duplicates by `_id` are skipped)
- **RabbitMQ** — Message broker
- **MongoDB** — Persistent storage

## Data Flow

```
BitMEX WS → Broadcast Module → topic:broadcast (key: message.trade, ...)
                                        ↓
                   Router collect-in (key: message.* → passthru.*)
                                        ↓
                            topic:codec.in → Codec (add _id)
                                        ↓
                   Router collect-out (key: passthru.* → collect.*)
                                        ↓
                                topic:writer (key: collect.trade)
                                        ↓
             Writer → MongoDB (<DATABASE_COLLECT>.trade, _id deduped)
```

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
