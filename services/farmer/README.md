# Farmer Service

Reads closed vault files (gzipped CSV per table+date), reconstructs the
original BitMEX WebSocket envelopes for WS-origin tables, assigns deterministic
`_id`s, and bulk-inserts the cleaned documents into MongoDB via a dedicated
write-only sidecar — a [Librarian](../librarian/README.md) instance configured
as farmer's writer (referenced throughout this doc simply as "the writer").
Progress is checkpointed in Redis so a restart resumes mid-file.

A single in-process pipeline (read → infer → assemble → dispatch → flush) does
the whole job; Mongo writes are offloaded over HTTP to the writer so farmer's
event loop can run the reader at its native rate.

## What it does

- Discovers closed vault buckets via `GET /tables` + `GET /files/:table`
- Reads `customs:<table>:<date>` from Redis to find resume points
- Streams each bucket's NDJSON over HTTP (with `?skip=N` for resumes)
- Routes by table type: REST records pass through; WS messages are
  reconstructed (timestamp normalization, partial decoration, legacy backfills)
- Assigns `_id = makeId(date, index)` — deterministic, idempotent on retry
- Batches docs per-table by **byte size** (each POST capped at 20 MiB, since a
  single WS partial can carry tens of thousands of rows and run to MBs) and
  POSTs each batch to the writer, round-robined fairly across tables so a fat
  table can't starve the others
- Captures parse/reconstruct failures into `farmer.<table>` (direct mongo
  write — error volume is too low to justify the HTTP hop)
- Shuts down loudly when it sees an unknown table (config drift)
- Retries writer failures forever with exponential backoff (1s → 30s cap)

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `VAULT_URL` | Yes | — | Base URL of vault |
| `LIBRARIAN_URL` | Yes | — | Base URL of the librarian sidecar that handles farmer's mongo writes |
| `DB_DATABASE` | Yes | — | Target database (writer reads its own `DB_DATABASE`; farmer's value is used only for the forensics path) |
| `CACHE_URL` | Yes | — | Redis connection string |
| `FARMER_TABLES` | No | _(all)_ | Comma-separated table filter |
| `FARMER_FILE_CONCURRENCY` | No | `10` | Parallel reader workers |
| `FARMER_INFLIGHT_CAP` | No | `20` | Max concurrent POSTs in flight to the writer; staging + read-buffer byte ceilings derive from it |
| `FARMER_FLUSH_INTERVAL_MS` | No | `100` | Per-table batch dispatch timer |

The per-task Redis progress tick (1 s) and metrics log interval (60 s) are fixed constants, not env knobs.

## Development

```sh
pnpm install
pnpm build
pnpm test
```

For technical details, see [docs/services/FARMER.md](../../docs/services/FARMER.md).
