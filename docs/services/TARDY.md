# Tardy Service — Technical Reference

## Overview

```
Tardis API  →  tardy  →  vault (POST /files/:table/:date/rows)
                  ↕
            cache (redis) — per-table download progress
```

Tardy fills a gap in the historical dataset that neither courier (S3 gzips) nor scribe (REST API) can cover: the seven BitMEX WebSocket-only tables. It uses the Tardis free tier, which provides data for the first day of each calendar month with no API key required.

The Tardis archive for BitMEX begins on 2019-03-30. Because only first-of-month dates can be downloaded on the free tier, the first date tardy can actually pull is 2019-04-01.

## Tables

| Table | First downloadable date |
|---|---|
| `announcement` | 2019-04-01 |
| `chat` | 2019-04-01 |
| `connected` | 2019-04-01 |
| `instrument` | 2019-04-01 |
| `liquidation` | 2019-04-01 |
| `orderBookL2` | 2019-04-01 |
| `publicNotifications` | 2019-04-01 |

## Eligibility Window

A date is eligible for download when `date + 2 days ≤ now UTC`. This ensures the full day's data is available on Tardis before the attempt, and prevents tardy from touching vault files that may still be open from live sources on the same calendar day. Concretely, the first of May is not fetched until the third of May begins (00:00 UTC).

## Sync Flow

On startup and at each UTC midnight:

1. Compute all first-of-month dates from the configured start date through the current eligibility cutoff. The default start date is the Tardis BitMEX archive genesis (2019-03-30); iteration advances to the first first-of-month on or after that, so the first target date is 2019-04-01.
2. For each date in chronological order:
   a. For each of the seven tables, consult the progress mark (see [Progress Tracking](#progress-tracking)). Any date at or below a table's mark is already complete and is skipped without contacting vault.
   b. For the remaining tables, query `GET /files/:table` on vault. A `closed` file means the date is already stored, so its mark is advanced and the table skipped. An `open` file is deleted first (crash recovery), then re-included. A table with no file is included.
   c. If no tables remain, the date is skipped entirely.
   d. Otherwise, stream all 1,440 minute-buckets from Tardis for the needed tables.
   e. Flush batches of messages per table to vault during streaming.
   f. After the stream ends, flush any remaining messages, close each table's vault file, and advance that table's progress mark to this date.

## Progress Tracking

Tardy persists download progress in the shared cache (redis) so it does not re-download dates whose vault files have already been cold-storaged and removed from this machine. Vault's own file listing is not a durable record of what tardy has done — once a file is processed and archived elsewhere, vault no longer holds it.

Progress is a per-table high-water mark, keyed `tardy:<table>`, holding the last first-of-month date (`YYYYMMDD`) that was fully downloaded and closed for that table. Tables are tracked independently because the set of tables tardy collects can change over time, and a date is only ever considered complete for a table once that table's file is closed.

Because dates are processed in ascending order, the mark only ever moves forward. There are two paths that advance it:

- **Catch-up:** when a date past the mark is found already `closed` in vault — dates stored before progress tracking existed, or before they were recorded — the mark jumps to that date with no download.
- **Completion:** when a needed table finishes streaming and its vault file is closed.

Any target date at or below a table's mark is skipped on a pure redis lookup, with no vault round-trip. This is the mechanism that lets tardy stay correct after vault files are removed.

The cache backend is hidden behind a small progress module; the rest of the service only asks for progress to be fetched or saved and is agnostic to where it lives.

## Tardis API

Each minute of data is a separate HTTP request:

```
GET https://api.tardis.dev/v1/data-feeds/bitmex
  ?from=YYYY-MM-DD
  &offset=<0–1439>
  &filters=[{"channel":"announcement"},{"channel":"orderBookL2"},...]
```

All needed tables are combined into a single `filters` array per request, so each minute costs exactly one HTTP round-trip regardless of how many tables remain to be downloaded. The response is a stream of newline-delimited records.

No API key is required for first-of-month data. The `Authorization` header is never sent.

## Line Format

Each line in a Tardis response:

```
2019-04-01T00:00:02.6803580Z {"table":"orderBookL2","action":"insert","data":[...]}
```

The timestamp has nanosecond precision. Tardy truncates it to milliseconds (`ts.slice(0, 23) + 'Z'`) before passing it to vault, matching the precision used everywhere else in the pipeline.

## Vault Output Format

Messages are written as WS-format batches, identical to the journalist service:

```
POST /files/:table/:date/rows
Content-Type: application/json

[
  { "action": "insert", "date": "2019-04-01T00:00:02.680Z", "data": [...rows] },
  { "action": "update", "date": "2019-04-01T00:00:03.100Z", "data": [...rows] },
  ...
]
```

The `table` name is used as the URL path segment; it is not included in the request body. Each element of the array corresponds to one original Tardis line.

## Vault Status Codes

| Status | Handling |
|---|---|
| `202` | Success |
| `409` (closing) | Batch dropped silently — file is being sealed, data already complete |
| `418` (sealed) | Batch dropped silently — file already closed from another source |
| Network error | Retried indefinitely with a 5 s fixed delay |
| Other error | Thrown — surfaces as a sync failure for that date |

## Retry Behaviour

**Tardis fetch failures:** Retried up to 8 times with exponential backoff starting at 1 s. HTTP 429 (rate limit) is retried with the same backoff. After 8 failures the error propagates.

**Vault unreachable:** Retried indefinitely with a fixed 5 s delay until vault responds.

## Architecture

```
Startup:
  targetDates(startDate) → [20190401, 20190501, ...]    // startDate default = 20190330
  for each date:
    resolveTables(date) → tables needing download
      for each of the 7 tables:
        date <= getProgress(table) → skip (no vault call)
        else GET /files/:table:
          closed → setProgress(table, date), skip
          open   → DELETE /files/:table/:date, then include
          absent → include
    if no tables needed: skip date
    streamDate(date, tables):
      for offset = 0..1439:
        GET Tardis API (all needed channels in one request)
        parse each line → { table, msg: { action, date, data } }
        accumulate per-table; flush to vault when batch fills
    for each table: flush remaining + POST /files/:table/:date/close + setProgress(table, date)

Scheduling:
  setTimeout to next UTC midnight → repeat
```
