# Distiller Service — Technical Reference

## Overview

```
MongoDB tradebot
  ├─ trade          ──→ distiller ──→ tradeBin1m / tradeBin5m / tradeBin1h / tradeBin1d
  ├─ quote          ──→ distiller ──→ quoteBin1m / quoteBin5m / quoteBin1h / quoteBin1d
  ├─ orderBookL2    ──→ distiller ──→ orderBook10 / orderBookL2_25
  ├─ compositeIndex ──┐
  ├─ funding        ──┤ distiller ──→ instrument
  ├─ settlement     ──┤
  ├─ quote          ──┤
  └─ trade          ──┘
  ├─ (every table above) ──→ distiller ──→ _partials_ (daily snapshots)
```

Distiller is a batch service. It reads raw document collections written by the
collector and produces derived collections: OHLCV bins for trade and quote data,
order book snapshots at two depths (top-10 and top-25) derived from the full L2
stream, reconstructed historical instrument WebSocket messages, and per-table
daily snapshots (`_partials_`) that let consumers seed a live state at any day
boundary without replaying the full history.

## Processing Loop

All derivations run as parallel infinite loops. Each loop is driven by a `DateWalker`
that blocks until the next ready date:

```
parallel:
  distillTrades:    for each date from walker → generate 1m / 5m / 1h / 1d bins
  distillQuotes:    for each date from walker → generate 1m bins, then coarser copies
  distillOrderBook: batch replay of L2 delta stream
  distillInstrument: daily partials + event-driven updates from 5 vault sources
  distillPartials:  per-table daily snapshots into `_partials_`
```

### DateWalker

`dateWalker(target, source)` is a blocking infinite iterator. It watches two sets of
Redis keys to find dates ready for processing:

- **Customs markers** (`customs:{source}:{date}` = `'done'`): owned by Registrar.
  A `'done'` value is the post-MongoDB confirmation — every message for that bucket
  has been successfully inserted. The walker yields a date as soon as it is customs-done
  in every required source; no hold or drain time is needed because `'done'` already
  proves the data is in MongoDB.
- **Distiller markers** (`distiller_{target}_{date}`): written by the walker itself when
  the caller calls `next()` for the following date. A date already marked done is skipped.
  Before yielding any candidate, the walker does a cheap `GET` on that key to guard against
  a stale distCache — if the key is already set, the cache is force-expired and the scan
  repeats immediately.

When the caller calls `next()`, the walker atomically marks the *previous* date as done
before scanning for the next one. This means: if the service crashes mid-day, the
incomplete day is not marked done and will be re-processed on restart. Every generator
is idempotent — re-running a date overwrites or silently skips duplicates.

When no date is ready, the walker sleeps 30 seconds and retries.

### Shutdown

The service uses a best-effort shutdown pattern. Each distiller increments a shared
`distillers` counter before entering its loop, checks a `stopping` flag at the start of
each iteration, and decrements + breaks when the flag is set. The shutdown handler sets
`stopping = true` and waits for `distillers` to reach zero. If a distiller does not notice
the flag in time, the OS sends SIGKILL after ~30 seconds.

## Trade Distillation

For each date from the walker, four bin sizes are generated in order: 1m → 5m → 1h → 1d.

### raw → tradeBin1m

Aggregates raw `trade` documents for the calendar day into 1-minute OHLCV bins using a
MongoDB `$group` / `$merge` pipeline. Trade timestamps are mid-period (the trade at
00:05:00 belongs to the 00:05 minute, not 00:04), so the match range is `[from, to)`.
Bins are timestamped at end-of-period: the 1m bin for 00:04 has `timestamp=00:05:00.000Z`.

### tradeBin1m → 5m/1h/1d

Rolls up the 1m bins for the same calendar day into coarser sizes using `$group` /
`$merge`. Bin timestamps are end-of-period, so they must be shifted back by 1ms before
truncating to avoid off-by-one grouping at boundaries.

### Open correction — patchBoundaries

BitMEX defines `open` as the previous bin's close, not the first trade's price. Within
a day, `$setWindowFields $shift` wires this up in the aggregation pipeline. Across day
boundaries (where two independently-processed days meet), a post-aggregation patch step
is needed.

After generating bins for a day N, `patchBoundaries` runs for each bin size. It finds
all symbols that appear in day N, then for each symbol:

1. **Anchor patch**: patch the open of day N's first bin using day N-1's last close
   (day N was just generated; day N-1 was processed earlier).
2. **Peek patch**: patch the open of day N+1's first bin using day N's last close
   (day N+1 may have been processed out of order before day N).

Both patches are scoped to symbols that appear in day N — the only bins our run could
have affected. The anchor-and-peek pattern means processing N → N+1 and processing
N+1 → N both produce identical final documents.

## Document Shapes

### Trade bins

Each trade bin records:

| Field | Description |
|---|---|
| `_id` | `_id` of the first source trade in the bin |
| `timestamp` | End of the period (ISO 8601) |
| `symbol` | Instrument symbol |
| `open/high/low/close` | Prices |
| `trades` | Number of individual trades |
| `volume` | Total quantity |
| `vwap` | Volume-weighted average price (omitted if volume = 0) |
| `lastSize` | Size of the last trade |
| `turnover/homeNotional/foreignNotional` | Present when source has them |

### Quote bins

Each quote bin records:

| Field | Description |
|---|---|
| `_id` | `max(_id)` of the ask and bid source documents |
| `timestamp` | End of the minute period (start of the next minute, ISO 8601) |
| `symbol` | Instrument symbol |
| `bidPrice` / `bidSize` | Last bid seen in the period (omitted if none) |
| `askPrice` / `askSize` | Last ask seen in the period (omitted if none) |
| `pool` | Always `"Primary"` |

### orderBookL2 → orderBook10 / orderBookL2_25

Replays the L2 order book delta stream in `_id` order, maintaining a per-symbol
in-memory book using the `bitmex-database` table implementation. Both output
collections are produced simultaneously — top-10 and top-25 are extracted on each
message.

After each message, the top N bids and asks for the affected symbol are extracted
and compared to the previous snapshot for that symbol. A new document is written
only when the top N changed:

| Field | Description |
|---|---|
| `_id` | `_id` of the source `orderBookL2` document |
| `symbol` | Instrument symbol |
| `bids` | Top-N `[price, size]` pairs, best bid first |
| `asks` | Top-N `[price, size]` pairs, best ask first |
| `timestamp` | From the source document |

`partial` messages seed the in-memory book but are only written to the output
collections when they cause a change in the top N.

**Resume:** the in-memory book is rebuilt from scratch on each run, starting from the
minimum of the last `_id` across `orderBook10` and `orderBookL2_25`. The book is
replayed in full from `_id = 0` to that point to restore correct state before emitting
new documents.

### instrument → instrument collection

Reconstructs historical BitMEX `instrument` WebSocket messages (daily `partial`
snapshots + event-driven `insert`/`update` deltas) from five vault sources:
`compositeIndex`, `quote`, `trade`, `funding`, and `settlement`. One document per
unique event; a daily `partial` at `00:00:00` snapshots all active instruments.

A symbol's first appearance in the vault stream produces an `insert` enriched with
semi-static fields from the nearest future Tardis snapshot (tickSize, lotSize,
multiplier, margin rates, etc.). Subsequent events produce `update` messages carrying
only the changed fields. Symbols with no Tardis record at any point are skipped with
a one-time warning.

On Tardis anchor dates (1st of month, 2019-04-01 onwards), the accumulator is reset
to the full Tardis snapshot before emitting the daily partial, giving accurate
anchor-point fields (`openInterest`, `impactPrices`). Between anchors, only
vault-derived fields are updated.

Before Tardis coverage (Dec 2016 → April 2019), the daily partial contains only
vault-derived fields. The data converges toward accuracy as Tardis anchors arrive.

See [instrument.md](../ai/Distiller/instrument.md) for the full technical design.

## Partials — Daily Snapshots

Partials are per-day, per-table snapshots of accumulator state stored in the
`_partials_` collection. Every supported BitMEX table (`orderBookL2`, `instrument`,
`trade`, `quote`, `funding`, `settlement`, `insurance`, and the eight trade/quote
bin sizes) is snapshotted independently. A consumer that wants the state of a table
at the start of day `D` reads `{table}-{D}` and can then consume the corresponding
source collection from the first message of day `D` onward — without replaying the
tail of the previous day.

Each stored document has the shape:

| Field | Description |
|---|---|
| `_id` | `{table}-{YYYY-MM-DD}` — `YYYY-MM-DD` is the day the snapshot opens (i.e. the day *after* the one just closed) |
| `table` | BitMEX table name |
| `date` | Same `YYYY-MM-DD` as the `_id` suffix |
| `keys` / `types` | Copied from the table spec; the accumulator's identity fields |
| `data` | The full item list at day boundary; every item's `timestamp` is `${date}T00:00:00.000Z` |

### Shapes

Tables are processed under one of two shapes, reflecting how the collector stored them:

- **`message`** — raw WebSocket envelopes (`orderBookL2`, `instrument`). Each source
  doc carries `{_id, timestamp, action, data}` and is replayed directly into a
  `bitmex-database` accumulator.
- **`item`** — flat per-item documents (`trade`, `quote`, `funding`, `settlement`,
  `insurance`, all bins). Each source doc is its own item and is applied as a
  single-item `insert`. With `wsPartialMode=true` these tables retain only the
  last item per symbol (or per currency for `insurance`), making the stored partial
  a "last-seen-per-symbol" log tail.

### Fresh start vs resume

On the first run, no stored partial exists:

- `item`-shape tables are seeded with an empty `partial` so subsequent inserts land
  in an indexed state.
- `message`-shape tables are left uninitialized; the library drops deltas until a
  `partial` message arrives in the source stream. This is the correct BitMEX WS
  semantics.

On every later run, the latest stored partial for the table is loaded and applied
as a `partial` message. Consumption then resumes from `_id > dayStartId(date) - 1`
in the source collection, using the same deterministic `dateOffset × 2^39` `_id`
layout as the registrar (epoch: 2000-01-01 UTC).

### Day-boundary emit

The driver walks source documents in `_id` order and tracks `currentDay`
(YYYY-MM-DD from each doc's `timestamp`). When a doc's day differs from
`currentDay`, the accumulator's snapshot is written as a `_partials_` document
for `currentDay`. Each emitted item's `timestamp` is rewritten uniformly to
midnight of the *next* day — the same moment the partial "opens".

A trailing partial is **never** written for an incomplete day. If the run reaches
the end of available source data mid-day, the in-memory state is simply dropped;
the next run will rebuild it from the prior stored partial plus any new source
docs.

### Bin midnight synthesis

Bin tables (`tradeBin*`, `quoteBin*`) rarely contain a bucket *exactly* at
midnight — the last bin of a day is typically `23:59`. When emitting a partial,
each per-symbol bin whose timestamp isn't already midnight is replaced by a
synthetic midnight entry:

- **Trade bins** — OHLC carried from the prior close (`close ?? vwap ?? 0`),
  and all volume-like fields (`volume`, `trades`, `turnover`, `homeNotional`,
  `foreignNotional`, `lastSize`) set to zero; `vwap` = close.
- **Quote bins** — bid/ask levels carried forward verbatim, only `timestamp`
  is updated.

This keeps partials anchored at a real, consistent moment across all tables,
and makes downstream consumers' day-boundary queries trivial.

### Duplicate handling

Partials are written with `insertOne` and E11000 (duplicate key) errors are
silently ignored — re-running a range is idempotent.

