# Writer Service

Dumb HTTP-to-MongoDB sidecar. Accepts JSON arrays of documents on a single
endpoint and bulk-inserts them. Exists so CPU-heavy producers (farmer, future
consumers) can offload the BSON-encoding and mongo round-trips to a dedicated
Node event loop — recovering the ~3-4x throughput that a one-process pipeline
loses to event-loop contention.

The writer holds no business logic, no doc-shape knowledge, no batch-sizing
intelligence: callers send batches small enough to fit one `insertMany`, and
the writer ships them through.

## What it does

- Listens on `POST /write/:table` for a JSON-array body
- Calls `db.<collection>.insertMany(docs, { ordered: false })`
- Returns `{ inserted: <count> }` on success
- Optionally treats `E11000` as success for idempotent re-runs (`200` with `duplicates: true`); otherwise reports the conflict as `409`
- Rejects oversized bodies (`413`), malformed bodies (`400`), surfaces non-duplicate mongo errors (`500`)
- Logs insert rate every 5 seconds
- `GET /health` for liveness probes

## Reusability

Nothing about the writer is tied to farmer. Any module that needs HTTP-driven
mongo writes can run its own writer instance — give it a different
`DB_DATABASE`, point producers at it, done. Two compose includes can run two
writers writing to different databases on the same mongo cluster.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `DB_URL` | Yes | — | MongoDB connection string |
| `DB_DATABASE` | Yes | — | Target database |
| `WRITER_IGNORE_DUPLICATES` | No | `true` | When `true`, `E11000` is reported as `200 { duplicates: true }`. When `false`, falls through to `500`. |

## Development

```sh
pnpm install
pnpm build
pnpm test
```

For technical details, see [docs/services/WRITER.md](../../docs/services/WRITER.md).
