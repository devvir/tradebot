# Vault

Vault is a date-partitioned HTTP file store for BitMEX CSV data. It accepts rows from upstream services (journalist, tardy, scribe), buffers them in memory, and flushes to disk as concatenated gzip members. Courier stores complete pre-built files directly via PUT. Downstream consumers (clerk) read back sealed files as NDJSON.

Vault is not a database. It has no query capability. It is a write-optimised append store.

---

## File layout

All files live under `/data/vault` (fixed path):

```
/data/vault/<table>/<yyyy>/<filename>.csv.gz.tmp   ← open (being written)
/data/vault/<table>/<yyyy>/<filename>.csv.gz        ← closed (sealed)
```

`<filename>` is either the date (`20230201`) or `<date>.<suffix>` when a client tags the file (`20230201.snapshot`). The grouping directory `<yyyy>` is always the first four characters of the filename, so suffixed and bare-date files for the same day live side-by-side. A file is either open or closed — never both. A closed file is permanent; it is never overwritten or appended to.

The suffix is opt-in. Date and suffix are separate concepts only at the HTTP boundary; everywhere past the route handler, vault deals in a single `filename` identifier.

---

## CSV format

All files are CSV with a fixed header row as their first record. Column order is defined by `TABLE_HEADERS` in `data/headers.ts` and is authoritative — vault never infers columns from incoming data, because WS update messages only include changed fields.

Field values are RFC 4180 escaped: any field containing `,`, `"`, or `\n` is wrapped in `"..."` with embedded `"` doubled. Quoted fields with embedded newlines (e.g. announcement bodies, chat messages, public notifications) span multiple physical lines on disk but read back as a single logical record. Vault uses `csv-parse` (via the shared `createCsvParser` helper) end-to-end on the read path, so multi-line quoted fields round-trip correctly.

**REST tables** (`funding`, `insurance`, `settlement`, `compositeIndex`): plain rows, no metadata columns.

**WS tables** (`orderBookL2`, `instrument`, `chat`, etc.): two metadata columns prepend every row — `_date_` and `_action_`. These are message-level, not per-row:

- `_date_` and `_action_` are non-empty only on the **first record of each message**. Continuation rows (subsequent rows from the same `data` array) leave both columns empty.
- An empty `data: []` message still produces one record (with metadata, all data columns empty) so no message is lost.
- A reader detects message boundaries by a non-empty `_date_` field.

---

## Storage format

Files are stored as gzip from the first byte. Each flush appends **one self-contained gzip member** (header + DEFLATE payload + CRC32 + trailer) to the `.csv.gz.tmp` file. Between any two flushes the file on disk is a fully valid multi-member gzip, readable by any standard tool.

Each member starts DEFLATE with an empty sliding window, so patterns spanning member boundaries are not compressed across them. Files are roughly 5–10% larger than single-stream gzip. Acceptable given the durability gains.

---

## HTTP API

All routes are relative to `http://vault`.

Every endpoint that takes `:date` also accepts an optional `?suffix=<value>` query parameter. When present, the file targeted is `<date>.<suffix>` instead of just `<date>`. Omitting it (or sending `?suffix=`) is identical to never having heard of suffixes — the file path, behaviour, and listing keys all collapse to the date alone. Suffixed and bare-date files for the same day are independent: they have separate buffers, independent open/closed state, and independent close/delete lifecycles.

### `POST /files/:table/:date/rows`

Buffers rows for async disk write. Returns `202` immediately.

**Body:** a single JSON object or a JSON array of objects. Each object is processed independently:

- **No `action` field** — plain REST row, stored as-is.
- **Has `action` field + `data` array** — WS message. The first row of `data` is enriched with `_date_` (message date, or wall-clock if absent) and `_action_` before encoding. An empty `data: []` still produces one metadata line.

**Errors:**
- `400` — body is not an object/array of objects, or a message has a missing/non-array `data` field.
- `409` — file is closed, or a `POST /close` is in progress for this date.
- `503` — vault is unhealthy (see Health section).

### `PUT /files/:table/:date`

Stores a complete pre-built gzip file (courier). Streams directly to `.csv.gz.tmp`, then renames to `.csv.gz` atomically. All-or-nothing: a failed upload leaves an open file, which is silently discarded on the next PUT for the same date.

- `204` — stored.
- `409` — a sealed `.csv.gz` already exists. Sealed files are permanent.

If an open `.csv.gz.tmp` exists (interrupted prior upload), it is discarded and the new upload proceeds.

### `POST /files/:table/:date/close`

Seals an open file. Fire-and-forget: returns `202` immediately. In the background, flushes the in-memory buffer as a final gzip member, then renames `.csv.gz.tmp` → `.csv.gz`. Further `POST /rows` calls for this date are rejected with `409` from this point on, regardless of whether the rename has completed.

### `DELETE /files/:table/:date`

Discards an open file. Flushes and drops the in-memory buffer, then unlinks `.csv.gz.tmp`. Idempotent — returns `204` whether or not the file existed.

### `GET /files/:table/:date`

Streams a **closed** file as `application/x-ndjson`. Open files return `404`.

Output shape depends on the table type:

- **REST tables:** one JSON object per line.
- **WS tables:** rows are grouped into messages. Each message is one line: `{ "action": "insert", "date": "...", "data": [{...}, ...] }`.

Optional `?skip=N`: vault skips the first N messages/rows server-side before streaming. For WS tables, a skip unit is one message; for REST tables, one row.

- `404` — no closed file for this date.

### `GET /files/:table/:date/headers`

Returns the CSV column names of a closed file as a JSON array: `{ "columns": [...] }`.

- `404` — no closed file, or the file is empty.

### `GET /files/:table`

Returns a map of all filenames for a table and their state:

```json
{ "20240101": "closed", "20240102": "open", "20240102.snapshot": "open" }
```

Suffixed files appear as additional keys. Clients that do not write suffixed files will not see them in their own listings unless another producer creates one.

- `404` — the table directory does not exist.

### `GET /tables`

Returns an array of all table names that have data in vault. Returns `[]` if none.

---

## Write pipeline

```
POST /rows
  → encode (Row / WsMessage → CSV lines)
  → buffer.pushMany(lines)            [in-memory, table/filename keyed]
  → ticker (every 200 ms)
      → buffers.flushReady()          [size ≥ 10k rows OR time ≥ 10s since last flush]
      → prepend header if file new
      → fs/writer.appendBatch()       [gzip member → ftruncate-safe append]
```

All data passes through the buffer. No writes bypass it. Node's single-threaded event loop guarantees that the `isInitialized` check and the `appendBatch` call that follows are synchronous — no race on header prepending is possible.

### Buffer flush triggers (both checked per tick, one pass)

| Trigger | Threshold | Rationale |
|---|---|---|
| Size | 10,000 lines | Memory ceiling; leading trigger for high-frequency tables |
| Time | 10 s since last flush | Catches low-frequency tables that never hit the size limit |

### Write safety

Before each gzip member is appended, `lastGoodOffset` is read from the inode via `statSync` (metadata only — no disk I/O in the normal path). On failure:

1. Truncate back to `lastGoodOffset` (`ftruncate` — inode size update only, no data copy).
2. Retry up to 3 times with linear backoff (100 ms × attempt).
3. If retries are exhausted: drop the batch, call `recordFailure` for health accounting.
4. If truncate also fails: write a `.csv.gz.error` sidecar in the same year directory (timestamp, `lastGoodOffset`, both error messages, gzrecover note) and continue appending — new valid members written after the corrupt partial are recoverable with `gzrecover`. Halting writes would lose the rest of the day.

### Write serialisation

Each open file has a promise chain (`handle.writing`). Each `appendBatch` call appends to the tail of the chain. Concurrent callers queue in arrival order with no data loss — a boolean flag would require dropping data that has already left the buffer.

---

## Closing a file

`POST /close` adds the key to an append-only `closing` set in the server layer (immediate write rejection), then fires `closeBucket(table, filename)` asynchronously:

```
closeBucket:
  lines = buffer.flush()
  if no file on disk AND lines empty → no-op
  if file not yet initialised → prepend header to lines
  appendBatch(lines, seal=true)
```

When `seal=true`, `appendBatch` renames `.csv.gz.tmp` → `.csv.gz` after the final member is written. Because the rename chains onto the same write promise, it executes after all in-flight appends complete.

---

## Restart behaviour

Vault never assumes it created the current open file. On restart, `isInitialized(table, filename)` checks `handles.has(key) || existsSync(openPath(table, filename))`. If a `.csv.gz.tmp` already exists on disk (from before the restart), it is treated as initialised — new appends continue without re-writing the header.

---

## Health

`isHealthy()` is checked on every `POST /rows`. Returns `503` when unhealthy.

Vault goes unhealthy when 5 batches exhaust all retries within 60 seconds — a signal of a systemic problem (disk full, filesystem read-only), not a transient blip. While unhealthy, vault probes every 5 seconds with a canary write to `/data/vault/.health-canary`. On success it returns to healthy.

Clients on `503`: journalist holds data in memory and stops consuming from RabbitMQ; tardy backs off. Neither drops data.

---

## Shutdown

On graceful shutdown, in order:

1. HTTP server closes — no new requests accepted.
2. Ticker stops.
3. All in-memory buffers are flushed and handed to `appendBatch` (no seal — sealing is client-driven, not a shutdown concern).
4. All open write chains are awaited before the process exits.

Open files remain as `.csv.gz.tmp`. On the next start, writes resume by appending new gzip members.

---

## Tuning constants

| Constant | Location | Value |
|---|---|---|
| `TICK_MS` | `data/ticker.ts` | 200 ms |
| `STALE_THRESHOLD_MS` | `data/buffers.ts` | 10,000 ms |
| `BATCH_SIZE` | `data/buffers.ts` | 10,000 lines |
| `MAX_RETRIES` | `fs/writer.ts` | 3 |
| `RETRY_BACKOFF_MS` | `fs/writer.ts` | 100 ms |
| `FAILURE_THRESHOLD` | `fs/health.ts` | 5 failures |
| `FAILURE_WINDOW_MS` | `fs/health.ts` | 60,000 ms |
| `RECOVERY_INTERVAL_MS` | `fs/health.ts` | 5,000 ms |
