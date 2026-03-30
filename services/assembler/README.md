# Assembler Service

Consumes `data` messages from the `assembler` fanout exchange, reconstructs
the original BitMEX WebSocket message shape, and publishes the result as a `record`
to the `assembled` topic exchange.

## What it does

- Receives row groups from clerk (one group = one original WS message)
- Strips the vault-internal `action` field from each row to reconstruct the `data` array
- Restores `keys`, `types`, and `filter` metadata for `partial` messages from a static `TABLE_SPECS` map
- Adds `filterKey` for `chat` messages (all actions)
- Publishes the reconstructed message to `topic:assembled` with routing key `record`

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `ASSEMBLER_PREFETCH` | No | `200` | Per-consumer prefetch count |

## Development

```sh
pnpm install
pnpm build
pnpm test
```

For technical details, see [docs/services/ASSEMBLER.md](../../docs/services/ASSEMBLER.md).
