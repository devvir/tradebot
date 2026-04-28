# Clerk Service

Scans vault for closed files across all BitMEX tables and publishes their rows to
RabbitMQ for downstream processing. Tracks progress in Redis so each file is
processed exactly once.

## What it does

- Discovers closed vault files via `GET /files/:table` and skips already-processed ones
- WS files: publishes one `data` message per WS message group to `topic:clerk`
- REST files: publishes one `item` message per row to `topic:clerk`
- Applies backpressure when downstream queues exceed capacity
- Repeats on a configurable poll interval

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `CLERK_TABLES` | No | _(all)_ | Comma-separated table names to process. Empty means process all. |
| `CLERK_BACKPRESSURE_LIMIT` | No | `100000` | Max messages in watched queues before pausing |
| `CLERK_WATCH_QUEUES` | No | `assembler,registrar` | Comma-separated queue names to watch |

## Development

```sh
pnpm install
pnpm build
pnpm test
```

For technical details, see [docs/services/CLERK.md](../../docs/services/CLERK.md).
