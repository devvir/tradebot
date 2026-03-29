# Scribe Service — Technical Documentation

## Overview

Fetches historical data from the BitMEX REST API and writes it to the vault service as date-partitioned CSV files. Tables run in parallel. Within each table, days are processed sequentially. Once caught up to today, the service sleeps until UTC midnight and then continues.

---

## Tables

| Table name       | REST path                     | Symbol iteration       |
|------------------|-------------------------------|------------------------|
| `compositeIndex` | `/instrument/compositeIndex`  | per index symbol       |
| `funding`        | `/funding`                    | none                   |
| `insurance`      | `/insurance`                  | none                   |
| `settlement`     | `/settlement`                 | none                   |

`/instrument` is fetched to build the index symbol list for `compositeIndex`. It is not written to vault.

All tables use `reverse=false` (oldest-first). Page size is 500 rows for all tables except `compositeIndex`, which uses 1,000. Each day is fetched with `startTime = midnight of that day` and `endTime = midnight of the following day`. The current day is never written to vault — processing pauses at today's date and resumes after midnight.

---

## Rate Limiting

The `x-ratelimit-remaining` response header is checked after every response. When remaining drops below 100, the service sleeps `(100 - remaining) * 500ms`. HTTP 429 triggers a 60s sleep; other non-ok responses trigger a 3s sleep before retry.

---

## Output Format (Vault)

Each table is written as daily CSV files via the vault service:

```
vault://<table>/<yyyy>/<yyyymmdd>.csv.gz
```

Files transition from `open` (being written) to `closed` (finalized and compressed) once all data for that day has been confirmed.

For `compositeIndex`, all symbols are processed sequentially for each day before the file is closed. Symbol order is determined by registry ID ascending, so the ordering is stable across restarts.

---

## Startup Bootstrap

On startup, scribe derives its resume point from the vault file listing for each table:

1. `GET /files/:table` — list all files
2. Delete any `open` files (incomplete from a previous run)
3. Resume from the day after the latest `closed` file
4. If no closed files exist (first run), probe each task for its oldest available row via a single `start=0, count=1` request to find the actual data start date

No separate state store is used.

---

## Time-Block Pagination

BitMEX enforces a maximum `start` offset per endpoint (2,500,000 for all current tables). Exceeding it returns HTTP 400. The row iterator handles this transparently: when `start` approaches the limit (`> maxStart - pageSize`), it advances `startTime` to the last seen row's timestamp and resets `start = 0`. This is invisible to the caller — the day fetch sees an uninterrupted stream of rows.

---

## Architecture

```
Startup (per table, in parallel):
  1. GET /files/:table — list vault files
  2. DELETE any open files
  3. If closed files exist: resume from dayAfter(latestClosed)
  4. If no closed files: probe each task's oldest row to find initialDate

Per-table loop:
  loop:
    if currentDate >= today: sleep until UTC midnight
    tasks = all symbols (compositeIndex) or [default] (others)
    for each task:
      skip if task's next date > currentDate
      fetch all rows for currentDate (startTime=day, endTime=nextDay, reverse=false)
      buffer rows, flush to vault every 1,000 rows
      if day was empty: probe next populated row date
    POST /files/:table/:currentDate/close
    currentDate = nextDay(currentDate)
```
