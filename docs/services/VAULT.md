# Vault Service — Technical Reference

## Overview

Vault is a purpose-built HTTP file store for date-partitioned CSV data. It accepts two kinds of payload from upstream services — **items** (plain rows from REST tables) and **messages** (BitMEX WebSocket messages from journalist) — serialises them to CSV, and manages the full lifecycle of each file from the initial open state through to the closed (sealed) state.

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

Stores a complete pre-built binary file (e.g. a raw gzip downloaded from S3). Written atomically: streamed to the `.csv.gz.tmp` path then renamed to `.csv.gz`. Returns `204` on success, `409` if any file for that date already exists.

### `POST /files/:table/:date/close`

Seals an open file. Flushes the in-memory buffer, ends the gzip stream, waits for the underlying file to drain, then renames `.csv.gz.tmp` → `.csv.gz`. Returns `202` immediately (runs in background), `204` if already closed, `404` if no open file exists.

### `DELETE /files/:table/:date`

Drops an open file. Flushes the buffer and ends the gzip stream first, then deletes the `.csv.gz.tmp`. Returns `204` on success, `404` if no open file exists.

### `GET /files/:table/:date`

Streams a file as `application/x-ndjson`, with field types cast from CSV. Works for both open and closed files; the closed `.csv.gz` takes priority if both exist. Returns `404` if neither file exists.

Output format depends on the table type:

- **REST tables** (no `_date_` column): one JSON object per line.
- **WS tables** (with `_date_` column): rows are grouped by `_date_` boundaries. Each group is emitted as one line: `{ "action": "insert", "date": "...", "data": [{...}, ...] }`.

### `GET /tables`

Returns an array of all table names that have data in vault (one entry per subdirectory under the data root). Returns `[]` when no tables exist.

### `GET /files/:table`

Returns a JSON object mapping date keys to their state:

```json
{ "20200101": "closed", "20200102": "open" }
```

Returns `{}` when no files exist for the table.

---

## Write Handles and Batching

Each open `(table, date)` pair gets an in-memory buffer and a live gzip stream writing to its `.csv.gz.tmp` file (opened in append mode).

On each `POST /rows` call:
1. Creates the year directory if it does not exist.
2. Gets or creates the gzip handle. If the `.csv.gz.tmp` already exists on disk (e.g. after a restart), the gzip stream appends a new gzip member — concatenated gzip members are valid gzip and decompress to one continuous CSV. The header is only written on the first member.
3. Appends each row as a CSV line to the in-memory buffer.
4. Returns `202` to the caller.

**Flush triggers** — the buffer is written to the gzip stream as a single `gz.write()` call when either:
- The buffer reaches **10,000 rows**, or
- **1 second** has elapsed since the first unflushed row arrived.

Fewer, larger writes to the gzip stream are dramatically cheaper than per-row writes for both the compression pipeline and the underlying file I/O.

**Durability trade-off** — `202` means "accepted". Rows sitting in the buffer at the time of a process crash are lost. Vault clients are expected to handle failures and retry. For high-rate backfills, data arrives faster than it can be confirmed durable, and the backfill is replayable anyway.

---

## File Lifecycle

```
POST /rows  →  open .csv.gz.tmp (created on first row, gzip stream live)
                    ↓  (buffer → gz.write batches → append to .csv.gz.tmp)
POST /close →  flush buffer  →  end gz stream  →  await file drain  →  rename .csv.gz.tmp → .csv.gz
```

The `.csv.gz.tmp` extension means: a live or recently-live gzip stream is writing here. The `.csv.gz` extension means: sealed, no more writes, safe to read or archive.

`storeFile` (PUT) uses the same `.csv.gz.tmp` path for its atomic write; the `closing` set is held for the duration to prevent `insertRow` from racing onto the same path.

---

## Health Monitoring

Vault exposes an `isHealthy()` gate checked on every `POST /rows` request. When unhealthy, inserts return `503` until recovery.

Recovery is probed every 5 seconds via a canary write to `/data/vault/.health-canary`. Once the canary succeeds, vault transitions back to healthy.

The unhealthy state is triggered by calling `recordFailure()` internally. The failure window is 5 failures within 60 seconds.

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Row insert while unhealthy | `503` returned; row not buffered |
| Message with missing or non-array `data` | `400` returned; nothing buffered |
| Gzip or file stream error | Logged; handle and buffer discarded; next insert recreates the handle (appends a new gzip member) |
| Close with no open file | `404` |
| Delete with no open file | `404` |
| `storeFile` pipeline failure | Tmp file cleaned up; error propagated to caller |
