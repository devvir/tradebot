# ws

Serves a BitMEX-compatible WebSocket API. Clients authenticate and subscribe to streams as they would with BitMEX, with no knowledge of whether data is live or replayed.

## What it does

- Exposes BitMEX WebSocket protocol (subscribe/unsubscribe, partial/insert/update/delete, heartbeat)
- Accumulates table state in-memory from the delta stream (via `@devvir/bitmex-database`)
- On client subscribe: serves the current snapshot, buffers deltas, streams once ordering is guaranteed
- Forwards subsequent deltas to connected clients
- Supports both public (no auth) and private (API key auth) streams
- Uses message counter (`x-message-count` header) for strict ordering guarantees

## Message Ordering

WebSocket clients receive messages in strict logical order using per-instance message counters:
- **Counter >= 1**: Normal operation; messages ordered by incremental counter
- **Counter === 0**: Fresh snapshot; any subsequent delta passes the filter

On subscribe, the service reads the current snapshot and counter from its in-memory store (populated by the same delta stream), then streams only deltas with higher counters. This ensures correct temporal ordering even with out-of-order delivery from RabbitMQ.

## Configuration

Requires RabbitMQ — see [infra packs](../../modules/infra/README.md).

| Variable | Required | Default | Description |
|---|---|---|---|
| `WS_PORT` | no | `` | WebSocket server port mapping on host |
| `BROADCAST_URL` | yes | `` | Broadcast commands HTTP server |

## Development

```bash
pnpm install   # Install dependencies
pnpm build     # Compile TypeScript
pnpm test      # Run tests
```

For technical details on message ordering, buffering, and integration with other services, see [docs/services/WS.md](../../docs/services/WS.md).
