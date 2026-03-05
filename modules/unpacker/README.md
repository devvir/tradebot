# Unpacker Module

Reads compressed documents from MongoDB via Reader, decodes and decompresses each message via Codec, and stores the result in a new MongoDB collection.

## Services

- **Reader** — Scans MongoDB and publishes documents to `topic:reader`
- **unpack-in** (Router) — Consumes from `topic:reader`, injects `x-codec-strategy=decode` and `x-writer-database=tradebot_unpacked`, publishes to `topic:codec.in`
- **Codec** — Decodes and decompresses messages, publishes to `topic:codec.out`
- **unpack-out** (Pipe) — Wires `topic:codec.out` to `topic:writer`
- **Writer** — Persists messages to MongoDB (`tradebot_unpacked`)
- **RabbitMQ** — Message broker
- **MongoDB** — Source and destination

## Usage

```bash
tb up unpacker          # Start all services
tb up unpacker --build  # Rebuild and start
tb down unpacker        # Stop all services
tb logs unpacker        # Stream logs
tb ps unpacker          # Check service status
```

## Configuration

Copy `.env.example` to `.env` and customize.

Key setting: `READER_DATABASE` — MongoDB database to read from (e.g. `tradebot_archive`).

See each service's documentation for the full list of available environment variables:

- [Reader](../../services/reader/README.md)
- [Codec](../../services/codec/README.md)
- [Router](../../services/router/README.md)
- [Writer](../../services/writer/README.md)

For detailed technical documentation, see [docs/modules/UNPACKER.md](../../docs/modules/UNPACKER.md).
