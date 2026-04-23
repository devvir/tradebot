# Tardy Service — Technical Reference

## Overview

```
Tardis API  →  tardy  →  vault (POST /files/:table/:date/rows)
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
   a. Query `GET /files/:table` on vault for each of the seven tables.
   b. Tables with a `closed` file are skipped. Tables with an `open` file are deleted first (crash recovery), then re-included. Tables with no file are included.
   c. If all seven tables are closed, the date is skipped entirely.
   d. Otherwise, stream all 1,440 minute-buckets from Tardis for the needed tables.
   e. Flush batches of 10,000 messages per table to vault during streaming.
   f. After the stream ends, flush any remaining messages and close each table's vault file.

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
      GET /files/:table for each of the 7 tables
      closed → skip
      open   → DELETE /files/:table/:date, then include
      absent → include
    if no tables needed: skip date
    streamDate(date, tables):
      for offset = 0..1439:
        GET Tardis API (all needed channels in one request)
        parse each line → { table, msg: { action, date, data } }
        accumulate per-table; flush to vault when batch hits 10,000
    for each table: flush remaining + POST /files/:table/:date/close

Scheduling:
  setTimeout to next UTC midnight → repeat
```
