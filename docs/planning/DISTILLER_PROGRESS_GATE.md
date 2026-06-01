# Distiller progress gate + hole-tolerance refactor

A single shared progress helper, plus per-generator changes that make each generator either **order-independent** (process any settled day in any order, holes transparent) or **conservative** (process only a contiguous prefix; wait at holes), per the guiding principle below. In scope for this plan: `quote` and `trade` — both order-independent.

The per-generator sections below are intentionally self-contained: reviewing or implementing one generator does not require reading the others. Shared infrastructure (the progress helper, the distiller plumbing) is documented once up front.

---

## 1 — Context

**Priority: no regressions on `trade` and `quote`.** Production `DISTILLER_DISTILLERS=trade,quote` — those are the two generators currently enabled and working correctly. The problem to fix: distiller generators assume `max(timestamp)` = "fully imported", but this plan restores correctness for those two without changing externally observable behaviour. `orderbook`, `instrument`, and `partials` are off in production and are deferred — they'll be refactored to the new flow when we get to them, and their sections in this doc are sketches, not commitments.

Farmer's worker pool walks the date queue with up to ~6 concurrent workers. At any moment up to ~6 files of the same table can be partially imported into mongo, so `max(timestamp)` or `max(_id)` in a collection no longer means "everything before this point is fully present." Every distiller generator relies on that assumption today.

The fix is entirely on the distiller side and has two layers:

1. **A shared *progress helper*** that answers, per table, "which dates are settled enough to read from mongo?" — reading farmer's Redis progress markers.
2. **Per-generator changes** that follow the guiding principle below.

### Guiding principle

**Where we can ensure the correct result regardless of processing order, do it. Where we can't, be conservative — don't process anything until the holes are filled.**

In practice this gives a binary per generator:

- *Order-independent*: process any settled date, in any order, holes are transparent. Used when there's a clean way to make output for day N a pure function of day N (plus order-stable boundary glue).
- *Conservative*: process only a contiguous prefix of settled dates. Used when output for day N genuinely depends on cumulative state from prior days and there's no clean way to invert that.

The categorization for each generator lands at the top of its section.

### Cross-cutting: BitMEX bin timestamp convention

This trips agents repeatedly and is load-bearing for the trade section in particular. **BitMEX bins are timestamped at the END of the period they cover, not the start.**

Examples:
- A 1-minute bin covering `00:00:00.000Z` through `00:00:59.999Z` has timestamp **`00:01:00.000Z`**.
- A 5-minute bin covering `00:55:00.000Z` through `00:59:59.999Z` has timestamp **`01:00:00.000Z`**.
- A 1-day bin covering all of `2026-04-01` has timestamp **`2026-04-02T00:00:00.000Z`**.

For each of the four bin sizes (1m / 5m / 1h / 1d), the bin "for day N" spans timestamps:

| size | first bin of day N | last bin of day N |
|---|---|---|
| 1m | `NT00:01:00.000Z` | `(N+1)T00:00:00.000Z` |
| 5m | `NT00:05:00.000Z` | `(N+1)T00:00:00.000Z` |
| 1h | `NT01:00:00.000Z` | `(N+1)T00:00:00.000Z` |
| 1d | `(N+1)T00:00:00.000Z` | `(N+1)T00:00:00.000Z` *(only one 1d bin per day — the same row is both first and last)* |

Two consequences worth internalizing:

1. **All four "last bins of day N" share the same timestamp** — `(N+1)T00:00:00.000Z`. This is the close-of-day anchor.
2. **The 1d bin for day N has timestamp `(N+1)T00:00:00.000Z`** — its "date" looks like the next day's. So "the 1d bin labelled `2026-04-02T00:00:00.000Z`" actually summarises 2026-04-01.

This convention applies only to **derived bin documents** (`tradeBin*`, `quoteBin*`). Source rows (`trade`, `quote`, etc.) use their own natural timestamps.

---

## 2 — The progress helper

`services/distiller/src/dates.ts`. One module that owns *all* progress bookkeeping. Generators never read or write Redis directly.

### API

```ts
dateWalker(
  target: string,
  source: string | string[],
): DateWalker

interface DateWalker {
  /** Resolves with the next pending date. Blocks until one is available.
   *  Resolves with null after close() has been called. */
  next(): Promise<string | null>;

  /** Unblocks any pending .next() with null, and makes future calls return null.
   *  Used for graceful shutdown. */
  close(): void;
}
```

- `target` — distiller's progress namespace for this generator. Stored in Redis as `distiller_<target>_<date>`.
- `source` — the farmer-tracked table (or tables) the generator consumes. With multiple sources, the walker takes the intersection — a date is ready when *every* source has marked it done in `farm`. The walker exclusively reconciles **farmer** progress with **distiller** progress; chaining between distiller targets is the generator's concern, not the walker's.

**Implicit marker-on-next.** Each call to `.next()` writes the `distiller_<target>_<date>` marker for the *previously*-returned date before fetching the new one. So advancing = "I'm done with the previous one." If the consumer's loop body throws or simply stops calling `.next()`, the last-returned date is *not* marked — its work was either incomplete or unwritten, and the next pass will re-process it (idempotent).

**Blocking lifecycle.** `.next()` does not return null on "nothing right now" — it blocks (internal poll on `REFRESH_MS`) until a new pending date is available. It returns null only after `.close()` has been called. Distiller's top-level wires shutdown to close all walkers, which unblocks the loops and lets the service exit cleanly.

The API will likely grow as later generators need more (a `contiguous` mode for instrument, etc.). Adding parameters is a one-line change; no need to anticipate them now.

### Storage shape

Two Redis namespaces:

- `farm:<table>:<date> = "done:<messages>"` — farmer's markers. Read-only from the walker.
- `distiller_<target>_<date> = "done"` — written by the walker on `.next()`, marking the previously-returned date as complete.

For per-source generators (partials), the target name encodes the source: e.g. `distiller_partials_quote_<date>`.

### What the walker does internally

State:

- A cache of farmer-done dates per source, refreshed lazily when older than `REFRESH_MS`.
- A cache of distiller-done dates per target, refreshed the same way and updated immediately when this walker writes a marker.

On each `.next()`:

1. If a previous date was returned, write its `distiller_<target>_<date>` marker (update the cache too).
2. If the caches are stale, refresh them: `SCAN farm:<source>:*` per source, filter to values starting with `"done"`; same for `SCAN distiller_<target>_*`.
3. Compute the candidate set: dates farm-done in *every* source table AND not in the target's distiller-done set.
4. If the candidate set is non-empty, return the earliest date. Otherwise wait (sleep `REFRESH_MS`, retry from step 2). If `.close()` is called while waiting, resolve with `null`.

### Structural gaps and permanently-missing data

Some dates have no source data and never will — for example BitMEX's `compositeIndex` `2019-04-01` (BitMEX bug), or BitMEX's orderbookL2 calendar days that aren't first-of-month in the pre-2026-03-08 historic. Farmer never marks these as done because there's nothing to import.

For order-independent generators this never matters — the helper simply skips dates that aren't farm-done, and the generator processes whatever the helper hands it.

If a *conservative* generator (only instrument, currently) ever needs to advance past such a gap, one operator action per gap: `redis-cli SET farm:<source>:<date> done:0`. Farmer's discovery already skips dates with no vault file, so no actual import is attempted; the helper just treats the entry as a normal done marker. We'll cross this bridge if instrument turns out to need it.

### Internal state

- Module-level cache of farmer-done sets per source and distiller-done sets per target. Refreshed on demand when older than `REFRESH_MS`.
- `_test_reset` clears all state.

Memory: ~15K entries across all (table, date) pairs over a multi-year horizon. Trivial.

### Constants

```ts
const REFRESH_MS = 30 * 1_000;
```

In-file, edit to tune. `REFRESH_MS` is how stale the helper's internal snapshot can be — small enough that backfill stays responsive, large enough that idle distiller doesn't spam Redis.

### Failure mode

Transient Redis errors during SCAN / MGET are caught and logged; the walker waits one `REFRESH_MS` tick and tries again. `.next()` does not surface these to the caller — they're just longer-than-usual blocking. The caller sees `null` only on `.close()`.

### Recovery and re-run safety

Crashes are rare; the normal case is distiller running for days or weeks uninterrupted. When a crash *does* happen mid-day, the recovery story is just: **re-run the day from the start, ignoring duplicate-key errors.** Both quote and trade are designed around deterministic `_id`s (the bin's `_id` is the `_id` of the first source row in the bin's group), so re-running the aggregation always emits the same bins with the same `_id`s, and the `$merge: replace` / `insertMany({ ordered: false })` patterns silently absorb the duplicates. `patchBoundaryOpen`'s `updateOne` on the first-bin `open` field is also idempotent — setting the same value twice. There's no "did we run this before?" check anywhere.

Concretely:

- `insertMany({ ordered: false })` everywhere, with duplicate-key (`code === 11000`) absorbed by an `.catch(ignoreDuplicateKeyErrors)` helper.
- The walker's marker `distiller_<target>_<date>` is written *after* the day's mongo writes commit (via the implicit-on-next-`.next()` mechanism). If the process dies before that, the marker is absent → next pass re-yields the date → idempotent re-run → marker eventually written.
- The "wasted work" on resume is bounded to one partial day per crash.

The corner case worth naming: if `distiller_<target>_*` keys are *lost from Redis* (flush, accidental delete, restart without persistence), the walker re-yields *all* dates and the generators re-run them — slow, but no data is lost or corrupted. The operator notices distiller working on dates from years ago, stops it, restores Redis, restarts. Idempotent re-runs make this a safe failure mode rather than a destructive one.

This is why we don't need a clean-slate-before-reprocess mechanism in the walker. The duplicate-key absorption is the recovery mechanism.

---

## 3 — Distiller infrastructure changes

Today distiller declares only `mongodb: true`. To use the progress helper:

- **`services/distiller/src/service.ts`** — add `redis: true` to the `SKFactory` call.
- **`services/distiller/docker/compose.yml`** — add `CACHE_URL` and `CACHE_PASS` env passthroughs (matching farmer/scribe).
- **`services/distiller/src/index.ts`** — connect redis alongside mongo, create a walker registry, wire `service.on('shutdown')` to close every walker in it, and pass `redis` and the registry into each generator. See the top-level loop sketch below.

### Top-level loop and shutdown

Today's `index.ts` runs `while (true) { await Promise.all(generators); await sleep(SLEEP_MS); }`. That pattern goes away: with `dateWalker.next()` blocking until a new pending date arrives (and only returning `null` on `.close()`), each generator function runs *forever* until shutdown — no outer sleep needed. Distiller's pacing now lives entirely inside the walker.

The new top-level shape:

```ts
SK.run(async (service: Service) => {
  const config = service.config() as Config;
  const mongo  = await service.providers.connect('mongodb') as MongoClient;
  const redis  = await service.providers.connect('redis')   as RedisClient;

  await ensureSharedIndexes();  // unchanged from today

  const generators = config.generators;   // GeneratorName[] | null, same as today
  const enabled    = (name: string) => ! generators || generators.includes(name);

  const walkers: DateWalker[] = [];       // every walker created registers here
  service.on('shutdown', () => walkers.forEach(w => w.close()));

  await Promise.all([
    enabled('quote') ? distillQuotes(mongo, config.database, redis, walkers) : null,
    enabled('trade') ? distillTrades(mongo, config.database, redis, walkers) : null,
    // ... deferred generators wired in similarly when refactored
  ].filter(Boolean));
});
```

Each generator function creates its walker(s), pushes them into the shared `walkers` array, and then loops on `.next()`. On shutdown the registry is iterated, every walker's `.close()` runs, every `.next()` resolves to `null`, every loop exits, the top-level `Promise.all` resolves, the service exits cleanly.

The walker module could export a small registry helper (`createWalkerRegistry()` returning `{ register, closeAll }`) if you'd rather not pass a raw array around — implementation choice, no impact on correctness.

### `makeId` placement

**Not required for quote or trade.** Both work on `timestamp`-based queries, not `_id` ranges. This subsection is only relevant when we eventually refactor orderbook or partials, both of which read source data in `_id` order and would benefit from a shared `makeId(date, msgIndex, reserved?)` helper. At that point: extract from `services/farmer/src/write/id.ts` to `shared/utils` and import from both farmer and distiller.

Skipped for the quote/trade work in scope here.

---

## 4 — Generator: quote

**Mode: order-independent.** Each minute's bin is a pure function of that minute's source rows; no inter-minute or inter-day dependency. Trivially safe to process any settled date in any order.

### What it does today

Reads `quote`, aggregates by minute and symbol, writes `quoteBin1m`. A separate concurrent task filters 1m bins at 5m/1h/1d round-timestamp boundaries and writes them to `quoteBin5m`, `quoteBin1h`, `quoteBin1d`. Resumes from `max(timestamp)` of `quoteBin1m`; caps work at the latest-minute boundary of the source.

### The problem

`max(timestamp)` of `quote` no longer means "everything before this is in mongo" — with farmer's concurrent workers, a date can be partially imported while earlier dates are also in flight. Generated bins for any minute that's not yet fully imported would be inserted with whatever data is available and never corrected (the `insertMany` ignores duplicate keys).

### Order-independence — already there

Each minute's bin is a pure function of the rows in that minute. No inter-day, inter-minute, or accumulator dependency, and no OHLC boundary patch (quote bins are snapshot-style: latest bid / ask at the period's end, not open/high/low/close). Processing day N then N+1, or N+1 then N, or any subset in any order, produces identical bins.

### Code changes

Quote is the simplest of the four generators: aggregate per day, no `patchBoundaryOpen`, no peek.

- Accept `redis: RedisClient` and the walker registry in `distillQuotes`.
- Replace the existing `findRange` + concurrent-1m+coarser orchestration with a single per-day loop. The four bin sizes are processed sequentially inside the loop body; the walker treats "quote bins" as one unit:
  ```ts
  import { dateWalker } from '../dates';

  const walker = dateWalker('quoteBins', 'quote');
  walkers.push(walker);   // register so shutdown can close it

  let date;
  while ((date = await walker.next())) {
    await generate1m(date);
    await generate5m(date);
    await generate1h(date);
    await generate1d(date);
  }
  ```
- `generate1m(date)`: existing 1m aggregation, `$match: { timestamp: { $gte: startOfDay(date), $lt: endOfDay(date) } }`. Same group-by-minute logic, scoped to a single day.
- `generate5m(date)` / `generate1h(date)` / `generate1d(date)`: filter day's 1m bins at round-timestamp boundaries and copy into the respective coarser collection. Since 1m has just completed for this day, they have everything they need.
- Single marker `distiller_quoteBins_<date> = done` covers the date — written automatically by the walker on the next `.next()` call.
- Drop the "max-timestamp resume" logic and the concurrent 1m+coarser orchestration entirely.

### Verification

- After deploying, mongo state for any day < the latest settled day is byte-identical to before. Idempotent re-runs are duplicate-key-ignored.
- Shuffled day order produces identical end-state (sanity check on order-independence).

---

## 5 — Generator: trade

**Mode: order-independent.** Each day's bins are intrinsically per-minute (pure function of source rows); the only cross-day coupling is the `open = previous close` boundary patch, which is made order-stable by the anchor-and-peek pattern described below.

### What it does today

Reads `trade`, aggregates by minute (per symbol) into `tradeBin1m`. Coarser bins (`tradeBin5m`, `tradeBin1h`, `tradeBin1d`) are aggregated from `tradeBin1m` via `$merge: replace`. `patchBoundaryOpen` sets the `open` of each new range's first bin per symbol to the `close` of the previous bin (BitMEX's "open = previous close" convention). Resumes from `max(timestamp)` of `tradeBin1m`.

### The problem

Same `max(timestamp)` issue as quote — with farmer's concurrent workers, it can reflect a partially-imported day. On top of that, the boundary patch is sensitive to *which* "previous bin" it finds: if it reads while an earlier day is still in flight, the patch can be wrong, and subsequent re-runs won't correct it because the duplicate-key-ignored insert is a no-op.

### Order-independence — anchor-and-peek

Recall the end-of-period convention: the close-of-day-N anchor for every bin size lives at `(N+1)T00:00:00.000Z`. The first bin of day N+1 takes its `open` from that anchor.

**Storage stays sparse.** The aggregation only emits bins for `(symbol, period)` pairs with actual trades. No idle-minute fill is performed — that's the replay engine's problem if it needs minute-by-minute completeness. Sparsity is naturally robust because every "previous close" lookup uses `findOne({ symbol, timestamp: { $lte: from } }, sort: -1)`, which walks back to whichever bin actually exists, regardless of which minute it sits in.

When processing **day N**, per bin size, three operations:

**Step 1 — Aggregate.**
Run the existing `createBins` pipeline (`$match` → `$group` → `fixOpen` → `$merge`) for day N's range. The pipeline's `fixOpen` sets every bin's `open` to the previous bin's `close` *within the aggregation window*, except the very first bin per symbol (which has no `_prevClose` from `$shift` and falls back to `$first: '$price'` — the "fake" open if there's no prior anchor outside the window).

**Step 2 — Patch N's first bin from the prev-day anchor** (existing call).
`patchBoundaryOpen(bins, range, binSize)` where `range.from = NT00:00:00.000Z`. Only `range.from` is read by the function (the `to` field is unused — pass `(N+1)T00:00:00.000Z` or anything else). This finds the last close `≤ NT00:00:00.000Z` (prev day's last bin) and overwrites N's first bin's `open` with it. Cold start (no prev day in mongo yet) means no `prev` is found and the patch is a no-op — N's first bin keeps the fake open from step 1. Same behaviour as today.

**Step 3 — Peek-and-patch N+1's first bin** (new call).
`patchBoundaryOpen(bins, range, binSize)` where `range.from = (N+1)T00:00:00.000Z`. Same function, just called with the day-boundary shifted forward by one day. It finds the last close `≤ (N+1)T00:00:00.000Z` (N's last bin, real now after step 1) and looks for N+1's first bin. If N+1 has been processed already (out of order), its first bin's `open` was fake (no prev when it ran step 2); this call patches it to N's real close. If N+1 hasn't been processed, no `first` is found and the call is a no-op.

### Why this is order-independent

- **N then N+1:** Step 2 of N either patches N's first bin (if N-1 in mongo) or leaves it fake (cold). Step 3 of N finds no N+1 bins, no-ops. Then N+1 runs: step 2 patches N+1's first bin from N's now-real close. Step 3 of N+1 looks at N+2, finds nothing, no-ops.
- **N+1 then N:** N+1 runs cold-on-the-left — step 2 finds no `prev`, leaves first bin fake. Step 3 of N+1 looks at N+2, no-ops. Then N runs: step 2 patches N's first bin (if N-1 in mongo) or leaves it fake. Step 3 of N looks at N+1, finds the previously-fake first bin, patches it.

End state in both orderings: N+1's first bin's `open` = N's last close (real). Convergent.

The only bin that can ever stay "fake" is the very first bin per symbol of the *earliest day ever processed* in the chain — there's literally no prior close to anchor against. That's the cold-start state of today's code, preserved.

### Code changes

- Accept `redis: RedisClient` and the walker registry in `distillTrades`.
- Single per-day loop. The four bin sizes are processed sequentially per day inside the loop body:
  ```ts
  import { dateWalker } from '../dates';

  const walker = dateWalker('tradeBins', 'trade');
  walkers.push(walker);   // register so shutdown can close it

  let date;
  while ((date = await walker.next())) {
    await generate1mTradeBins(date);
    await generate5mTradeBins(date);
    await generate1hTradeBins(date);
    await generate1dTradeBins(date);
  }
  ```
- Each `generate<size>TradeBins(N)` does the three steps from *Order-independence*:
  - **Step 1**: run the existing `createBins(source, target, range, binSize, transform)` aggregation for day N at this size, with `range.from = NT00:00:00.000Z` and `range.to = (N+1)T00:00:00.000Z`. For 1m, source = `trade` collection, transform = `trades2bins`. For 5m/1h/1d, source = `tradeBin1m`, transform = `bins2bins`.
  - **Step 2**: call `patchBoundaryOpen(bins, range, binSize)` with the *same* `range` from step 1 (`from = NT00:00:00.000Z`). The function only reads `range.from`. Anchors N's first bin to the prev day's last close (or leaves the fake `open` in place if no prev exists).
  - **Step 3**: call `patchBoundaryOpen(bins, range, binSize)` again with `range.from = (N+1)T00:00:00.000Z`. Patches N+1's first bin if it was already processed; no-op otherwise.
- Single marker `distiller_tradeBins_<date> = done` covers the date — written automatically by the walker on the next `.next()` call.
- Drop the "max-timestamp resume" logic and the concurrent 1m+coarser orchestration entirely.

### Verification

- Re-run with shuffled processing order on a small backfill set — bins should be byte-identical to in-order processing.
- Holes (structural or cold-storage) leave the gap-following day's first bin at the fake (first-trade) `open` until the gap closes; once the prior day is processed, step 3 overwrites it with the real close.

---

## 6 — Generator: orderbook

> **Sketch only.** Deferred until after quote and trade are in. Detailed when we get there.

**Likely mode: order-independent**, on a per-calendar-day basis. Each day's range is `[makeId(N, 0), makeId(N+1, 0))` — *not* a partial-to-partial span across settled dates. The existing per-symbol `seenPartial` gating handles the "ignore until first partial" rule within each day. Day N's processing modifies state silently for pre-partial records and emits outputs only after the partial is seen.

The earlier worry about "in-flight X-1 records arriving after we've moved past X" is solved by the helper: a date isn't returned until farmer marks it done, so all records for it are guaranteed in mongo before we read.

Structural gaps (orderbook's monthly-only pre-2026-03-08 pattern) are simply not iterated — the helper skips dates that aren't farm-done.

We will fill in code changes and verification when we get to implementing this generator.

---

## 7 — Generator: instrument

> **Sketch only. Off in production (`DISTILLER_DISTILLERS` excludes it).** Detailed when we actually refactor it.

The genuine cross-day state dependency — day N's start-of-day partial *is* day N-1's end-of-day state — means making this clean under out-of-order processing isn't free. When we get here, the three known options are:

- **A.** Add a `contiguous` flag to the helper. Instrument processes strictly in order, waits at gaps. Operator marks structural gaps with `redis-cli SET farm:<source>:<date> done:0`.
- **B.** Re-emit cascade. Instrument processes whatever the helper returns; when an earlier hole is filled, recompute all downstream partials.
- **C.** On-demand mongo aggregation. Each day's start-of-day partial is a pure function of mongo state. No carried-forward accumulator.

Decision when we get here. Until then, instrument stays out of `DISTILLER_DISTILLERS`.

---

## 8 — Generator: partials

> **Sketch only. Off in production.** Detailed when we actually refactor it.

Same shape as orderbook + instrument: WS sources are naturally order-independent (per-file partial resets state), REST sources have the same accumulator-state issue as instrument and will use whichever direction (P1 aggregation / P2 cascade / contiguous flag) we pick when we get there.

---

## 9 — Implementation order

In scope for this plan: **quote and trade only**. Everything else is deferred. `makeId` extraction is not in scope (only orderbook/partials need it).

1. **Distiller infra plumbing.** `service.ts` (`redis: true`), `compose.yml` (CACHE_URL/PASS), `index.ts` (connect redis, thread through). No behaviour change yet. Build, deploy, confirm distiller still runs.
2. **Write `dates.ts`.** Standalone, no callers yet. Build to typecheck.
3. **Apply to quote (section 4).** Smallest blast radius. Deploy, verify *no regression* on current outputs.
4. **Apply to trade (section 5).** Adds the anchor-and-peek pattern (second `patchBoundaryOpen` call per day). Verify *no regression* on a backfill set with shuffled processing order.

After step 4 ships and trade/quote are confirmed solid, separate planning iterations will pick up orderbook, instrument, and partials — adapting the walker API at that point if needed.

---

## 10 — Decisions to settle

1. **`HOLD_MS = 30 min`, `REFRESH_MS = 30 s`** — proposing as the initial values, in-file constants. Confirm.
2. **Walker behaviour on transient Redis errors** — proposing "log, wait one `REFRESH_MS`, retry silently." Caller only sees `null` after `.close()`. Confirm vs. surfacing errors.

Decisions about orderbook / instrument / partials are explicitly deferred to their own planning iterations.

---

## 11 — What this plan does *not* address

- Changing farmer's concurrent worker model to a date-barrier shape. The plan assumes farmer stays as-is and distiller adapts.
- Cold-storage retrieval automation. Operator-driven, as today.
- Observability / metrics on the walker. Generator logs are the diagnostic surface.
- Recovery for the rare case where farmer progress never advances past a date (farmer stuck mid-import). Plan assumes the operator notices distiller stalling at the affected date and investigates.
