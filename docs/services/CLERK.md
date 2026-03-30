# Clerk Service — Technical Reference

## Overview

```
vault (closed .csv.gz files)
  └─ clerk
       ├─ WS tables  ──→ topic:clerk  routingKey=data
       └─ REST tables ──→ topic:clerk  routingKey=item
```

Clerk is the entry point of the customs pipeline. It continuously scans vault for
files (open or closed), reads them from the last known offset, and publishes new
content to the `clerk` topic exchange for downstream processing. Progress is tracked
in Redis so work already done is never repeated.

## Tables

Clerk discovers tables dynamically by calling `GET /tables` on vault at the start of
each poll cycle. Vault returns whatever table directories exist under its data root.

## Poll Loop

1. Calls `GET /tables` on vault to get the current list of tables.
2. For each table, calls `GET /files/:table` in parallel to list all known files and their state (`open` / `closed`).
3. Merges all `(date, table, state)` tuples and sorts by date ascending, then table name as tiebreaker.
4. Skips files marked as done in Redis.
4. For each remaining file, reads the stored offset from Redis and streams from that position.
5. Publishes all new content; checkpoints the offset to Redis every 500 messages.
6. On completion: closed files are marked done; open files have their offset updated.
7. Sleeps 60 seconds and repeats.

Open files are polled on every cycle — each pass picks up only the rows added since
the last offset. This gives near-real-time database ingestion for all tables without
waiting for a day to close.

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
                               →  "done"     # closed file fully processed (never revisited)
```

Offset is checkpointed every 500 published messages and again at the end of each
cycle. On crash, clerk resumes from the last checkpoint — at most 499 messages are
re-published. Registrar handles these duplicates silently via unique index on `_id`.

Open files are never marked done. Each poll cycle reads from the stored offset and
advances it to the new end of the file. When a file is eventually closed, the next
cycle clears the offset and marks it done.

## Vault Resilience

`GET /files/:table` (file listing) retries indefinitely on non-404 HTTP errors and
network failures, with a 5 s delay between attempts. The actual file read (`GET /files/:table/:date`)
does not retry — a failure throws and the file remains unprocessed, to be retried on the
next poll cycle.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `CLERK_BACKPRESSURE_LIMIT` | No | `100000` | Max messages in watched queues before pausing |
| `CLERK_WATCH_QUEUES` | No | `assembler,registrar` | Comma-separated queue names to watch |
