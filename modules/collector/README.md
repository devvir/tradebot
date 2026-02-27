# Collector Module

Collects all messages from BitMEX WebSocket and stores them in MongoDB for future replay by other modules.

## Components

- **Feed** - Connects to BitMEX WebSocket and publishes all market data to RabbitMQ
- **Writer** - Persists messages to MongoDB collections
- **RabbitMQ** - Message broker for Feed → Writer pipeline
- **MongoDB** - Persistent storage for collected raw market data

## Quick Start

Start the module:
```bash
tb up collector
```

Build images and start:
```bash
tb up collector --build
```

Stop the module:
```bash
tb down collector
```

View logs:
```bash
tb logs collector
```

Follow logs in real-time:
```bash
tb logs collector -f
```

## Configuration

See `.env` for module configuration. Key settings:

- `WRITER_DATABASE` - MongoDB database name (default: `tradebot`)
- `FEED_EXCHANGE` - RabbitMQ exchange for feed messages (default: `ex.collect`)
- `FEED_QUEUE` - RabbitMQ queue name (default: `q.collect`)

For detailed information about each service, see:
- [services/feed/README.md](../../services/feed/README.md)
- [services/writer/README.md](../../services/writer/README.md)
- [services/rabbitmq/README.md](../../services/rabbitmq/README.md)
- [services/mongodb/README.md](../../services/mongodb/README.md)
