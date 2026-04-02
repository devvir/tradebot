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

All derivations run in parallel once per cycle, then the service sleeps 1 hour:

```
while true:
  parallel:
    distillTrades      → phase 1 (raw → 1m) then phase 2 (1m → 5m/1h/1d)
    distillQuotes      → phase 1 (raw → 1m) then phase 2 (1m → 5m/1h/1d)
    distillOrderBook   → batch replay of L2 delta stream
    distillInstrument  → daily partials + event-driven updates from 5 vault sources
    distillPartials    → per-table daily snapshots into `_partials_`
  sleep 1h
```

Each derivation goes all the way to the tip in a single call — no artificial batching
between cycles. The first run after a long data gap processes the entire backlog before
sleeping.

## Trade — Two-Phase Derivation

### Phase 1 — raw → tradeBin1m

Aggregates raw source documents into 1-minute OHLCV bins using a MongoDB `$group`
pipeline, chunked by calendar day for memory efficiency. Progress is tracked by the
highest `_id` in `tradeBin1m` — on restart, processing resumes from there.

**Completeness guarantee:** the current calendar day is always skipped. A day is
confirmed complete by the existence of at least one document belonging to the following
day in the source collection. This ensures no 1m bin is ever built from a partial
minute's worth of data.

Phase 1 short-circuits when there are no complete days to process, in which case
phase 2 is skipped for that cycle.

### Phase 2 — tradeBin1m → 5m/1h/1d

Rolls up `tradeBin1m` into larger bins using the same `$group` / `$merge` pattern,
chunked by calendar year. Because phase 1 only produces complete-day data, every
coarser bin derived from it is guaranteed to be complete — no cutoff logic is needed.

Resume is independent of phase 1: it queries the last document in `tradeBin1d`, maps
back to the corresponding year boundary in `tradeBin1m`, and resumes from there.

## Transforms

### trade → tradeBin1m/5m/1h/1d

Groups trades into fixed time buckets aligned to UTC. Each bin records:

| Field | Description |
|---|---|
| `_id` | `_id` of the first source document in the bin |
| `timestamp` | End of the period (ISO 8601) |
| `symbol` | Instrument symbol |
| `open/high/low/close` | Prices |
| `trades` | Number of individual trades |
| `volume` | Total quantity |
| `vwap` | Volume-weighted average price (omitted if volume = 0) |
| `lastSize` | Size of the last trade |
| `turnover/homeNotional/foreignNotional` | Present when source has them |

### quote → quoteBin1m/5m/1h/1d

Quote distillation uses a different approach from trade distillation — there is no
aggregation across the source documents within a period. Instead, each bin is a
**snapshot**: the last-seen ask and the last-seen bid within the minute, which may
come from different source documents.

**Phase 1 — raw → quoteBin1m**

Iterates the `quote` collection in full-day batches. For each batch, a MongoDB
aggregation pipeline groups by `(minute, symbol)` and uses `$top` (sorted by `_id`
descending, nulling out missing sides) to independently find the highest-`_id`
document that had an `askPrice` and the highest-`_id` document that had a `bidPrice`.
The two are merged in TypeScript into a single `QuoteBin`.

Resume is driven by the latest timestamp in `quoteBin1m`. The start day for each run
reprocesses the last recorded day (crash-safe). The upper bound is derived from the
latest quote's timestamp: the current minute is always excluded to avoid generating a
bin from an incomplete minute.

**Phase 2 — quoteBin1m → 5m/1h/1d**

The coarser bins are not re-aggregated — they are verbatim copies of selected
`quoteBin1m` documents, filtered by timestamp pattern:

| Target | Condition |
|---|---|
| `quoteBin5m` | minute divisible by 5 (`HH:00`, `HH:05`, … `HH:55`) |
| `quoteBin1h` | minute = 00 (`HH:00:00.000Z`) |
| `quoteBin1d` | midnight (`T00:00:00.000Z`) |

Each run copies up to 10,000 new documents per target, resuming from the last
existing entry in each target collection.

Each bin records:

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

## Duplicate Handling

Trade bins use `$merge` with `whenMatched: 'replace'` — re-running a range produces
identical documents that overwrite in place. Quote bins and order book documents use
`insertMany` with E11000 (duplicate key) errors silently ignored, achieving the same
idempotency.
