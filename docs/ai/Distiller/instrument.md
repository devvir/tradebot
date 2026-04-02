# Instrument Generator

Reconstructs historical BitMEX `instrument` WS messages from five vault sources (compositeIndex, quote, trade, funding, settlement) and writes them into the `instrument` MongoDB collection alongside the live-captured stream.

Entry point: `distillInstrument(mongo, database)` in [instrument.ts](../../../services/distiller/src/generators/instrument.ts).

Support modules:
- [instrument.ids.ts](../../../services/distiller/src/generators/instrument.ids.ts) — deterministic `_id` generation and date arithmetic
- [instrument.seeds.ts](../../../services/distiller/src/generators/instrument.seeds.ts) — Tardis monthly anchor loading and forward-lookup
- [instrument.state.ts](../../../services/distiller/src/generators/instrument.state.ts) — run state creation and seeding
- [instrument.events.ts](../../../services/distiller/src/generators/instrument.events.ts) — per-day event fetching and processing
- [instrument.rolling.ts](../../../services/distiller/src/generators/instrument.rolling.ts) — per-symbol 24h rolling state

## Purpose

The live BitMEX `instrument` WS feed sends one `partial` (full snapshot) on subscribe, then `insert` and `update` messages as instruments are listed or their fields change. The generator produces the same message shapes for historical dates using vault data.

Output lives in the same collection as the live capture. The `_id` scheme separates them — see below.

## ID scheme

```
_id = dateOffset * DAY_ID_STRIDE + msgIndex * 4096 + 1
```

Where:
- `DAY_ID_STRIDE = 549_755_813_888` (= 2^39)
- `dateOffset` — days since 2000-01-01 UTC
- `msgIndex` — per-day counter; 0 for the start-of-day partial, 1..N for deltas
- `+ 1` (the `reserved` bit) — all generated messages have `_id % 4096 === 1`; live-captured messages have `_id % 4096 === 0`

`findResumeDay` uses `{ $mod: [DAY_ID_STRIDE, 1] }` to find only generated start-of-day partials (msgIndex 0, reserved 1). This does a full index scan — every index entry is visited. It runs once per `distillInstrument` call; the distiller loop sleeps 1 hour between calls (`SLEEP_MS = 3_600_000`).

`_id`s are deterministic: same vault data + same seed file always produce the same `_id`. Re-runs are safe — duplicate `_id`s are silently dropped by `insertMany({ ordered: false })`.

## Coverage window

`distillInstrument` starts by querying the first and last `timestamp` of each of the five vault collections, then computes:

```
start = max(earliest timestamp across all 5 sources)
end   = min(latest  timestamp across all 5 sources)
```

Only days where all five sources have data are generated. If any source is missing entirely, `findCoverageWindow` returns `null` and the generator skips with a log message.

## Run state (`InstrumentRunState`)

One instance is created per `distillInstrument` call and mutated throughout:

| Field | Type | Purpose |
|---|---|---|
| `table` | `Table<InstrumentItem>` | bitmex-database in-memory accumulator; holds the current snapshot of all instruments |
| `rolling` | `Map<string, RollingState>` | per-symbol 24h trade rolling state |
| `symCache` | `Map<string, InstrumentSymCacheEntry>` | last-seen `lastPrice`, `markPrice`, `bidPrice`, `askPrice`, `tickSize` per symbol — used to compute derived fields |
| `refMap` | `Map<string, string[]>` | compositeIndex symbol → list of instrument symbols that reference it (from `referenceSymbol` field) |
| `knownSymbols` | `Set<string>` | symbols that have had their first `insert` emitted |
| `deadSymbols` | `Set<string>` | symbols with no Tardis record from the current day forward — all future events skipped |
| `settled` | `Set<string>` | symbols that have received a settlement event — all sources stop emitting updates |
| `lastCronMs` | `number \| undefined` | ms of the last emitted minute-cron tick; carries the cron cadence across day boundaries |

## Accumulator seeding (`seedRunState`)

Before processing any events the accumulator table must receive a `partial` message — without it, bitmex-database silently ignores all `insert`/`update` messages. `seedRunState` always applies one, choosing the data source as follows:

1. **First-ever run** (`resumeDay === coverageStart`): `getSeedState(coverageStart)`. Returns an empty map before 2019-04-01 (no Tardis coverage yet), or the full Tardis snapshot from that date onward.
2. **Resume** (`resumeDay > coverageStart`): loads the stored partial for `resumeDay` from MongoDB (`findOne({ _id: makeId(resumeDay, 0) })`).
3. **Fallback** (stored partial missing): `getSeedState(resumeDay)` — Tardis state for that date, or empty.

After applying the partial, `rebuildDerivedState` rebuilds `refMap` and `knownSymbols` from the accumulator snapshot.

## Tardis seed file (`instrument.seeds.ts`)

`instrument-seeds.ndjson` is read synchronously at module load. Each line is a JSON object `{ action, date, data[] }`. Line 1 is always `action: 'partial'` for `2019-04-01`. Subsequent lines are monthly diffs (`insert`/`update`/`delete`) at 1st-of-month dates.

`getSeedState(upToDate)` replays all lines where `date <= upToDate` into a `Map<symbol, Partial<InstrumentItem>>`, memoized per date. `buildSeedState` handles all four action types: `partial` clears and rebuilds the map; `insert` adds; `update` merges onto the existing entry; `delete` removes.

`getFirstSeedForSymbol(symbol, fromDate)` finds the earliest Tardis snapshot date >= `fromDate` that contains `symbol`, using a binary search over the sorted date list. Returns `null` if no snapshot from `fromDate` forward contains the symbol.

`hasSeedForDate(date)` returns true if any line has that exact date — used to trigger monthly resets.

## Per-day loop

For each day from `resumeDay` (inclusive) to `end` (exclusive):

1. **Monthly reset** — if `hasSeedForDate(currentDay)`: apply `getSeedState(currentDay)` as a `partial` to the accumulator. Then sync `symCache` from the seed data (`lastPrice`, `markPrice`, `bidPrice`, `askPrice`, `tickSize`). Then rebuild `refMap` and `knownSymbols`.

2. **Start-of-day partial** — snapshot the accumulator (`state.table.snapshot()`) and push an `action: 'partial'` doc onto the batch with `msgIndex = 0`.

3. **Fetch day events** — `fetchDayEvents` queries all five vault collections for `timestamp >= dayStart AND < dayEnd`, in parallel. compositeIndex is further filtered to `reference: 'BMI', weight: null` (only the composite tick rows, not the components). Each doc is wrapped in `InstrumentTaggedEvent { source, ms, _id, row }` and the combined list is sorted by `(ms, SOURCE_PRIORITY, _id)`. Priority order: compositeIndex=0, quote=1, trade=2, funding=3, settlement=4.

4. **Stream events** — `processDayEvents` is a generator. It interleaves minute-cron ticks with real events and yields `insert`/`update` docs in write order. Each yielded doc is appended to an in-memory batch; when the batch reaches `BATCH_SIZE = 10_000` docs it is flushed to MongoDB.

5. **Final flush** — after the last day of the run, any remaining docs in the batch are flushed.

## Event processing (`processDayEvents`)

The generator maintains two cursors: `ei` (index into the sorted events array) and `nextCronMs` (next cron tick to emit). Each iteration:

1. Compute `eventMs = events[ei].ms` (or `Infinity` if no events remain).
2. While `nextCronMs < dayEndMs && nextCronMs <= eventMs`: emit the cron tick for `nextCronMs`, advance `nextCronMs += 60_000`.
3. Collect all events with `ms === eventMs` into a batch.
4. `mergeBatchBySymbol` — runs `computeEventUpdates` for each event, merging results per symbol (later fields overwrite earlier ones within the same ms).
5. For each `(symbol, fields)` in the merged map:
   - Skip if `deadSymbols.has(symbol)`.
   - `applySymCache` — update `symCache` with any new price/tickSize fields, and compute derived fields in-place on `fields` (see below).
   - If not in `knownSymbols`: call `enrichForInsert` to get the Tardis anchor. If `getFirstSeedForSymbol` returns null, add to `deadSymbols`, log a warning, skip. Otherwise merge Tardis fields under vault fields (`{ ...tardisFields, ...fields }`), emit `insert`, add to `knownSymbols`.
   - If already in `knownSymbols`: emit `update` with the vault-derived fields as-is.
   - Apply the insert/update to the accumulator via `applyToAccumulator`.

### Cron tick (`emitCronTick`)

First tick of a day: `dayStartMs + 15_000` (00:00:15.000). Subsequent ticks: `lastCronMs + 60_000`. `state.lastCronMs` is updated after every tick so the cadence survives day boundaries.

For each symbol in `state.rolling`, skipping symbols in `settled`, `deadSymbols`, or not yet in `knownSymbols`: call `computeMinuteBlock(rolling, ms)` and yield one `update` doc carrying the 24h stats block. Also applies the block to the accumulator.

### Per-source field extraction (`computeEventUpdates`)

**compositeIndex** — `parseFloat(row.lastPrice)` → `markPrice`. Skip if NaN. Look up `state.refMap.get(row.symbol)` to get the list of instrument symbols that reference this composite index. For each (skipping settled): emit `{ markPrice, limitUpPrice: markPrice * 1.10, limitDownPrice: markPrice * 0.90 }`.

**quote** — skip if no `symbol` or settled. Copy `bidPrice` and/or `askPrice` from the row if present (either may be absent).

**trade** — skip if no `symbol`, settled, or missing `size`/`price`. Get or create a `RollingState` for the symbol in `state.rolling`. Call `addTrade(...)`. The returned fields are `{ lastPrice, lastTickDirection, lastChangePcnt? }`.

**funding** — skip if no `symbol` or settled. Emit `{ fundingTimestamp: row.timestamp, fundingRate?, fundingInterval? }`.

**settlement** — add symbol to `state.settled`. Emit `{ state: 'Settled', settledPrice? }`.

### Derived fields (`applySymCache`)

After merging all events for a millisecond, `applySymCache` runs per symbol:

- Updates `symCache` with any of `lastPrice`, `markPrice`, `bidPrice`, `askPrice`, `tickSize` present in `fields`.
- If this event updated `markPrice` or `lastPrice`, and both are now in cache: `lastPriceProtected = clamp(lastPrice, markPrice * 0.9995, markPrice * 1.0005)`, added to `fields`.
- If this event updated `bidPrice` or `askPrice`, and both are now in cache: `midPrice = round((bid + ask) / 2, tickSize / 2)`. The rounding uses `tickSize` from cache (populated on first insert from the Tardis anchor). Result is exact — bid and ask are always at multiples of `tickSize`, so the midpoint is always a multiple of `tickSize / 2`.

## Rolling 24h state (`instrument.rolling.ts`)

Per-symbol `RollingState`:

```ts
{
  window:             { ms, size, grossValue, homeNotional, foreignNotional }[],
  priceHistory:       { ms, price }[],
  volume24h:          number,   // running sum over window
  turnover24h:        number,   // running sum over window
  homeNotional24h:    number,   // running sum over window
  foreignNotional24h: number,   // running sum over window
  totalVolume:        number,   // all-time accumulator
  totalTurnover:      number,   // all-time accumulator
  lastVwap:           number | undefined,
}
```

The four `*24h` fields are running sums — maintained by adding on push and subtracting on shift. The window is never re-iterated. This is O(1) amortized per trade.

### `addTrade(state, ms, size, price, grossValue, homeNotional, foreignNotional, tickDirection)`

1. `evictWindow` — shift entries from the head of `window` while `entry.ms < ms - 86_400_000`, subtracting each from the running sums.
2. Push `{ ms, size, grossValue, homeNotional, foreignNotional }` onto `window`; add to running sums and `totalVolume`/`totalTurnover`.
3. `evictPriceHistory` — keep at most one entry at or before `ms - 86_400_000` (needed so `olderPrice` can answer `prevPrice24h` for near-future events). Shifts from the head while `priceHistory[1].ms <= cutoff`.
4. `olderPrice` — returns `priceHistory[0].price` if `priceHistory[0].ms <= cutoff`, else undefined. This is computed **before** pushing the current price.
5. Push `{ ms, price }` onto `priceHistory`.
6. Return `{ lastPrice: price, lastTickDirection: tickDirection, lastChangePcnt? }`. `lastChangePcnt = (price - prevPrice) / prevPrice`, omitted when `olderPrice` was undefined.

### `computeMinuteBlock(state, ms)`

Called on each minute-cron tick:

1. `evictWindow` and `evictPriceHistory` (handles idle gaps where no trades have evicted stale entries).
2. Return `{ volume24h, turnover24h, homeNotional24h, foreignNotional24h, prevPrice24h?, vwap? }`.
   - `prevPrice24h` = `olderPrice(state, ms)`, omitted if undefined.
   - `vwap = foreignNotional24h / homeNotional24h`, omitted when `homeNotional24h === 0` or when the value equals `state.lastVwap` (unchanged since last cron tick).

### Window boundary

Entries at exactly `ms - 86_400_000` are **kept**. Entries strictly older (`entry.ms < cutoff`) are evicted. `evictWindow` condition: `while window[0].ms < cutoff`.

### Rolling state on resume

`state.rolling` is rebuilt empty on every `distillInstrument` call. On resume, the first day's 24h sums are under-counted because trades from the prior 24h are not in the window. This is not a correctness problem: the generator re-processes the same days with the same `_id`s, and `insertMany({ ordered: false })` with duplicate-key-ignore means the original (first-run) values remain in the collection.

## Accumulator seeding resume path

On resume, `findResumeDay` finds the stored partial for the last generated day:

```
{ _id: { $mod: [DAY_ID_STRIDE, 1], $lt: makeId(addDay(lastDay), 0) } }
sort: { _id: -1 }, limit: 1
```

`_id % DAY_ID_STRIDE === 1` matches only generated start-of-day partials (msgIndex 0, reserved 1). The `$lt` upper bound excludes any entries beyond the generation window. From the found `_id`: `resumeDay = offsetToDate(floor(_id / DAY_ID_STRIDE))`.

`seedRunState` then loads that day's stored partial from MongoDB and applies it to the accumulator, restoring the exact state that existed when that partial was written. `knownSymbols`, `refMap`, and `symCache` are rebuilt from the snapshot.

## Output document shapes

Start-of-day partial (msgIndex 0):
```ts
{
  _id:    makeId(day, 0),   // dateOffset * DAY_ID_STRIDE + 1
  action: 'partial',
  keys:   ['symbol'],
  types:  Record<string, BitmexFieldType>,
  filter: {},
  data:   InstrumentItem[],  // full accumulator snapshot
}
```

Event-driven insert or update (msgIndex 1..N):
```ts
{
  _id:    makeId(day, msgIndex),
  action: 'insert' | 'update',
  data:   [{ symbol, timestamp, ...fields }],
}
```

Minute-cron update (interleaved at `HH:MM:15.000Z`):
```ts
{
  _id:    makeId(day, msgIndex),
  action: 'update',
  data:   [{ symbol, timestamp, volume24h, turnover24h, homeNotional24h, foreignNotional24h, prevPrice24h?, vwap? }],
}
```

## Fields not reconstructed

These fields come from the Tardis seed and carry over unchanged between monthly resets. They are not updated by any vault source:
- `openInterest`, `openValue`
- `impactBidPrice`, `impactMidPrice`, `impactAskPrice`
- `highPrice`, `lowPrice`, `openValue`, `prevClosePrice`
- Any static spec (`lotSize`, `multiplier`, `initMargin`, etc.)

## Test coverage

### instrument.rolling.test.ts

**`createRolling`**
- returns empty state with all counters at zero

**`addTrade` — return fields**
- returns `lastPrice` and `lastTickDirection`
- does not return any 24h-block fields

**`addTrade` — running sums**
- accumulates `totalVolume` and `totalTurnover`
- accumulates `volume24h`, `turnover24h`, `homeNotional24h`, `foreignNotional24h` incrementally

**`addTrade` — eviction**
- evicts entries older than 24h and subtracts from running sums
- keeps entries exactly at the 24h boundary

**`addTrade` — `lastChangePcnt`**
- omitted when no trade precedes the 24h cutoff
- computed from the most recent trade at or before the cutoff
- works when only one prior trade exists

**`computeMinuteBlock`**
- returns `volume24h`, `turnover24h`, `homeNotional24h`, `foreignNotional24h` from running sums
- computes `vwap = foreignNotional24h / homeNotional24h`
- omits `vwap` when unchanged since last call
- omits `vwap` when `homeNotional24h === 0`
- includes `prevPrice24h` when a trade exists at or before the 24h cutoff
- omits `prevPrice24h` when none exists
- evicts stale window entries even with no new trades

### instrument.events.test.ts

**New symbol (insert)**
- emits `action: 'insert'`
- merges Tardis semi-static fields with vault fields
- vault fields override Tardis where they overlap
- calls `getFirstSeedForSymbol` with the current day
- adds symbol to `knownSymbols`
- computes `midPrice` from bid/ask

**Known symbol (update)**
- emits `action: 'update'`
- does not call `getFirstSeedForSymbol`
- assigns timestamp from event ms
- increments `_id` across events

**Dead symbol**
- emits nothing when `getFirstSeedForSymbol` returns null
- adds symbol to `deadSymbols`
- skips pre-flagged dead symbols without re-querying Tardis

**Same-ms batching**
- emits one doc per symbol per ms batch (two symbols → two docs)
- merges same-ms same-symbol events into one doc

**`seedRunState`**
- cold start with no Tardis seed: applies empty partial, no MongoDB query
- resume with stored partial: populates `knownSymbols`
- table accepts inserts after seeding
- falls back to empty partial when no stored partial exists
