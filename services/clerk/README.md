# Clerk Service

Scans vault for closed files across all BitMEX tables and publishes their rows
to RabbitMQ for downstream processing. Reads progress from Redis to know what
to skip and where to resume from; registrar owns the writes.

## What it does

- Discovers closed vault files via `GET /files/:table`
- Skips buckets already finalized in Redis (`customs:<table>:<date>` = `'done'`)
- Skips buckets already completed this run via an in-memory set
- Resumes mid-file from registrar's last confirmed msgIndex (`stored + 1`)
- WS files: publishes one `message` per WS group; REST files: one `record` per row
- Emits a `complete` control message per file so registrar can finalize the bucket
- Publishes data with `persistent: false` and the control message with the broker
  default — see the docs for the rationale
- Applies backpressure when downstream queues exceed capacity

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `VAULT_URL` | Yes | — | Base URL of vault |
| `CLERK_TABLES` | No | _(all)_ | Comma-separated table names to process |
| `CLERK_WATCH_QUEUES` | | Comma-separated queues to watch for backpressure: queue1:limit1,queue2:limit2 |
| `CLERK_FILE_CONCURRENCY` | No | `6` | Max files processed concurrently |
| `CLERK_READ_BUFFER_HIGH` | No | `100000` | Buffer high watermark (pause read) |
| `CLERK_READ_BUFFER_LOW` | No | `50000` | Buffer low watermark (resume read) |
| `CLERK_INFLIGHT_LIMIT` | No | `5000` | Max in-flight publish acks per file |

## Development

```sh
pnpm install
pnpm build
pnpm test
```

For technical details, see [docs/services/CLERK.md](../../docs/services/CLERK.md).
