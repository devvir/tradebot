# Clerk Service — Technical Reference

## Overview

```
vault (closed .csv.gz files)
  └─ clerk
       ├─ WS tables  ──→ topic:clerk  routingKey=data
       └─ REST tables ──→ topic:clerk  routingKey=item
```

Clerk is the entry point of the customs pipeline. It continuously scans vault for
closed files, reads them from the last known offset, and publishes their content to
the `clerk` topic exchange for downstream processing. Progress is tracked in Redis
so work already done is never repeated.

## Tables

Clerk discovers tables dynamically by calling `GET /tables` on vault at the start of
each poll cycle. Vault returns whatever table directories exist under its data root.

If `CLERK_TABLES` is set, only tables whose names appear in that list are processed;
the rest are silently skipped. An unknown name simply matches nothing and has no effect.

## Poll Loop

1. Calls `GET /tables` on vault to get the current list of tables.
2. For each table, calls `GET /files/:table` in parallel to list known files and their state.
3. Filters out anything not yet `closed` — open files are picked up on a later cycle once they close.
4. Merges all `(date, table)` pairs and sorts by date ascending, then table name as tiebreaker.
5. Skips files marked as done in Redis.
6. For each remaining file, reads the stored offset from Redis and streams from that position.
7. Publishes all new content; checkpoints the offset to Redis every 500 messages.
8. On completion, marks the file done — a successful read implies vault served a closed file.
9. Sleeps 60 seconds and repeats.

Discovery is implemented separately in `discovery.ts` so the poll loop only ever sees
files it can actually process.

## File Reading

Vault streams files as NDJSON. Each line is either a JSON array (WS) or a JSON object (REST),
already cast to their correct types by vault:

- **WS files** — each line is a `Row[]` representing one WebSocket message group. Published
  with routing key `data`.
- **REST files** — each line is a `Row` representing one REST item. Published with routing
  key `item`.

Clerk passes each parsed line directly to the publisher — no reassembly or `_head_` inspection.

Each published message carries AMQP headers:

| Header | Value |
|---|---|
| `x-table` | Table name |
| `x-date` | File date (`YYYYMMDD`) |
| `x-msg-index` | Zero-based message position within the file |

## Backpressure

Clerk monitors the message depth of downstream queues (default: `assembler` and
`registrar`). A gate function is called before each publish; if any watched queue
exceeds `CLERK_BACKPRESSURE_LIMIT × 1.1`, publishing pauses until all watched queues
drop below `CLERK_BACKPRESSURE_LIMIT × 0.9`. Queue depths are sampled every 10 s.

## Progress Tracking

Redis stores one key per file:

```
clerk_progress:<table>:<date>  →  <offset>   # number of message groups published so far
                               →  "done"     # file fully processed (never revisited)
```

Offset is checkpointed every 500 published messages. On crash, clerk resumes from the
last checkpoint — at most 499 messages are re-published. Registrar handles these
duplicates silently via unique index on `_id`.

Once a file has been read end-to-end, its key is set to `"done"` and it is never
revisited.

## Vault Resilience

`GET /files/:table` (file listing) retries indefinitely on non-404 HTTP errors and
network failures, with a 5 s delay between attempts. The actual file read (`GET /files/:table/:date`)
does not retry — a failure throws and the file remains unprocessed, to be retried on the
next poll cycle.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `CLERK_TABLES` | No | _(all)_ | Comma-separated table names to process. Empty means process all. |
| `CLERK_BACKPRESSURE_LIMIT` | No | `100000` | Max messages in watched queues before pausing |
| `CLERK_WATCH_QUEUES` | No | `assembler,registrar` | Comma-separated queue names to watch |
