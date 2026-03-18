# History Service - Technical Documentation

## Overview

The History service fetches historical data from the BitMEX REST API and writes it directly to MongoDB. It does **not** go through the RabbitMQ pipeline (no Codec, no Writer) — this is an intentional deviation from the other services, because the history data needs to be searchable and filterable by any field, which is incompatible with the compressed binary format used by that pipeline.

The service iterates through a fixed list of public, paginated REST endpoints (called "tables"), fetching pages of the maximum allowed size and upserting each row into a dedicated collection per table.

Once all tables are exhausted, the service enters a slow-poll mode and continues cycling at a much lower rate to pick up any new records that have appeared since the last full pass.

---

## Confirmed Public Endpoints

Testing performed against `https://www.bitmex.com/api/v1` on 2026-03-17. These are the endpoints that:
1. Are **publicly accessible** (no API key required, `security: []` in Swagger)
2. Accept `count`, `start`, and `reverse` query parameters for historic pagination

| # | Table name        | REST Path                      | Max `count` | Oldest record                | Symbol param              |
|---|-------------------|-------------------------------|-------------|------------------------------|--------------------------|
| 1 | `chat`            | `/chat`                       | 500         | ~2020 (uses `date` field)    | none                     |
| 2 | `funding`         | `/funding`                    | 500         | 2016-05-07                   | optional                 |
| 3 | `compositeIndex`  | `/instrument/compositeIndex`  | 1000        | 2017-03-14                   | **required** (iterate)   |
| 5 | `insurance`       | `/insurance`                  | 500         | 2016-02-28                   | none                     |
| 6 | `quote`           | `/quote`                      | 1000        | 2019-06-01 (per symbol)      | **required** (iterate)   |
| 8 | `settlement`      | `/settlement`                 | 500         | 2015-05-01                   | optional                 |
| 9 | `trade`           | `/trade`                      | 1000        | 2014-11-06                   | optional                 |
> **Note on `/instrument`:** Not stored as a collection. Fetched on startup to build the symbol list for `/quote` and `/instrument/compositeIndex`.

> **Note on `chat`:** Records use a `date` field instead of `timestamp`. Included — systematic collection of chat data enables sentiment analysis (bot activity, potential whale signals) that is only possible with large volumes of historical data.

> **Note on `/quote`:** Requires a `symbol` filter. The service iterates through all active symbols fetched from `/instrument`.

> **Note on `/instrument/compositeIndex`:** Requires a `symbol` filter. The service iterates through index symbols returned by `/instrument` where the symbol starts with `.`.

---

## Rate Limiting

The `x-ratelimit-limit` response header is the authoritative source for the current limit. During testing (2026-03-17) it consistently reported **180 req/min** for unauthenticated requests. The API documentation states 120/min (auth) and 30/min (guest) — the headers are more accurate and take precedence.

The window uses a **rolling 60-second** mechanism: `x-ratelimit-reset` is a Unix timestamp indicating when the next single slot opens (i.e. when the oldest counted request falls off), not when the full budget resets. It gives no useful information about when the budget will be substantially replenished.

### Strategy

- Tables are fetched **in parallel** — each table runs its own async loop. Within a single table, symbols are iterated **sequentially**. Within a symbol, pages are fetched sequentially.
- Each fetcher self-regulates based on `x-ratelimit-remaining` from its own responses. No shared state or coordination between fetchers is needed — they all see the same server-side counter and converge naturally.
- After each successful response, `waitIfNeeded(res)` sleeps for `Math.max(0, 100 - remaining) * 500ms`. At `remaining=100` there is no delay; at `remaining=0` the delay is 50 seconds. This creates an automatic incremental back-off proportional to how close the budget is to exhaustion.
- On HTTP 429: sleep 60 seconds (fixed), then retry. No header inspection needed — this is a hard back-off to avoid escalating penalties.
- On any other non-ok HTTP response: sleep 3 seconds, then retry.

---

## Table Configuration

Each table is described by a configuration object. This is what varies per table; the fetch-paginate-write loop is identical for all.

All tables are fetched with a fixed page size of **500 rows** — the lowest confirmed maximum across all included tables. Using a common value simplifies the implementation and avoids per-table branching. The `Max count` column in the endpoints table above documents what each endpoint actually supports; 500 is the chosen implementation constant.

```ts
interface TableConfig {
  name: string;                                     // Table name, used as the MongoDB collection name
  path: string;                                     // REST API path, e.g. '/trade'
  auth: false;                                      // All tables covered here are public
  symbolSource: null | 'instruments' | 'indices';   // null = single pass; otherwise iterates symbol list
  idFields: string[] | null;                        // Fields used as MongoDB _id; null = insert-only
  maxStart: number | null;                          // API hard limit on start offset; null = no limit (chat)
}

const PAGE_SIZE = 500; // applied uniformly to all tables
```

### API Offset Limits

BitMEX enforces a maximum `start` offset per endpoint. Experimentally confirmed (2026-03-18):

| Endpoint                        | Max `start` |
|---------------------------------|------------|
| `/trade`                        | 100,000    |
| `/quote`                        | 2,500,000  |
| `/funding`                      | 2,500,000  |
| `/insurance`                    | 2,500,000  |
| `/settlement`                   | 2,500,000  |
| `/instrument/compositeIndex`    | 2,500,000  |
| `/chat`                         | no limit observed |

Exceeding the limit returns HTTP 400: `"Maximum start is N. Please use the startTime & endTime params to paginate."` Tables with enough data to exceed their limit require time-block pagination (see [Time-Block Pagination](#time-block-pagination)).

Every document written by this service includes a `_seq` field (`fetch_start + local_index_within_page`), regardless of table. For tables where timestamp alone is a sufficient sort key, `_seq` is redundant but harmless. Consumers choose to use it or not. See [Replay Ordering](#replay-ordering) for per-table details.

For endpoints that require a symbol, the service first fetches the current list of active instruments from `/instrument` (filtering `state !== 'Unlisted'`) and then iterates through each symbol, treating each as an independent sub-table with its own pagination cursor.

---

## Data Storage

Each row from the API is stored as an individual document in a per-table MongoDB collection. There is no grouping, envelope, or wrapping — rows are written exactly as they come from the REST response.

### Collections

| Collection name      | Source endpoint                      | Notes                                          |
|---------------------|--------------------------------------|------------------------------------------------|
| `chat`              | `/chat`                              |                                                |
| `funding`           | `/funding`                           |                                                |
| `compositeIndex`    | `/instrument/compositeIndex`         |                                                |
| `insurance`         | `/insurance`                         |                                                |
| `quote`             | `/quote`                             | One collection for all symbols                 |
| `settlement`        | `/settlement`                        | One collection for all symbols                 |
| `trade`             | `/trade`                             | One collection for all symbols                 |

### Natural Keys (MongoDB `_id`)

Keys sourced from the live WebSocket `partial` messages via the snapshots service (`GET /snapshot/<table>`). The WebSocket is the authoritative source — BitMEX sends these keys explicitly so consumers know how to dedup/merge updates.

| Collection          | WS keys                    | Notes |
|--------------------|----------------------------|-------|
| `chat`             | `[ id ]`                   | |
| `funding`          | `[ timestamp, symbol ]`    | |
| `compositeIndex`   | *(not in WS)*              | Not observed as a WebSocket table. Swagger only marks `timestamp` as required, but multiple constituents share the same timestamp. Likely `{ timestamp, symbol, reference }` where `reference` is the contributing exchange — needs verification against real REST data before implementing. |
| `insurance`        | `[ currency, timestamp ]`  | |
| `trade`            | `[]` — insert-only, no unique field | `trdMatchID` appears in the WS keys and is a GUID join key between `trade` and `execution`. However, confirmed empirically (2026-03-18): `trdMatchID` is `null` for a large fraction of trade records (partial fills and certain trade types). Using it as `_id` silently collapses all null-keyed rows into a single document. Trade is therefore treated as keyless — auto-generated MongoDB `_id`, same as `quote`. |
| `quote`            | `[]` — insert-only, no unique field | No unique field. `_seq` is the sole dedup mechanism; relies on pagination stability. The table only goes back to 2019 despite earlier data existing for other tables — suggesting BitMEX prunes old quote entries. If they prune again, offsets shift and `_seq` values from a prior run become invalid; detecting or recovering from this would require manual intervention (e.g. comparing timestamps at the cursor boundary). Within a single continuous run of the service, `_seq` is a reliable identifier. |

> For keyed tables, upserts on the natural key make re-fetching a page after a restart completely safe. For `trade` and `quote` — both keyless — the `_state` cursor is the only guarantee: the service writes a page once and advances the cursor atomically before the next request. Re-fetching these pages would produce undetectable duplicates. `_seq` helps with ordering but does not solve dedup — it assumes pagination is stable.

---

## Replay Ordering

> **This section documents the problem and proposed approaches. The final solution will be decided when implementing the replay layer.**

### The Problem

Natural keys dedup records but do not preserve order. `timestamp` seems like the obvious sort key, but BitMEX generates many events at the same millisecond — dozens of trades, multiple quotes — and there is no way to determine intra-millisecond ordering from the timestamp alone.

BitMEX's own pagination (`start` offset, `reverse=false`) returns records in a stable, deterministic order that represents their canonical chronological sequence. This is the only reliable ordering signal available from the REST API.

### Proposed Solution: Store `_seq` on Every Document

When writing each document, store a `_seq` field equal to the absolute offset of that record within its table:

```
_seq = fetch_start + local_index_within_page
```

For a page fetched with `start=5000`, the 7th item gets `_seq=5006`. This is computable directly from the fetch parameters — no global counter is needed.

For replay, sort by: **`timestamp` (primary), `_seq` (secondary)**. Timestamp determines the rough chronological position; `_seq` breaks ties deterministically within the same millisecond.

### Per-Table Notes

| Collection        | Ordering strategy | Notes |
|------------------|-------------------|-------|
| `chat`           | `id` only | `id` is a sequential integer that IS the canonical order. No `_seq` needed — `id` doubles as natural key and order. |
| `funding`        | `timestamp` | Funding settles every 8h; same-millisecond collisions within a symbol are not possible. Multiple symbols at the same timestamp are independent. |
| `compositeIndex` | `timestamp` + `_seq` | Multiple constituent exchanges contribute at the same timestamp for the same index symbol. `_seq` needed. |
| `insurance`      | `timestamp` | One entry per currency per event. Timestamp alone is likely sufficient. |
| `quote`          | `timestamp` + `_seq` | Very high frequency — many quotes per millisecond. `_seq` essential for both ordering and dedup (no unique field). |
| `settlement`     | `timestamp` | Rare events; same-millisecond collisions per symbol unlikely. |
| `trade`          | `timestamp` + `_seq` | Very high frequency — many fills per millisecond. `_seq` for ordering only; `trdMatchID` used as `_id` so dedup is handled by upsert. |

### Cross-Table Replay

When replaying multiple tables together (e.g. `trade` + `quote`), align by `timestamp` window. Within the same millisecond, the relative ordering between events from different tables (a trade vs. a quote at the same ms) is **unknowable from REST data** — events in different tables have independent `_seq` spaces. This is an inherent limitation of the REST API and not solvable without the WebSocket stream.

### Stability of BitMEX Pagination

The `_seq` approach assumes BitMEX's pagination is stable — that `start=5000` always returns the same record at offset 5000. This is almost certainly true (the history is immutable), but if it were ever violated, `_seq` values would be wrong for ordering while natural keys would still ensure correctness for deduplication. The two concerns are deliberately separated.

---

## Persistence & Resume (`_state` collection)

Fetching the full history will take **days**. The service must be able to stop for any reason (crash, redeploy, maintenance) and resume exactly where it left off, without re-fetching already-written data.

A MongoDB collection called `_state` tracks the state of every sub-table. Each document represents one sub-table:

```ts
interface HistoryState {
  _id: string;                      // sub-table key, e.g. 'trade', 'quote:XBTUSD'
  start: number;                    // next start offset to fetch within the current block
  exhausted: boolean;               // true when no more rows are available
  lastFetchedAt: Date;              // wall-clock time of last successful fetch (monitoring only)
  totalFetched: number;             // cumulative row count across all blocks (monitoring only)
  firstTimestamp: string | null;    // timestamp of the very first row ever (start=0, count=1); used for drift detection
  block: number;                    // current time-block index (0-based); 0 = no startTime filter
  blockStartTime: string | null;    // startTime API parameter for the current block; null for block 0
  lastSeenTimestamp: string | null; // timestamp of the last successfully saved row; seeds in-memory lastTimestamp on resume
}
```

On startup, the service reads all existing `_state` documents and resumes from the recorded `start` values. Sub-tables with no document start from `0`.

For any sub-table that has a recorded `firstTimestamp`, the service verifies it on resume by fetching `start=0, count=1` and comparing. If the timestamp does not match, **the service fails immediately** with a clear log message indicating which sub-table has drifted and manual intervention is required. This detects BitMEX pruning old data (shifting offsets), which would silently corrupt `_seq`-based ordering for keyless tables like `quote`.

After each successful page write, the state document is upserted atomically before the next request is made.

---

## Pagination & Exhaustion Detection

The service paginates forward using `start` + `count` (offset-based). Pagination is done oldest-first (`reverse=false`).

A table is considered **exhausted** when:
- The response returns fewer rows than the requested `count`, OR
- The response returns 0 rows

When exhausted, the `_state` document is updated with `exhausted: true` and the service moves to the next table. After all tables are exhausted, it enters **slow-poll mode**.

---

## Architecture

```
History Service
  │
  ├─ On startup:
  │    1. Create PersistenceService (all MongoDB access goes through this)
  │    2. Load sub-table state from _state collection via PersistenceService
  │    3. Fetch active symbols from /instrument
  │    4. Verify firstTimestamps for all sub-tables that have one
  │
  └─ Per-table loop (tables run in parallel):
       for each symbol in (table.symbolSource === 'instruments' ? instruments
                         : table.symbolSource === 'indices'     ? indices
                         : [null]):
         sub-table key = table name or 'table:SYMBOL'
         skip if exhausted
         bind a SubTablePersist handle (captures db + state + table config)
         while not exhausted:
           fetch page (start=cursor, count=500, reverse=false)
           waitIfNeeded(res):
             429            → sleep 60s, retry
             other non-ok  → sleep 3s, retry
             ok, remaining → sleep Math.max(0, 100 - remaining) * 500ms
           write documents via SubTablePersist (upsert or insert depending on idFields)
           flush state via SubTablePersist (advance cursor, persist to _state)
           if rows received < 500 → mark exhausted, flush, return
       (symbols within a table are sequential)
     → when all table loops exhausted: enter slow-poll mode
           re-fetch active symbols from /instrument
           verify firstTimestamps → mismatch = halt (manual intervention required)
           reset exhausted=false for all sub-tables
           restart main loop
```

---

## Configuration (`config.ts`)

Loaded from environment variables, validated on startup.

| Env var                         | Required | Default   | Description                                       |
|---------------------------------|----------|-----------|---------------------------------------------------|
| `MONGODB_URL`                   | yes      | —         | MongoDB connection URL                            |
| `HISTORY_DATABASE`              | yes      | —         | MongoDB database name                             |
| `BITMEX_TESTNET`                | no       | `false`   | Use testnet API if `1` / `on` / `true`            |

---

## Service Kit Integration

Uses `SKFactory` with MongoDB only (no RabbitMQ):

```ts
SKFactory({
  name: 'history',
  mongodb: true,
}).declare({ config });
```

---

## Package

```
@tradebot/history
```

Dependencies:
- `@devvir/bitmex-api` — typed REST client and schemas
- `@devvir/service-kit` — service lifecycle, MongoDB
- `@tradebot/utils` — `SKFactory`, URL utilities

---

## Time-Block Pagination

> **Not yet implemented.** This section documents the agreed design for stage 2.

Some tables have enough data to exceed the API's maximum `start` offset (e.g. `/trade` at 100,000). When that happens, the API returns HTTP 400. Time-block pagination handles this transparently for any table — enabled per-table via `maxStart` in `TableConfig`; `null` means no limit (e.g. `chat`).

### Concept

A **time block** is a window of rows fetched with a fixed `startTime` anchor. Within each block, normal offset pagination (`start` + `count`) is used. When the offset approaches `maxStart`, the block closes and a new one opens anchored to the first new timestamp seen in the page.

### In-Memory State

Each running fetcher tracks `lastTimestamp: string | null` — the timestamp of the last row it successfully saved. This is seeded from `state.lastSeenTimestamp` on resume (so a restart near a block boundary behaves identically to uninterrupted operation). On first fetch, `lastTimestamp` is null and is set from the first row without triggering any transition logic.

### Block Transition Algorithm

After saving each page, if `table.maxStart !== null` and `state.start > table.maxStart - 1000`:

**Normal case** — a new timestamp is seen in the page:
1. Save all rows up to (not including) the first row where `row.timestamp > lastTimestamp`
2. Use that row's timestamp as `blockStartTime` for the new block
3. Drop that row — the fetcher will re-deliver it as the first row of the new block
4. Increment `block`, set `blockStartTime = row.timestamp`, reset `start = 0`, flush state
5. Tell fetcher: `{ startTime: row.timestamp, start: 0 }`

**Fallback case** — no timestamp change found in the page and `start + PAGE_SIZE >= maxStart`:
1. Save all rows in the page normally
2. Use `lastTimestamp + 1ms` as the anchor for the new block
3. Increment `block`, set `blockStartTime = lastTimestamp + 1ms`, reset `start = 0`, flush state
4. Tell fetcher: `{ startTime: lastTimestamp + 1ms, start: 0 }`

The fallback may lose a small number of rows at the exact boundary millisecond (those already saved will be re-fetched and are duplicates for keyless tables; keyed tables handle it safely via upsert). This is an acceptable trade-off — it avoids the certainty of re-fetching an entire block's worth of rows.

### `_seq` with Time Blocks

```
_seq = block * BLOCK_LIMIT + start + i
```

`BLOCK_LIMIT` is a constant set larger than `maxStart` (e.g. 100,000 for `/trade`). `_seq` values have gaps at block boundaries — this is intentional and not a problem for ordering.

### Drift Check

On resume, only `blockStartTime` of the current block needs to be verified — fetch one row with `startTime = blockStartTime, start = 0` and confirm the timestamp matches. Older blocks are immutable and unaffected by any future data pruning.
