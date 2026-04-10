# Snapshots Service

Consumes BitMEX-format delta messages from RabbitMQ and maintains in-memory per-table snapshots. Serves current state via HTTP GET `/snapshot/{table}`.

## What it does

- Consumes deltas from the `snapshots` RabbitMQ queue (default exchange)
- Aggregates delta actions into per-table snapshots
- Tracks `x-message-count` header for message ordering guarantees
- Exposes snapshots via HTTP for clients to fetch on demand
- Includes counter metadata with each snapshot for downstream ordering

## Development

```bash
pnpm install   # Install dependencies
pnpm build     # Compile TypeScript
pnpm test      # Run tests
```

## Configuration

Requires RabbitMQ — see [infra packs](../../modules/infra/README.md).

### Environment Variables

| Variable                | Required | Default | Description                  |
| ----------------------- | -------- | ------- | ---------------------------- |
| `SNAPSHOTS_PORT`   | no       | <empty> | HTTP server host port        |

See [docs/services/SNAPSHOTS.md](../../docs/services/SNAPSHOTS.md) for technical details.
