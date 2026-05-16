# Registrar Service

Consumes data and control messages from the `registrar` fanout queue, assigns
each data document a deterministic 53-bit `_id`, bulk-inserts them into the
`tradebot` MongoDB database, and tracks per-bucket progress in Redis so the
rest of the customs pipeline knows what has been safely stored.

## What it does

- Receives data messages (routing keys `message` and `record`) from clerk/assembler
- Assigns `_id = dateOffset × 2³⁹ + msgIndex × 2¹² + reserved`
- Batches by collection name and flushes on a timer
- Silently acks duplicate keys; retries transient errors up to 3 times
- Receives `complete` control messages from clerk and finalizes each bucket
- Owns `customs:<table>:<date>` in Redis — writes the highest stored
  `msgIndex` periodically, or `'done'` once the bucket reaches its goal

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `REGISTRAR_PREFETCH` | No | `500` | Per-consumer prefetch count |
| `REGISTRAR_FLUSH_INTERVAL_MS` | No | `50` | Insert batch flush interval |
| `REGISTRAR_PROGRESS_INTERVAL_MS` | No | `1000` | Redis progress flush interval |

## Development

```sh
pnpm install
pnpm build
pnpm test
```

For technical details, see [docs/services/REGISTRAR.md](../../docs/services/REGISTRAR.md).
