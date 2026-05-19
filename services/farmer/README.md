# Farmer Service

Reads closed vault files (gzipped CSV per table+date), reconstructs the
original BitMEX WebSocket envelopes for WS-origin tables, assigns deterministic
`_id`s, and bulk-inserts the cleaned documents into MongoDB via the
[Writer](../writer/README.md) sidecar. Progress is checkpointed in Redis so a
restart resumes mid-file.

A single in-process pipeline replaces what was previously a three-service
chain (clerk + assembler + registrar) coupled by RabbitMQ. Mongo writes are
offloaded over HTTP to the writer so farmer's event loop can run the reader at
its native rate.

## What it does

- Discovers closed vault buckets via `GET /tables` + `GET /files/:table`
- Reads `customs:<table>:<date>` from Redis to find resume points
- Streams each bucket's NDJSON over HTTP (with `?skip=N` for resumes)
- Routes by table type: REST records pass through; WS messages are
  reconstructed (timestamp normalization, partial decoration, legacy backfills)
- Assigns `_id = makeId(date, index)` — deterministic, idempotent on retry
- Batches docs per-table by **row count** (not item count, since a single WS
  partial can carry tens of thousands of rows) and POSTs each batch to the
  writer service
- Captures parse/reconstruct failures into `farmer.<table>` (direct mongo
  write — error volume is too low to justify the HTTP hop)
- Shuts down loudly when it sees an unknown table (config drift)
- Retries writer failures forever with exponential backoff (1s → 30s cap)

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `VAULT_URL` | Yes | — | Base URL of vault |
| `WRITER_URL` | Yes | `http://writer` | Base URL of the writer service |
| `DB_DATABASE` | Yes | — | Target database (writer reads its own `DB_DATABASE`; farmer's value is used only for the forensics path) |
| `CACHE_URL` | Yes | — | Redis connection string |
| `FARMER_TABLES` | No | _(all)_ | Comma-separated table filter |
| `FARMER_FILE_CONCURRENCY` | No | `10` | Parallel reader workers |
| `FARMER_READ_BUFFER_HIGH` | No | `1000000` | Reader queue high watermark |
| `FARMER_READ_BUFFER_LOW` | No | `500000` | Reader queue low watermark |
| `FARMER_INFLIGHT_CAP` | No | `500000` | Global in-flight cap (rows on the wire to the writer) |
| `FARMER_WIRE_CAP_MB` | No | `20` | Max batch size to send to Writer at once, in megabytes |
| `FARMER_FLUSH_INTERVAL_MS` | No | `100` | Per-table batch dispatch timer |
| `FARMER_PROGRESS_INTERVAL_MS` | No | `1000` | Per-task Redis progress tick |
| `FARMER_METRICS_INTERVAL_MS` | No | `60000` | Throughput metrics log interval |

## Development

```sh
pnpm install
pnpm build
pnpm test
```

For technical details, see [docs/services/FARMER.md](../../docs/services/FARMER.md).
