# Stocker — what is still ahead

Stocker is built and normalises **75 of trucker's datasets** through 52 series entries — the
19 gate datasets added in the discovery rewrite (spot candlesticks, futures 10s/7d, TradFi) have
no series map yet.
**[docs/services/STOCKER.md](../services/STOCKER.md) is the authoritative document** for what
it normalises, how, and why. Nothing already implemented is described here.

This document covers only what has not been done.

## Series not yet mapped — order books, and nothing else

**Thirteen datasets have no stocker series, and every one of them is an order book.** Checked
exhaustively: a real published path for every mapped dataset was run through `seriesFor`, and the
only ones that resolve to nothing are `kind: book`.

| Venue | Datasets |
|---|---|
| okx | `spot`/`swap`/`future` × `400lv`/`5000lv` — 6 |
| gate | `spot`, `futures_usdt`, `futures_btc` — 3 |
| htx | `spot` (lv400), `futures` (lv150) — 2 |
| kucoin | `spot`, `futures` (lv50) — 2 |

Everything else trucker collects is mapped, including the cases that previously looked
undecidable and turned out not to be: OKX candlesticks name no interval anywhere but step by a
uniform 60 seconds, and Bybit's MT4 klines name theirs in minutes in a filename whose date range
is always exactly one calendar month.

One dataset is mapped but appears to have nothing to map: **bitget `dmcbl-klines`**. All 11
symbols, sampled across their full date ranges, answer 403 with S3's `AccessDenied` — the
venue's signature for a missing key — while the same symbol and date under `UMCBL` returns data.
Coin-margined klines are evidently published alongside the USDT-margined ones rather than under
their own product type, so stocker's `UMCBL|DMCBL` pattern already covers them either way.
Detail and the exact probes are in
[TRUCKER.md](../services/TRUCKER.md); **worth confirming against the download portal**, since it
rests on HTTP responses rather than anything Bitget states.

## Order books — the one remaining table

The largest table by far, and deliberately last. Four different shapes, all sampled:

| Venue | Shape |
|---|---|
| okx | JSON lines, `{instId, action, ts, asks, bids}`, entries `[price, size, orderCount]`; `action` = `snapshot` \| `update` |
| htx | the same, but entries are 2 elements — no order count — and `ts` is microseconds where OKX's is milliseconds |
| gate | CSV deltas: `set` re-benchmarks a level, `take`/`make` adjust it. Spot has an explicit side column; futures encode side in the **sign of the size**, and carry one column fewer |
| kucoin | CSV whose single `data` column holds a JSON object per row — spot `{asks, bids, timestamp}`, futures adds `{sequence, ts}` — full snapshots, not deltas |

**Why they are not simply another series entry.** Every other dataset is one row per fact, so
the mapping is a projection. A book row carries a nested array of price levels — 50 for KuCoin,
up to 5000 for OKX — and has to be exploded into one row per level change before it fits the
canonical event log. That is a reader concern rather than a mapping one, and none of the
existing format readers do it.

The canonical schema is already defined as an event log and the `ndjson` reader exists. What is
missing is the explosion, the per-venue projection, the `depth=`/`type=` path levels, and — for
Gate — folding a day's 24 hourly files into one partition, which the grouping already does but
has never been exercised.

Volume is the reason to wait: OKX's two depths together are ~235 MB per symbol-day and Gate's
`futures_usdt` ~765 MB, so this table will dominate the vault and is the first candidate for
cold storage.

## Not built yet

**The `@meta/` tables.** `@meta/instruments` (one row per instrument: base, quote, canonical
symbol, contract type, margining, expiry, listing date) and `@meta/books` (per variant: type,
depth, resolution, `isDefault`) are designed but not written. Until `books` exists a consumer
must know that OKX publishes two depths; until `instruments` exists there is no cross-venue
symbol identity.

**Canonical symbols.** `symbol=` currently holds the venue's own string. The design calls for a
canonical `{BASE}{QUOTE}` form with the raw string kept alongside, so `BTCUSDT` from Binance and
`BTC-USDT-SWAP` from OKX name one instrument. That needs `@meta/instruments` first, because the
mapping must come from each venue's instruments API and never from parsing a symbol string —
`XBTUSDTM → BTC` is not derivable by rule, and splitting `BTCUSDT` by guessing quote suffixes
fails on `ETHBTC`.

Because the canonical form is **built** from each venue's own base/quote fields, a collision —
two distinct pairs producing one canonical id within a venue and market — must be a hard error
at mapping time, not a silent merge of two instruments.

**BitMEX, and `settlement` with it.** Years of BitMEX are already collected and it is real
market data at scale; it keeps its value for finding patterns that generalise even once nobody
can trade against it. Winding down is a reason to stop *collecting* eventually, not to leave it
out of the database — stocker handles history, and BitMEX is history. It needs a `vault` source
reading scribe's date-partitioned CSV: a second reader family, simpler than the venue archives
but not the same code path. `settlement` exists in the schema with no source until then, since
nothing else collected publishes it.

## The sort is measured and cheap — leave it in

Every partition is written by `ORDER BY ts`, and for a large share of them the rows arrive
sorted already, so skipping the sort where inputs are provably ordered (the `tools data resort`
verdict model) looked like the big win. It was measured on 2026-08-02 and it is not: removing
the sort entirely was worth **4%** of the old build time and ~9% of the fixed one. The real
cost was the timestamp expression re-evaluating a `DECIMAL(38,9)` text parse five times per row
— fixed in `schema/project.ts` for ~96×, byte-identical output.

The sort still sets the *memory* ceiling, not the time: it is why a big month needs the spill
directory. Input-order detection would lower that ceiling, but at ~9% of runtime it is not
worth the added machinery while spilling works.

## Options are out of scope

An option is priced off strike, time to expiry and volatility rather than a price series, so
using one means carrying an options pricing model. It is also enormous and thin — one contract
per strike × expiry × side, with a single OKX BTC chain holding 804 series — and those chain
files bundle every series into one archive, so one file would explode into hundreds of
partitions across hundreds of symbols where every other input is one file to one partition.

Trucker no longer downloads them either. Nothing in the design forecloses adding them: it would
mean a chain-unpacking reader and a strike/side encoding in the canonical symbol.

## Open questions

1. **Throughput.** Profiled 2026-08-02: the cost was never the VARCHAR read (~6%, the price of
   venue-shape tolerance) but the timestamp expression, since fixed for ~96×.
   `STOCKER_CONCURRENCY` now runs that many builds at once on one shared memory budget. The
   one lever left is skipping the sort (~9%) — not worth it.
2. **Compaction.** A month still filling accumulates a file per day. Readers union them
   transparently so compacting a finished month is cosmetic — but nothing does it yet, and a
   long backfill will leave many small files.
3. **Verification against source.** Nothing re-reads a built partition and compares it to raw.
   The timestamp range guard catches a wrong unit; a wrong *column* mapping would pass it
   silently. Rebinning trades and comparing against the venue's published klines is the natural
   check, and is a data-quality report in its own right.
