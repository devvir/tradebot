# Scribe Service — Technical Documentation

## Overview

Fetches historical data from the BitMEX REST API and writes it to the vault service as date-partitioned CSV files. Tables run in parallel. Within each table, days are processed sequentially. Once caught up to today, the service sleeps until UTC midnight and then continues.

---

## Tables

| Table name        | REST path                    | Subtasks (symbols) | `filter`            | Notes                   |
|-------------------|------------------------------|--------------------|---------------------|-------------------------|
| `compositeIndex`  | `/instrument/compositeIndex` | per index symbol   | `{reference:BMI}`\* | `tsField: logged`       |
| `funding`         | `/funding`                   | none               | —                   |                         |
| `insurance`       | `/insurance`                 | none               | —                   |                         |
| `settlement`      | `/settlement`                | none               | —                   |                         |
| `tick`            | `/trade`                     | none               | `{size:0}`          | referential (index)     |
| `trade`           | `/trade`                     | per trading symbol | —                   | `from: 20260416`        |
| `quote`           | `/quote`                     | per trading symbol | —                   | `from: 20260414`        |

\* `compositeIndex` carries the BMI filter only when `SCRIBE_INDEX_TICK_ONLY` is set.

Each table is one entry in [settings.ts](../../services/scribe/src/utils/settings.ts). The runner is generic — it reads three optional fields and never names a table:

- **`symbols?`** — a resolver `(cache, baseUrl) => Promise<string[]>`. Present ⇒ the table fans out into one subtask per returned symbol (each carrying that `symbol` plus the table's static `filter`); absent ⇒ a single default task with no symbol. `compositeIndex` uses `getOrderedIndices` (the `.`-prefixed index symbols); `trade` and `quote` use `getTradingSymbols` (non-`.` symbols — referential symbols have no order book; their index prints are `tick`'s job, so the symbol filter is also what keeps referential prints out of `trade`). Both resolvers order their symbols by a **stable registration ID** held in a Redis hash (`scribe:indices` / `scribe:symbols`): a newly-listed symbol is appended with the next ID, so existing symbols never shift. That keeps a day's output reproducible — re-fetching it later yields a byte-identical file even if symbols listed in between, which is what makes regression diffs reliable. The list is computed at runtime, which is why this is a function rather than static data.
- **`filter?`** — the server-side BitMEX filter. `trade`/`quote` carry none: the unfiltered fetch returns both liquidity pools, each row tagged by its own `pool` column.
- **`from?`** — a hard `yyyymmdd` floor on the first date, combined with `SCRIBE_START_DATE`. `trade`/`quote` start at `2026-04-01`; earlier history is bulk-collected from S3 by the courier service. The floor sets only the initial position — once progress passes it, the saved cursor resumes forward.

`/instrument` is fetched to build the symbol lists; it is not written to vault.

All tables use `reverse=false` (oldest-first). Page size defaults to `PAGE_SIZE`; the high-volume tables (`compositeIndex`, `tick`, `trade`, `quote`) override `count` upward. Each day is fetched with `startTime = midnight of that day` and `endTime = midnight of the following day`. The current day is never written to vault — processing pauses at today's date and resumes after midnight.

---

## Rate Limiting — Identities

BitMEX rate-limits anonymous ("guest") requests at 180/min per IP and authenticated requests at 120/min per account. The buckets are independent and refill continuously over a one-minute moving window. Scribe runs one **identity** per bucket — always a guest, plus one authenticated identity per credential pair in `SCRIBE_IDENTITIES` — and spreads its page fetches across all of them, so the effective ceiling is the sum of every bucket's refill rate (e.g. guest + two accounts = 180 + 120 + 120 = 420/min). Each identity is an SK fetch client carrying its own retries, timeout, and (for accounts) HMAC request signing; an account that BitMEX rejects at startup (401/403) is dropped.

Two pieces govern throughput, deliberately decoupled:

- **Routing.** Each request goes out as the identity with the most estimated budget, where budget is the last reported `x-ratelimit-remaining` plus the refill accrued since. On dispatch that identity's estimate is **decremented by one** — counting the in-flight request immediately so the next pick (the page pipeline runs several ahead) fans out to other buckets instead of stacking on the same one; the next response re-anchors the estimate to the real header value, so the imprecision is bounded and self-correcting. A drained identity is simply skipped, and a 429 zeroes its bucket so the picker moves off it at once.
- **Pacing.** After each response the worker waits in proportion to how far the **combined** budget across all identities has dropped below `WATERLINE` — roughly `(WATERLINE − combinedBudget) × PACE_MS` — and only once it's below it; while the pool still has budget, no one waits. The total is the right measure because routing pools the budget: a few buckets each individually low can still sum to plenty of headroom and keep fetching. `WATERLINE` (set via `SCRIBE_RATE_WATERLINE`, default 100) is tuned to sit a comfortable margin above empty (so a burst never trips a 429) but well below the buckets' summed cap (so refill is never wasted at the top); `PACE_MS` sets how sharply the wait grows. The wait is per-worker, never a shared stop, so other in-flight requests keep the pipe full while one paces. The one legitimate reason to stop fetching is the rate limit itself — i.e. the whole pool running dry — and that is exactly when every worker pauses.

A 429 is handled in the fetch loop, not retried on the same client: the bucket is zeroed (it climbs back via the refill estimate), logged and counted, and the request re-picks — routing straight to a bucket that still has budget, with `pace()` as the backstop when *all* are dry. The same page is retried until it succeeds, so a 429 never drops data. 502/503/504 are retried inside the SK client with capped backoff; any other non-ok status logs and sleeps briefly before retry.

With enough identities a second ceiling appears: the combined refill rate can exceed what `MAX_IN_FLIGHT` concurrent requests can issue at the prevailing round-trip latency. That's a concurrency limit rather than a pacing one — `MAX_IN_FLIGHT` (the shared pool size, set via `SCRIBE_IN_FLIGHT`, default 20) is the lever to raise, independently of the waterline.

---

## Output Format (Vault)

Each table is written as daily CSV files via the vault service:

```
vault://<table>/<yyyy>/<yyyymmdd>.csv.gz
```

Files transition from `open` (being written) to `closed` (finalized and compressed) once all data for that day has been confirmed.

For per-symbol tables (`compositeIndex`, `quote`), all symbols are processed sequentially for each day before the file is closed. Symbol order is determined by an ID assigned on first sight and persisted in a Redis hash (`scribe:indices` for indices, `scribe:symbols` for trading symbols), so the ordering is stable across restarts. Newly discovered symbols are appended with the next sequential ID — existing symbols never move, so a re-fetched day is byte-identical to the original.

---

## Startup Bootstrap

On startup, scribe determines the resume date for each task (one task per table, except `compositeIndex` which has one task per index symbol):

1. `GET /files/:table` — list all files
2. Delete any `open` files (incomplete from a previous run)
3. Read the task's last-saved progress date from Redis (key `scribe_<table>_<id>`)
4. The lower bound is the later of `SCRIBE_START_DATE`, the table's `from` floor, and the cached date
5. With a lower bound: walk forward through the closed-file set, returning the first date that has no closed file
6. Without a lower bound (no cache, no env var): probe BitMEX with a single `start=0, count=1` request to find the symbol's first available row, cache it, and start there
7. If the lower bound is already today or later, the task is caught up; the runner sleeps until UTC midnight

The earliest resume date across all tasks for a table becomes the table's loop entry point.

---

## Page Fetching — Bounded Ring Pipeline

The row iterator streams pages through a bounded ring of `MAX_IN_FLIGHT` slots. Each turn it `await`s the **oldest** outstanding request — the one with the most time to have finished, usually already resolved — flushes its rows, then launches the next offset into that freed slot. So up to `MAX_IN_FLIGHT` requests stay productive, but the iterator is never more than `MAX_IN_FLIGHT` pages ahead of the oldest unflushed one. Because slots fill and drain in the same order, flushing is FIFO — output is byte-identical to a sequential fetch, deterministic across runs.

This is a pipeline, not a barrier: a slow page (or one a worker is pacing/retrying) only holds its own slot while the others keep flowing; nothing waits on a whole batch at once. The only thing that idles the pipeline is the rate limit — i.e. the shared budget pool running dry (see Pacing).

**Shared across tables.** Tables run concurrently, each with its own ordering ring, but they all draw from one service-wide pool of `MAX_IN_FLIGHT` slots ([pool.ts](../../services/scribe/src/bitmex/pool.ts)): a page takes a slot before it's dispatched and holds it **through pacing** — releasing only once the worker has finished its post-response wait, not merely when the response lands. That detail is load-bearing: a paced worker keeps its slot occupied, so when the budget is low and everyone is pacing, the pool admits fewer requests and global admission falls to the refill rate. Release the slot *before* pacing and, with ≥2 active tables, the freed slot is handed straight to another table's waiter that fires immediately — pacing throttles nothing and the pool admits at full concurrency, draining the budget into 429s. So the *total* in flight is capped at `MAX_IN_FLIGHT` however many tables are backfilling — a lone table saturates the pool, several share it fairly (a freed slot goes to the longest waiter), and pacing governs the rate identically regardless of table count. The ring size equals the pool size so the single-table case is unchanged.

## Time-Block Pagination

BitMEX enforces a maximum `start` offset per endpoint (the per-table `maxStart` — in the millions for most tables, lower for the high-volume `trade`/`tick` endpoints), and also an undocumented cap that can surface earlier as a short/empty page. The iterator walks offsets in order within a `startTime`-block and transitions when a window ends:

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
  3. tasks = table.symbols(...) → one per symbol, or [default] when no resolver
  4. For each task, compute the start date:
       boundary = latest(SCRIBE_START_DATE, table.from, redis cached date)
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
        — rowIterator streams pages through a ring of up to MAX_IN_FLIGHT in flight
      buffer rows, flush to vault past the buffer threshold
        (writes pipelined with the next page fetches)
      if day was empty: probe next populated row date
    POST /files/:table/:currentDate/close
    currentDate = nextDay(currentDate)
```
