# The vault service

The vault service (`services/.deprecated/vault`) is a date-partitioned HTTP file store for BitMEX
CSV data. It accepts rows over HTTP, buffers them in memory, and appends them to disk as gzip
members. A complete pre-built file can be stored in one request instead. Closed files are read back
as NDJSON.

It is not a database and has no query capability. It is not the Parquet vault either (see
[VOCABULARY.md](../../../docs/VOCABULARY.md)). The BitMEX dataset it holds is described in
[docs/bitmex/README.md](../../../docs/bitmex/README.md).

---

## File layout

All files live under the fixed data directory `/data/vault`:

```
/data/vault/<table>/<yyyy>/<filename>.csv.gz.tmp   ← open (being written)
/data/vault/<table>/<yyyy>/<filename>.csv.gz       ← closed (sealed)
```

`<filename>` is the date (`20230201`), or `<date>.<suffix>` when a client tags the file with
`?suffix=` (`20230201.snapshot`). `<yyyy>` is the first four characters of the filename, so tagged
and bare-date files of one day sit side by side. A file is open or closed, never both. A closed file
is permanent: it is never overwritten, appended to or deleted.

The date and the suffix are separate only at the HTTP boundary. Past the route handlers, the vault
service deals in one `filename`.

**Pseudo-tables.** A dotted table name, `<table>.<variant>`, is a pseudo-table of the undotted one:
it has its own directory, but shares the real table's columns, casts and read strategy.
`baseTable` (in `@tradebot/utils`) strips the variant, so every per-table lookup resolves
`<table>.<anything>` to `<table>`, and no variant ever gets entries of its own in `TABLE_HEADERS`
or `TABLE_CASTS`. This table-name variant is independent of the per-file `?suffix=` tag.

Other files that can appear in a year directory: `<filename>.csv.gz.upload-<uuid>` (a PUT in
progress; see [PUT](#put-filestabledate)), and `<filename>.csv.gz.failed.N` and
`<filename>.csv.gz.error` (see [Write safety](#write-safety)). None of them is listed by the API.

---

## CSV format

A file built from rows starts with a header row (for the one exception, see
[Write safety](#write-safety)); a file stored with PUT is kept as sent. The columns of each table,
and their order, are `TABLE_HEADERS` in `src/data/headers.ts`. They are never inferred from incoming
data.

**WS tables** (the set `WS_TABLES` in `shared/utils/src/tables.ts`: `announcement`, `chat`,
`connected`, `instrument`, `liquidation`, `orderBookL2`, `publicNotifications`) store messages. Two
metadata columns, `_date_` and `_action_`, come first:

- They are filled only on the **first row of each message**. Continuation rows of the same `data`
  array leave both empty, so a non-empty `_date_` marks the start of a message.
- An empty `data: []` message still produces one row, with the metadata and every data column empty.

**Every other table** stores plain rows, one per line, with no metadata columns.

**Quoting.** Only the free-text tables (`FREE_TEXT_TABLES` in `shared/utils/src/tables.ts`:
`announcement`, `chat`, `publicNotifications`) hold values that need quoting. Their fields are
RFC 4180 quoted where they contain `,`, `"` or a line break, so one record can span several physical
lines, and they are read back with a full CSV parser. On every other table a value containing `,`,
`"`, `\r` or `\n`, or an object or array, is refused on write, so each physical line is one record
and is read with a plain comma split.

---

## Storage format

Files are gzip from the first byte. Each write appends **one self-contained gzip member** to the
`.csv.gz.tmp` file, so between writes the file is a valid multi-member gzip that any standard tool
can read. Compression does not carry across members, so a file is somewhat larger than the same data
as a single gzip stream. The compression level is `VAULT_COMPRESSION_LEVEL`
(see [Configuration](#configuration)).

Members are not fsynced one by one. A seal fsyncs the file before renaming it and the year directory
after; a PUT fsyncs the stored file before publishing it and the year directory after; every
directory the service creates is made durable by fsyncing its parent.

---

## HTTP API

All routes are relative to `http://vault:8000`.

**Keys.** Every route with `:date` also takes an optional `?suffix=<value>`; with it, the file is
`<date>.<suffix>`, and without it (or with `?suffix=`) the file is the date alone. Tagged and
bare-date files of one day are independent: separate buffers, state and lifecycle. Every route
answers `400` when a key part is invalid:

| Part | Rule |
|---|---|
| `:table` | `^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)?$`. On `POST /rows`, `POST /close` and `DELETE`, the table (or its real table) must also have a header definition. |
| `:date` | `YYYYMMDD`, a real calendar day |
| `?suffix=` | 1-32 characters from `A-Z`, `a-z`, `0-9`, `_` and `-` |

**Bucket state.** The file of one `table/filename` is a bucket. A bucket can be closing (a seal is in
progress), being discarded or being uploaded; each route below says in which of these it answers
`409`.

**Shutdown.** Once shutdown has started, the write routes (`POST /rows`, `POST /close`, `PUT`,
`DELETE`) answer `503`.

### `POST /files/:table/:date/rows`

Buffers rows for the bucket's open file and returns `202`. They reach disk on a later flush (see
[Write pipeline](#write-pipeline)).

**Body:** one JSON object or a non-empty array of them, at most 50 MB.

- **WS table:** each item is a message. `action` is one of `partial`, `insert`, `update`, `delete`;
  `data` is an array of objects; `date`, when present, is an ISO 8601 UTC timestamp
  (`YYYY-MM-DDTHH:MM:SS[.sss]Z`). Without `date`, the wall-clock time is written. `_date_` and
  `_action_` keys inside `data` rows are ignored.
- **Other tables:** each item is a plain row and carries neither `action` nor `data`.

The request is all-or-nothing: if any item is refused or fails to encode, the answer is `400` and
nothing from the request is buffered.

**Errors:**
- `400`: an invalid key or an unknown table; a body that is not an object or a non-empty array of
  objects; an item refused as above; a value refused by [Quoting](#csv-format); invalid JSON.
- `409`: the file is closed, or the bucket is closing, being discarded or being uploaded.
- `413`: the body is over 50 MB.
- `429`: too many writes are pending for this file. A file is throttled once 15 writes are pending
  for it and is released when 5 or fewer are; other files are unaffected.
- `503`: storage is unhealthy (see [Health](#health)), or the service is shutting down.

### `POST /files/:table/:date/close`

Seals the bucket. Returns `202` at once; in the background the buffered rows are written as a final
member and the open file is renamed `.csv.gz.tmp` → `.csv.gz` (see
[Closing a file](#closing-a-file)). From this call until the seal settles, `POST /rows` for the
bucket answers `409`. A bucket with neither an open file nor buffered rows is left as it is.

- `409`: the bucket is being discarded or uploaded.

### `PUT /files/:table/:date`

Stores a complete gzip file as the bucket's closed file. Unless the request is refused with `409` up
front, the bucket's buffered rows and open `.csv.gz.tmp` are discarded first, whatever the outcome
of the upload. The body is streamed to a temp file of its own, `<filename>.csv.gz.upload-<uuid>`,
which is never visible as open. Once the body has fully arrived it must be non-empty and decompress
as gzip to its end (several members are allowed); it is then fsynced and published as
`<filename>.csv.gz` without replacing anything. A failed upload removes its temp file; one left by a
process that died mid-upload is removed at the next start. An upload that sends nothing for 90 s is
cut off.

- `204`: stored.
- `400`: the body is empty or not a complete gzip stream.
- `409`: a closed file already exists, or the bucket is closing, being discarded or being uploaded.

### `DELETE /files/:table/:date`

Discards the bucket's buffered rows and open file, including members still queued for it, and
answers once both are gone. A closed file is never touched. Returns `204` whether or not there was
anything to discard.

- `409`: the bucket is closing, being discarded or being uploaded.

### `GET /files/:table/:date`

Streams a **closed** file as `application/x-ndjson`.

- **WS tables:** one message per line: `{ "action": "insert", "date": "...", "data": [{...}, ...] }`.
- **Other tables:** one row object per line.

Columns are taken from the file's own header row. Values are typed by `src/data/casts.ts` (numbers,
booleans, JSON, BitMEX `D`-separated timestamps read as ISO 8601 UTC); empty fields are omitted.

`?skip=N` drops the first N messages (WS tables) or rows (other tables) server-side. A value that
is not a positive number counts as 0; a fraction is rounded down.

- `404`: no closed file for the bucket. Open files are not readable. This is checked before
  anything is sent, `?skip` or not.
- `500`: the file could not be read. If part of the body is already out, the response is cut short
  instead, so the client sees it end incomplete.

### `GET /files/:table/:date/headers`

Returns the first record of a closed file, its column names: `{ "columns": [...] }`.

- `404`: no closed file, or the file is empty.

### `GET /files/:table`

Returns the table's files with their state. Listings never mix bare and tagged files:

- Without `?suffix` (or with `?suffix=`): bare-date files only.

  ```json
  { "20240101": "closed", "20240102": "open" }
  ```

- With `?suffix=X`: files tagged `X` only.

  ```json
  { "20240102.snapshot": "open" }
  ```

Only names of the form `<yyyymmdd>[.<suffix>].csv.gz[.tmp]` whose year matches their year directory
are listed.

- `404`: the table directory does not exist.

### `GET /tables`

Returns the names of every directory under the data directory, as an array; `[]` when there are
none.

### `GET /stats/:table/:date`

Returns the inode stats of the bucket's file, closed or open, from a single `stat()`:

```json
{ "state": "closed", "size": 1048576, "mtime": 1704153600000, "birthtime": 1704067200000 }
```

`state` says which file was statted; `mtime` and `birthtime` are epoch milliseconds.

- `404`: the bucket has no file, open or closed.

---

## Write pipeline

```
POST /rows
  → encode (row or message → CSV lines)
  → buffer.pushMany(lines)            [in memory, keyed by table/filename]
  → ticker (every 200 ms)
      → buffers.flushReady()          [≥ 10,000 lines, or ≥ 10 s since the last flush]
      → header line first if the file does not exist yet
      → fs/writer.appendBatch()       [one gzip member, through the file's zipper writer]
```

All data passes through the buffer. The header decision and the hand-off to the writer happen
synchronously in one call, so of several back-to-back writes to a new file only the first carries
the header. The file exists when the service has a writer for it or a `.csv.gz.tmp` is on disk
(`isInitialized`: `writers.has(key) || existsSync(openPath(...))`).

A batch whose write fails is logged with the number of rows dropped and counts toward
[Health](#health); the other batches of the same tick are written as usual.

### Buffer flush triggers

Both are checked on every tick, in one pass.

| Trigger | Threshold | Rationale |
|---|---|---|
| Size | 10,000 lines | Memory ceiling; the leading trigger for busy tables |
| Time | 10 s since the last flush | Catches quiet tables that never reach the size limit |

### Write serialisation

Each open file has one `@devvir/zipper` writer. Its writes queue in arrival order and land one after
another, never interleaved.

### Write safety

The zipper writer appends each member with recovery `auto`, 3 retries and a 100 ms backoff:

1. Before the append, the file's current size is the last good offset.
2. A failed append is truncated back to that offset and retried after 100 ms × attempt, up to 3
   retries (4 attempts in all). A truncate that fails between attempts ends the retries.
3. When every attempt has failed, the file is truncated back to the last good offset and the member
   is dropped. The loss is logged and counts toward [Health](#health).
4. If that truncate fails too, the open file is quarantined: it is renamed to
   `<filename>.csv.gz.failed.N` (the first free `N`), and the failed member is appended to a fresh
   `<filename>.csv.gz.tmp` (up to 3 attempts). A JSON line is appended to the sidecar
   `<filename>.csv.gz.error` in the same year directory, with the timestamp, the last good offset,
   the errors and the quarantine path, and the failure counts toward health. `gzrecover` extracts
   the valid members of the quarantined file.

After a quarantine:

- **The fresh open file has no header row**, unless the failed member was the file's first. The
  service still has a writer for the file, so it counts as existing and later writes add no header.
  When read, its first data record is taken as the column names.
- **The data written before the failure is only in `.failed.N`.** Sealing renames only the fresh
  file.
- **Neither `.failed.N` nor `.error` is listed** by `GET /files/:table`, read, sealed or removed by
  any route.
- If the re-append also fails, the member survives only as the corrupt tail of the quarantined file.

---

## Closing a file

`POST /close` calls `closeBucket(table, filename)`, which, synchronously:

1. marks the bucket closing (a count, so overlapping closes release it only when the last settles);
2. takes the buffered lines and drops the buffer;
3. if there is no open file and no line, does nothing more;
4. otherwise hands the lines (with the header if the file does not exist yet) to `appendBatch` with
   `seal = true`.

The seal waits for every member queued on the file's writer, fsyncs the open file, closes the writer
(the rename `.csv.gz.tmp` → `.csv.gz`) and fsyncs the year directory. The writer is dropped whether
the seal succeeds or fails. After a failed seal the bucket accepts rows again and can be closed
again; a new writer resumes the open file.

---

## Restart behaviour

The service never assumes it created an open file. A writer created for a `.csv.gz.tmp` already on
disk resumes it by appending, and since the file counts as existing (`isInitialized`), no second
header is written. At startup, upload temp files (`.csv.gz.upload-<uuid>`) left by a process that
died mid-upload are removed.

---

## Health

Storage health is global. The service goes unhealthy when 5 write failures that lost data (a dropped
member, a quarantine, a failed batch) occur within 60 s: a sign of a systemic problem such as a full
or read-only disk, not a transient error, which a retry clears without counting. While unhealthy,
`POST /rows` answers `503` and every 5 s a canary of 4,096 bytes is written and fsynced to
`/data/vault/.health-canary`; the first canary that succeeds makes storage healthy again. A `503`
refuses the write and loses nothing by itself: the rows are still the client's to send again.

The health check on port 3000 answers `200 {"status":"ok"}` while storage is healthy and
`503 {"status":"unhealthy","reason":"..."}` while it is not.

Throttling (`429`) is per file and separate from storage health: one busy file never blocks another.

---

## Shutdown

On SIGTERM or SIGINT, or on an uncaught exception, in order:

1. The write routes start answering `503`.
2. The HTTP server closes: in-flight requests may finish for up to 7 s, then the remaining
   connections are cut, so every row answered `202` is in a buffer before the next step.
3. The ticker stops and every non-empty buffer is written to its file, without sealing it.
4. Every writer's queued members and every seal in progress are awaited.

Open files stay `.csv.gz.tmp` and are resumed on the next start. An uncaught exception exits with
code 1.

---

## Configuration

| Setting | Value |
|---|---|
| HTTP API | port 8000 |
| Health check | port 3000 |
| Data directory | `/data/vault`, fixed; must be a writable volume |
| `VAULT_COMPRESSION_LEVEL` | gzip level of every member, an integer from 1 to 9; default 6. Any other value fails startup. |
| `LOG_LEVEL` | log level; default `info` |

## Tuning constants

| Constant | Location | Value |
|---|---|---|
| `TICK_MS` | `src/data/ticker.ts` | 200 ms |
| `STALE_THRESHOLD_MS` | `src/data/buffers.ts` | 10,000 ms |
| `BATCH_SIZE` | `src/data/buffers.ts` | 10,000 lines |
| `MAX_RETRIES` | `src/fs/writer.ts` | 3 |
| `RETRY_BACKOFF_MS` | `src/fs/writer.ts` | 100 ms |
| `MAX_INFLIGHT` | `src/fs/writer.ts` | 15 pending writes (throttle) |
| `INFLIGHT_RESUME` | `src/fs/writer.ts` | 5 pending writes (release) |
| `FAILURE_THRESHOLD` | `src/fs/health.ts` | 5 failures |
| `FAILURE_WINDOW_MS` | `src/fs/health.ts` | 60,000 ms |
| `RECOVERY_INTERVAL_MS` | `src/fs/health.ts` | 5,000 ms |
| `CANARY_BYTES` | `src/fs/health.ts` | 4,096 bytes |
| `UPLOAD_IDLE_TIMEOUT_MS` | `src/server/routes.ts` | 90,000 ms |
| `READ_CHUNK_CHARS` | `src/server/routes.ts` | 65,536 characters, the least an NDJSON chunk holds before the last |
| `CLOSE_DEADLINE_MS` | `src/server/index.ts` | 7,000 ms |
