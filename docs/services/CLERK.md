# Clerk Service — Technical Reference

## Overview

```
vault (closed files)
  └─ clerk
       ├─ data       ──→ topic:clerk  routingKey=message  (WS tables)
       ├─ data       ──→ topic:clerk  routingKey=record   (REST tables)
       └─ end-of-bucket ──→ topic:clerk  routingKey=control
```

Clerk is the entry point of the customs pipeline. It continuously scans vault
for closed files, reads them from the registrar-confirmed resume point, and
publishes their content to the `clerk` topic exchange. When a file is fully
published it emits a `complete` control message so registrar can finalize the
bucket.

Redis is read-only for clerk — the `customs:<table>:<date>` keys are owned by
registrar (see [REGISTRAR.md](REGISTRAR.md)). Clerk consults them only to
decide what to skip and where to resume from.

## Tables

Clerk discovers tables dynamically by calling `GET /tables` on vault at the
start of each poll cycle. Vault returns whatever table directories exist under
its data root.

If `CLERK_TABLES` is set, only tables whose names appear in that list are
processed; the rest are silently skipped. An unknown name simply matches
nothing and has no effect.

## Poll Loop

Each cycle:

1. `GET /tables` then parallel `GET /files/:table` to list closed files.
2. Reads `customs:<table>:<date>` from Redis for each `(table, date)` to learn
   per-bucket state.
3. Filters the candidate list:
   - Buckets whose Redis value is `'done'` are skipped.
   - Buckets in the in-memory "completed this run" set are skipped (see below).
4. For the remainder, `startFrom` is derived from the Redis value: `null → 0`,
   numeric `N → N + 1` (registrar's counter is the highest stored msgIndex).
5. A worker pool of size `CLERK_FILE_CONCURRENCY` processes the work list.
   Files are independent — fast tables don't wait for slow ones, and different
   dates can run in parallel.
6. When the pool drains, sleep 60 s and repeat.

### In-memory "completed this run" set

Once a file completes successfully, clerk adds `<table>:<date>` to an in-memory
set that lives for the lifetime of the service. The next poll cycle skips
anything in this set regardless of what Redis currently says — necessary
because registrar's `'done'` flag is only flushed periodically and may lag
clerk's local view by a few seconds.

The set starts empty, so on a cold start only Redis decides what to skip.

## Per-File Pipeline

```
vault NDJSON ──→ ReadTask ──→ bounded buffer ──→ PublishTask ──→ RabbitMQ
                                                   └─ control on completion
```

Two async tasks coupled by a `BoundedBuffer<{item, msgIndex}>` with high/low
watermarks:

- **ReadTask** streams the vault file (HTTP `?skip=<startFrom>`) and pushes
  parsed lines into the buffer. `msgIndex` is always the absolute 0-based
  position in the file.
- **PublishTask** pops items in order and publishes with a sliding window of
  `CLERK_INFLIGHT_LIMIT` in-flight acks. When the window is full it awaits
  whichever publish completes first.

Backpressure is automatic: slow publishes fill the buffer → ReadTask's push
waits at the high watermark → the vault HTTP socket fills → TCP throttles
vault server-side.

Per-file ordering is strict (FIFO buffer, one-at-a-time pop). Across files
there is no ordering constraint.

When ReadTask finishes the file, the buffer drains, and once every in-flight
publish acks, clerk emits the bucket's `complete` control message and adds
the file to the completed-this-run set.

## Published Messages

### Data (per row)

Each row is published once with one of two routing keys depending on the file
shape, plus AMQP headers:

| Header        | Value                                       |
|---            |---                                          |
| `x-table`     | Table name                                  |
| `x-date`      | File date (`YYYYMMDD`)                      |
| `x-msg-index` | Absolute 0-based position within the file   |

| Routing key | Payload                                            |
|---          |---                                                 |
| `message`   | A WS message group `{ action, date, data: Row[] }` |
| `record`    | A single REST `Row`                                |

Data messages are published with `persistent: false`. The broker keeps them in
memory only — a RabbitMQ crash drops the whole in-flight bucket, and clerk
resumes from registrar's confirmed offset on the next poll. The trade-off is
deliberate: persistent publishes fsync every message and cap throughput at
the disk's IOPS ceiling.

### Control (one per file)

After the last data message for a file has been acked, clerk publishes:

```
routingKey: control
payload:    { type: 'complete', table, date, highestIndex }
```

`highestIndex = totalGroups - 1`, or `-1` for an empty file.

Control messages use the broker default (`persistent: true`). They are rare —
one per file — so the fsync cost is negligible, and durability buys
extra resilience for a signal that registrar uses to finalize the bucket.

Publishing the control message retries forever with a 5 s backoff. By the
time the control is due, hours of data publishing may already be on the
broker — abandoning the file because a single tiny signal couldn't be sent
is unacceptable.

## Recovery Model

Restart-from-scratch is always safe. If clerk crashes mid-file:

1. On restart, the in-memory completed-set is empty.
2. The next poll cycle reads `customs:<table>:<date>` for the file.
3. If registrar has flushed `'done'` (control was delivered and bucket
   finalized), the file is skipped.
4. Otherwise, `startFrom = <stored counter> + 1` and clerk resumes from there.
   Any republished messages whose `_id` already exists in MongoDB get
   `E11000`, which registrar tolerates silently.

If RabbitMQ crashes, the in-flight bucket's non-persistent data messages
are lost from the queue. Clerk's next poll behaves the same as above —
re-read `customs:`, resume from registrar's last confirmed index.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `VAULT_URL` | _(required)_ | Base URL of vault |
| `CLERK_TABLES` | _(all)_ | Comma-separated table names to process |
| `CLERK_WATCH_QUEUES` | | Comma-separated queues to watch for backpressure: queue1:limit1,queue2:limit2 |
| `CLERK_FILE_CONCURRENCY` | `6` | Max files processed concurrently |
| `CLERK_READ_BUFFER_HIGH` | `100000` | Buffer high watermark (pause read) |
| `CLERK_READ_BUFFER_LOW` | `50000` | Buffer low watermark (resume read) |
| `CLERK_INFLIGHT_LIMIT` | `5000` | Max in-flight publish acks per file |
