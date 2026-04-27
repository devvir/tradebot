# Vault Service — Technical Reference

## Overview

Vault is a purpose-built HTTP file store for date-partitioned CSV data. It accepts rows from upstream services — scribe (REST backfill), tardy (gap-filler), and journalist (live WebSocket feed) — buffers them in memory, and flushes to disk as concatenated gzip members. It manages the full lifecycle of each file from the initial open state through to the sealed state.

Vault is not a database. It has no query capability. It is a write-optimised append store with a simple read-back interface for downstream consumers.

---

## File Layout

All files live under `/data/vault` (fixed, not configurable):

```
/data/vault/<table>/<yyyy>/<yyyymmdd>.csv.gz.tmp   ← open (being written)
/data/vault/<table>/<yyyy>/<yyyymmdd>.csv.gz        ← closed (sealed)
```

A date file is either open or closed — never both. Callers work in terms of `table` and `date` (e.g. `compositeIndex`, `20200101`); the on-disk extensions are a vault-internal concern.

---

## Items vs Messages

Vault distinguishes two payload types by the presence of an `action` field:

**Items** — objects without `action`. Stored as plain rows. Used by scribe for REST tables (`trade`, `quote`, `funding`, etc.).

**Messages** — objects with `action` and a `data` array. These are BitMEX WebSocket messages sent by journalist. Vault stores the rows from `data` with two metadata columns prepended to the first row:

- `_date_` — `message.date` if present, otherwise the current wall-clock time in ISO 8601 format
- `_action_` — `message.action` (e.g. `partial`, `insert`, `update`, `delete`)

On read, a non-empty `_date_` value marks the start of a new message group. Vault reconstructs the original message shape: `{ action, date, data: [...rows] }`.

---

## HTTP API

All routes are relative to `http://vault`.

### `POST /files/:table/:date/rows`

Accepts rows for buffered writing. Returns `202` immediately — the write is committed to an in-memory buffer and flushed to disk asynchronously.

The body can be a single JSON object or a JSON array of objects. Each object is processed independently:

- **No `action` field** — treated as a plain item (REST table row); stored as-is.
- **Has `action` field** — treated as a WS message; `data` must be an array. Vault augments the first row of `data` with `_date_` and `_action_` before storing.

Returns `400` if a message has a missing or non-array `data` field, or if the body is not a JSON object / array of objects.  
Returns `503` if vault is unhealthy (see Health section).  
Returns `409` if the file is currently being closed.  
Returns `418` if the file is already sealed.

### `PUT /files/:table/:date`

Stores a complete pre-built binary file (e.g. a raw gzip downloaded from S3). Written atomically: streamed to a `.tmp` path then renamed to `.csv.gz`. Returns `204` on success, `409` if any file for that date already exists.

### `POST /files/:table/:date/close`

Seals an open file. Flushes the in-memory buffer as a final gzip member, then renames `.csv.gz.tmp` → `.csv.gz`. Returns `202` on success, `204` if already closed, `404` if no open file exists.

### `DELETE /files/:table/:date`

Drops an open file without flushing: waits for any in-flight flush to settle, clears the buffer, then unlinks the `.csv.gz.tmp`. Returns `204` on success, `404` if no open file exists.

### `GET /files/:table/:date`

Streams a file as `application/x-ndjson`, with field types cast from CSV. Works for both open and closed files; the closed `.csv.gz` takes priority if both exist. Returns `404` if neither file exists.

Output format depends on the table type:

- **REST tables** (no `_date_` column): one JSON object per line.
- **WS tables** (with `_date_` column): rows are grouped by `_date_` boundaries. Each group is emitted as one line: `{ "action": "insert", "date": "...", "data": [{...}, ...] }`.

### `GET /files/:table/:date/headers`

Returns the CSV column names for the file as a JSON array.

### `GET /tables`

Returns an array of all table names that have data in vault. Returns `[]` when no tables exist.

### `GET /files/:table`

Returns a JSON object mapping date keys to their state:

```json
{ "20200101": "closed", "20200102": "open" }
```

Returns `{}` when no files exist for the table.

---

## Write Path — How a Row Becomes a File

A client calls `POST /files/:table/:date/rows`. The route validates the body and pushes the serialised row(s) into an in-memory buffer keyed by `table/date`. The HTTP response (`202`) returns immediately; the disk write is asynchronous.

Two triggers cause the buffer to flush:

- **Size:** when the buffer reaches 10,000 rows, a flush fires immediately.
- **Time:** a debounce timer is reset on every incoming row. If 10 seconds pass without a new row, the timer fires and flushes whatever is buffered. Low-frequency tables are bounded by this; high-frequency ones flush by size before the timer reaches its limit.

Each flush produces **one complete gzip member** appended to `.csv.gz.tmp`:

1. The buffered rows are joined into a CSV string.
2. The string is gzipped in full (in memory) via `zlib.gzip`.
3. The compressed bytes are appended to the file via `fs.promises.appendFile`.
4. `lastGoodOffset` is incremented by the compressed length.

Concatenated gzip members are valid gzip (per RFC 1952). Decompressors reconstruct one continuous CSV. The CSV header is the first row of the first member; subsequent members are pure data.

After every successful flush the file on disk is a fully readable `.gz`. There is no point at which the file requires a close step to become valid.

---

## Atomicity and Consistency

Each flush is atomic from the file's perspective: it either appends a complete gzip member or leaves the file at its previous state. The mechanism is `lastGoodOffset` plus `fs.promises.truncate`:

- **Success:** `appendFile` resolves; `lastGoodOffset += compressed.length`. The file grew by one valid member.
- **Failure:** `appendFile` rejects (disk full, EIO, etc.). The file may have partial bytes. `truncate(path, lastGoodOffset)` removes them. The same batch is retried with linear backoff (100 ms × attempt).
- **Retries exhausted:** after 3 attempts the batch is dropped. `recordFailure` notifies the health system. The file remains a valid `.gz` up to `lastGoodOffset`.

The file transitions only from one consistent state to the next. A partial flush never leaves data that gunzip cannot read.

Concurrent flushes on the same file are prevented by a flush mutex (`flushing: Promise<void> | null`). The `while` loop inside the flush drains any rows that arrived during the flush, so buffer growth is bounded under sustained load.

---

## File Lifecycle

```
POST /rows  →  buffer rows (in memory)
                 ↓  (size trigger or debounce timer)
              flush → gzip member → appendFile → lastGoodOffset advances
                 ↓  (POST /close)
              final flush → rename .csv.gz.tmp → .csv.gz
```

`storeFile` (PUT) uses a separate `.tmp` path during upload; the `closing` set is held for the duration to prevent `insertRow` from racing onto the same destination path.

---

## Shutdown and Restart

**Graceful shutdown** (SIGTERM / SIGINT):

1. The HTTP server closes first, so no new connections arrive.
2. `shuttingDown = true` — subsequent `insertRow` calls are silently dropped.
3. For every open handle, the buffer is drained as a final gzip member.
4. Files remain as `.csv.gz.tmp` — vault does not rename on shutdown. The next startup resumes appending to the same file.

**Resume after restart:**

The first `insertRow` for a `table/date` triggers handle creation. If `.csv.gz.tmp` already exists, `lastGoodOffset` is set to `statSync(path).size` and the CSV header is not re-written — the file already has it. If it does not exist, `lastGoodOffset = 0` and the header is the first entry of the first batch.

This is correct after a clean shutdown: every byte on disk is part of a valid gzip member, so `file.size == lastGoodOffset`.

---

## Known Limitation: Hard-Crash Recovery

If vault is killed by SIGKILL / OOM / power loss **during** a write (not between flushes), the `.csv.gz.tmp` may have partial trailing bytes from the in-flight `appendFile`. On restart, `lastGoodOffset` is set from the current file size, which includes those partial bytes. Future flushes append after the corruption, making subsequent valid members unreachable by a standard gunzip pass.

Clean shutdowns (SIGTERM / SIGINT) and graceful restarts are fully safe. The only path to corruption is a hard kill during the millisecond-wide window of an in-flight `appendFile`.

The standard remedy — not currently implemented — is a sidecar offset file (`.csv.gz.tmp.offset`) written after each successful flush. On restart, the data file is truncated back to the sidecar offset before resuming.

---

## Health Monitoring

Vault exposes an `isHealthy()` gate checked on every `POST /rows` request. When unhealthy, inserts return `503` until recovery.

Recovery is probed every 5 seconds via a canary write to `/data/vault/.health-canary`. Once the canary succeeds, vault transitions back to healthy.

The unhealthy state is triggered by `recordFailure()` internally — currently on flush-retry exhaustion. The failure window is 5 failures within 60 seconds.

---

## Tuning Constants

| Constant | Value | Rationale |
|---|---|---|
| `BATCH_ROWS` | 10,000 | Memory ceiling per file; ~2–3 MB uncompressed for typical row sizes. |
| `FLUSH_INTERVAL_MS` | 10,000 ms | Worst-case row age in the buffer for low-frequency tables. |
| `MAX_RETRIES` | 3 | Total attempts before a batch is dropped. |
| `RETRY_BACKOFF_MS` | 100 ms | Linear backoff base — attempt N waits `100 × N` ms. |

Real-time `orderBookL2` (~5,000 rows/s) flushes by size every ~2 seconds. Low-frequency tables (`announcement`, `publicNotifications`) flush by timer 10 seconds after the last row. Historical backfills (tardy, scribe) flush by size.
