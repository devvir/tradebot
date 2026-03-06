# Packer Module

Reads raw documents from MongoDB via Reader, encodes and compresses each message via Codec, and stores the result in a new MongoDB collection.

## Services

- **Reader** — Scans MongoDB and publishes documents to `topic:reader`
- **pack-in** (Router) — Consumes from `topic:reader`, injects `x-codec-strategy=encode` and `x-writer-database=tradebot_packed`, publishes to `topic:codec.in`
- **Codec** — Encodes and compresses messages, publishes to `topic:codec.out`
- **pack-out** (Pipe) — Wires `topic:codec.out` to `topic:writer`
- **Writer** — Persists messages to MongoDB (`tradebot_packed`)
- **RabbitMQ** — Message broker
- **MongoDB** — Source and destination

## Usage

```bash
tb up packer          # Start all services
tb up packer --build  # Rebuild and start
tb down packer        # Stop all services
tb logs packer        # Stream logs
tb ps packer          # Check service status
```

## Configuration

Copy `.env.example` to `.env` and customize.

Key setting: `READER_DATABASE` — MongoDB database to read from (e.g. `tradebot_collect`).

See each service's documentation for the full list of available environment variables:

- [Reader](../../../services/reader/README.md)
- [Codec](../../../services/codec/README.md)
- [Router](../../../services/router/README.md)
- [Writer](../../../services/writer/README.md)

For detailed technical documentation, see [docs/modules/PACKER.md](../../docs/modules/PACKER.md).
