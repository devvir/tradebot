# Registrar Service

Consumes `record` messages from the `registrar` fanout exchange, assigns each a
deterministic 53-bit `_id`, and bulk-inserts documents into the `tradebot` MongoDB
database.

## What it does

- Receives records from both clerk (REST/S3 tables via routing key `item`) and assembler (WS tables)
- Assigns `_id = dateOffset × 2³⁹ + msgIndex × 2¹² + reserved`
- Batches by collection name and flushes on a timer
- Silently acks duplicate keys; retries transient errors up to 3 times

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `REGISTRAR_PREFETCH` | No | `500` | Per-consumer prefetch count |
| `REGISTRAR_FLUSH_INTERVAL_MS` | No | `50` | Batch flush interval in milliseconds |

## Development

```sh
pnpm install
pnpm build
pnpm test
```

For technical details, see [docs/services/REGISTRAR.md](../../docs/services/REGISTRAR.md).
