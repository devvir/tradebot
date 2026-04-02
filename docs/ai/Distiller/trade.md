# Trade Generator

Aggregates raw `trade` documents into OHLCV bins at four resolutions: `tradeBin1m`, `tradeBin5m`, `tradeBin1h`, `tradeBin1d`.

Entry point: `distillTrades(mongo, database)` in [trade.ts](../../../services/distiller/src/generators/trade.ts).

## Two-phase derivation

Phase 1 (`trade` → `tradeBin1m`) and phase 2 (`tradeBin1m` → 5m/1h/1d) both run the same MongoDB `$group` + `$merge` pipeline ([trade.bins.ts](../../../services/distiller/src/generators/trade.bins.ts)). The only differences are the input shape (raw trades vs. bins) and the time-bucket expression.

Running them sequentially — rather than aggregating raw trades directly into every resolution — keeps the coarse bins cheap: 5m/1h/1d only touch the already-computed 1m bins, not millions of raw trades.

## Time-bucket semantics

Trade timestamps are **mid-period**: a trade at `10:05:00.000Z` falls into the `10:05–10:06` minute bucket, which is labelled `10:06:00.000Z` (period-end, BitMEX convention).

Bin timestamps are **period-end**: a 1m bin labelled `10:05:00.000Z` contains trades from `[10:04:00, 10:05:00)`. When rolling up 1m bins into 5m/1h/1d, `groupBins` subtracts 1 ms from the bin timestamp before `$dateTrunc` so that a 1m bin at `10:05:00.000Z` falls into the `10:00–10:05` bucket.

`matchDocs` encodes this asymmetry: raw trades match with `[from, to)`, bins match with `(from, to]`.

## Range selection (phase 1)

`firstRange` picks `from` as either the last existing `tradeBin1m` timestamp (resume) or the start-of-day of the first trade (fresh). The range is chunked at `BATCH_SIZE = 30` minutes per run. Each range is processed atomically via `$merge` with `whenMatched: 'replace'`, so re-running a range produces identical documents — idempotent by construction.

The aggregation matches raw trades by both indexed `timestamp` range AND an `$expr` on `$substrCP(timestamp, 0, 23)`. This second check handles legacy nanosecond timestamps (`"2014-11-22T16:59:08.204808000"`) which lexicographically compare wrong against millisecond strings at the boundary; truncating both sides to 23 chars forces a correct comparison.

## Tip handling

The code does **not** explicitly exclude the current tip minute. Instead, it relies on a trade existing past the minute boundary to seal it: a 1m bin at `10:05:00.000Z` only materialises if there's a later trade placing data past `10:05:00`. This emerges naturally from the timestamp index — trades ≥ `range.to` are simply out of scope for the current batch. In the tests, incomplete minutes produce no bins (`trade.test.ts` → "excludes the tip minute").

## Bin fields

Each 1m bin carries:
- `_id` — `_id` of the first source trade in the bucket (via `$first`, after `$sort: { _id: 1 }`)
- `timestamp` — period-end ISO string
- `symbol` — grouped on
- `open` — first trade's price (later patched; see below)
- `high`, `low`, `close` — standard OHLC
- `trades` — `$sum: 1`
- `volume` — `$sum: $size`
- `lastSize` — `$last: $size`
- `turnover`, `homeNotional`, `foreignNotional` — `$sum` of source fields
- `vwap` — `$_pxv / volume` where `_pxv = $sum(price*size)`; null when volume is 0

For `bins2bins`, `_pxv` is accumulated as `$sum(vwap * volume)` since raw prices aren't available — algebraically equivalent because `1m.vwap * 1m.volume == sum(price*size)` within the minute.

## BitMEX `open` convention

BitMEX defines `open` as the **previous bin's close**, not the first trade's price in the bin. This means consecutive bins have no price gaps: `bin[N].open === bin[N-1].close`.

`fixOpen()` implements this with `$setWindowFields` + `$shift by -1` partitioned by symbol. The first bin in the dataset has no predecessor and keeps its own first trade's price.

### Boundary patching (`patchBoundaryOpen`)

`$shift` only sees documents in the current aggregation pipeline run. If a batch starts at `10:30` and the previous batch ended at `10:29`, the `10:30` bin's `$shift(-1)` returns null because the `10:29` bin is not in scope. Result: `fixOpen` leaves the first bin of each batch with its own first trade as `open`.

`patchBoundaryOpen` fixes this post-hoc: for each symbol in the current batch, find the most recent prior bin and the first bin at/after `range.from`, then set the first bin's `open` to the prior bin's `close`. Runs once per `create1mBins` call.

## Phase 2 — coarser bins

`createCoarserBins` iterates in `BATCH_SIZE * 24 * 60` minute chunks (30 days) per run. `firstCoarseRange` resumes from the minimum `timestamp` across all three targets — ensuring no target is skipped ahead of another. `bins2bins` runs three times per range (5m, 1h, 1d).

Because phase 1 only produces complete-minute data (the tip is absent), every coarser bin is guaranteed complete. No cutoff logic is needed.

## Idempotency

`$merge` with `whenMatched: 'replace'` means re-running any range overwrites bins in place with identical content. The test suite verifies this (`is idempotent — re-running does not duplicate`).

## Test coverage ([trade.test.ts](../../../services/distiller/tests/generators/trade.test.ts))

Integration tests against a real MongoDB container. Cover:
- empty source → no-op
- one bin per complete minute; tip minute excluded
- OHLCV correctness (open/high/low/close/volume/trades/lastSize/vwap)
- `_id` = first trade's `_id`
- multi-symbol isolation
- idempotent re-runs; resume across runs
- BitMEX `open` convention (prev close); first-ever bin uses own open
- 5m/1h/1d rollup correctness across minute/hour/day boundaries
- Legacy nanosecond timestamp handling (1d rollup test uses `.000000000Z`)
