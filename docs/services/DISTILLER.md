# Distiller Service — Technical Reference

## Overview

```
MongoDB tradebot
  ├─ orderBookL2    ──→ distiller ──→ orderBook10 / orderBookL2_25
  ├─ compositeIndex ──┐
  ├─ funding        ──┤ distiller ──→ instrument
  ├─ settlement     ──┤
  ├─ quote          ──┤
  └─ trade          ──┘
  ├─ (every table above) ──→ distiller ──→ _partials_ (daily snapshots)
```

Distiller is a batch service. It reads raw document collections written by the
collector and produces derived collections: order book snapshots at two depths
(top-10 and top-25) derived from the full L2 stream, reconstructed historical
instrument WebSocket messages, and per-table daily snapshots (`_partials_`) that
let consumers seed a live state at any day boundary without replaying the full
history.

OHLCV bins are not derived here — `scribe` collects them straight from BitMEX's
`/trade|quote/bucketed` endpoints into the vault.

## Processing Loop

All derivations run as parallel infinite loops.

```
parallel:
  distillOrderBook: batch replay of L2 delta stream
  distillInstrument: forward hour-by-hour walk — fills gaps in real data with synthetic approximations
  distillPartials:  per-table daily snapshots into `_partials_`
```

### Shutdown

The service uses a best-effort shutdown pattern. Each distiller increments a shared
`distillers` counter before entering its loop, checks a `stopping` flag at the start of
each iteration, and decrements + breaks when the flag is set. The shutdown handler sets
`stopping = true` and waits for `distillers` to reach zero. If a distiller does not notice
the flag in time, the OS sends SIGKILL after ~30 seconds.

## Document Shapes

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

The `instrument` collection is a continuous BitMEX `instrument` WebSocket stream,
mixing **real** documents (imported by farmer) with **synthetic** documents the
distiller generates to fill gaps. Three kinds coexist, told apart by the `_id`
reserved byte (`_id % 4`): `0` original (farmer's raw input), `2` processed-real
(an original rewritten into the distilled stream), `1` synthetic (gap fill).
Behind the distiller's frontier the collection holds only processed and synthetic
documents; ahead of it, farmer's untouched originals wait.

Unlike the bin distillers, this one does not reproduce data that was captured — it
fills the holes where real data is missing with a knowing best-effort approximation.
**Real data always wins**, and synthetic fill is per-event (never lossily aggregated)
because the instrument stream is the primary liquidation signal in replay. It is a
six-actor pipeline (Reader, Provider, Synthesizer, Merger, Walker, Writer) that walks
one hour at a time, sealing each with an anchor partial, with the universe bounded by
farmer's Redis `farm:` markers.

This generator is large enough to have its own reference:
**[DISTILLER_INSTRUMENT.md](DISTILLER_INSTRUMENT.md)** — the full design (partition-aware
reading, gap detection, the rolling 24 h window, mark-method synthesis, the Conflator that
throttles order-book and reference fields to 5 s, determinism and crash recovery). For the
BitMEX feed itself — fields, cadences, proxy-derivability — see
[docs/BitMEX/INSTRUMENT.md](../BitMEX/INSTRUMENT.md).

## Partials — Daily Snapshots

Partials are per-day, per-table snapshots of accumulator state stored in the
`_partials_` collection. Every supported BitMEX table (`orderBookL2`, `instrument`,
`trade`, `quote`, `funding`, `settlement`, `insurance`) is snapshotted
independently. A consumer that wants the state of a table
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
layout (epoch: 2000-01-01 UTC).

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

### Duplicate handling

Partials are written with `insertOne` and E11000 (duplicate key) errors are
silently ignored — re-running a range is idempotent.

