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

## Rate Limiting — Identities

BitMEX rate-limits anonymous ("guest") requests at 180/min per IP and authenticated requests at 120/min per account. The buckets are independent and refill continuously over a one-minute moving window. Scribe runs one **identity** per bucket — always a guest, plus one authenticated identity per credential pair in `SCRIBE_IDENTITIES` — and spreads its page fetches across all of them, so the effective ceiling is the sum of every bucket's refill rate (e.g. guest + two accounts = 180 + 120 + 120 = 420/min). Each identity is an SK fetch client carrying its own retries, timeout, and (for accounts) HMAC request signing; an account that BitMEX rejects at startup (401/403) is dropped.

Two pieces govern throughput, deliberately decoupled:

- **Routing.** Each request goes out as the identity with the most estimated budget, where budget is the last reported `x-ratelimit-remaining` plus the refill accrued since. On dispatch that identity's estimate is **decremented by one** — counting the in-flight request immediately so the next pick (the page pipeline runs several ahead) fans out to other buckets instead of stacking on the same one; the next response re-anchors the estimate to the real header value, so the imprecision is bounded and self-correcting. A drained identity is simply skipped, and a 429 zeroes its bucket so the picker moves off it at once.
- **Pacing.** After each response the worker waits `(waterline − combinedBudget) × pace_ms` (currently 60 and 500ms), and *only* when the **combined** budget across every identity has fallen below the waterline — while the pool still has budget, no one waits. The total is the right measure because routing pools the budget: three buckets at 30/25/25 are 85 of headroom and keep fetching even though no single one is high. The wait is per-worker, never a shared stop, so other in-flight requests keep the pipe full while one paces. The one legitimate reason to stop fetching is the rate limit itself — i.e. the whole pool running dry — and that is exactly when every worker pauses.

A 429 is handled in the fetch loop, not retried on the same client: the bucket is zeroed (it climbs back via the refill estimate), logged, and the request re-picks — routing straight to a bucket that still has budget, with `pace()` as the backstop when *all* are dry. 502/503/504 are retried inside the SK client with capped backoff; any other non-ok status logs and sleeps 3s before retry.

Beyond ~6–7 identities a second ceiling appears: the combined refill rate exceeds what `PAGES_PER_BATCH` parallel requests can issue at the prevailing round-trip latency. At that point the batch size is the lever to raise, independently of pacing.

---

## Output Format (Vault)

Each table is written as daily CSV files via the vault service:

```
vault://<table>/<yyyy>/<yyyymmdd>.csv.gz
```

Files transition from `open` (being written) to `closed` (finalized and compressed) once all data for that day has been confirmed.

For `compositeIndex`, all symbols are processed sequentially for each day before the file is closed. Symbol order is determined by an ID assigned on first sight and persisted in the Redis hash `scribe:indices` (symbol → id), so the ordering is stable across restarts. Newly discovered indices are appended with the next sequential ID.

---

## Startup Bootstrap

On startup, scribe determines the resume date for each task (one task per table, except `compositeIndex` which has one task per index symbol):

1. `GET /files/:table` — list all files
2. Delete any `open` files (incomplete from a previous run)
3. Read the task's last-saved progress date from Redis (key `scribe_<table>_<id>`)
4. The lower bound is the later of `SCRIBE_START_DATE` and the cached date
5. With a lower bound: walk forward through the closed-file set, returning the first date that has no closed file
6. Without a lower bound (no cache, no env var): probe BitMEX with a single `start=0, count=1` request to find the symbol's first available row, cache it, and start there
7. If the lower bound is already today or later, the task is caught up; the runner sleeps until UTC midnight

The earliest resume date across all tasks for a table becomes the table's loop entry point.

---

## Page Fetching — Bounded Ring Pipeline

The row iterator streams pages through a bounded ring of `MAX_IN_FLIGHT` (10) slots. Each turn it `await`s the **oldest** outstanding request — the one with the most time to have finished, usually already resolved — flushes its rows, then launches the next offset into that freed slot. So up to `MAX_IN_FLIGHT` requests stay productive, but the iterator is never more than `MAX_IN_FLIGHT` pages ahead of the oldest unflushed one. Because slots fill and drain in the same order, flushing is FIFO — output is byte-identical to a sequential fetch, deterministic across runs.

This is a pipeline, not a barrier: a slow page (or one a worker is pacing/retrying) only holds its own slot while the others keep flowing; nothing waits on a whole batch at once. The only thing that idles the pipeline is the rate limit — i.e. the shared budget pool running dry (see Pacing).

## Time-Block Pagination

BitMEX enforces a maximum `start` offset per endpoint (2,500,000 for all current tables), and also an undocumented cap that can surface earlier as a short/empty page. The iterator walks offsets in order within a `startTime`-block and transitions when a window ends:

- **Offset cap:** launches stop once `start` would exceed `maxStart`, so the iterator never speculatively fetches past the cap. Once the in-flight pages up to it drain, the block reanchors.
- **Window exhausted:** a short or empty page in offset order ends the block. If the block made progress and a `tsField` is present, `startTime` reanchors to the last row's `tsField` and a fresh window opens at `start = 0`; otherwise the data is exhausted and iteration ends.
- **No-progress safeguard:** if the reanchor target does not move strictly past the current anchor (a backfill burst sharing one `tsField` instant), `startTime` is stepped `+1ms` so the window can't refetch itself forever.

`tsField` is `logged` for compositeIndex (BitMEX sorts/filters that table on insertion time) and `timestamp` (falling back to `date`) otherwise; the reanchor and the day cut both key off it. Look-ahead still in flight when a block ends is abandoned by returning — overshooting a few pages is cheap and keeps the output ordered.

---

## Architecture

```
Startup (per table, in parallel):
  1. GET /files/:table — list vault files
  2. DELETE any open files
  3. tasks = all index symbols (compositeIndex) or [default] (others)
  4. For each task, compute the start date:
       boundary = latest(SCRIBE_START_DATE, redis cached date)
       if boundary >= today           → today (caught up)
       else if boundary               → first date >= boundary not in closed-file set
       else                           → probe BitMEX oldest row, cache it
  5. initialDate = min(start dates across tasks)

Per-table loop:
  loop:
    if currentDate >= today: sleep until UTC midnight
    for each task:
      skip if task's next date > currentDate
      fetch all rows for currentDate (startTime=day, endTime=nextDay, reverse=false)
        — each iteration of rowIterator issues 10 page fetches in parallel
      buffer rows, flush to vault every 10,000 rows (writes pipelined: next batch
        is collected in parallel with the previous write)
      if day was empty: probe next populated row date
    POST /files/:table/:currentDate/close
    currentDate = nextDay(currentDate)
```
