# Instrument distiller

The instrument generator of the [distiller service](DISTILLER.md). It produces a
**continuous `instrument` collection** — BitMEX's per-contract WebSocket stream with no time
gaps — by mixing the **real** documents farmer imported with **synthetic** documents it
generates to fill the silences. Real data always wins; synthetic fill is a faithful,
best-effort reconstruction of the silences from the other collected tables.

This document is the *how*. For *what the feed is* — its message model, fields, cadences, and
the proxy-derivability map this generator relies on — see the authoritative
[`docs/BitMEX/INSTRUMENT.md`](../BitMEX/INSTRUMENT.md); it is not repeated here. The mark-price
formulae are in [`docs/BitMEX/FAIR_PRICE_MARKING.md`](../BitMEX/FAIR_PRICE_MARKING.md).

The instrument stream is the primary signal for liquidation detection during replay, so
synthetic fill **preserves every price oscillation** — it is per-event, never lossily
aggregated. The one exception is order-book bid/ask and reference index values, which are
emitted on a 5 s grid because that is exactly what the real feed does (§8).

---

## 1 — One collection, three populations

The generator reads and writes a single `instrument` collection. Three kinds of document
coexist there, told apart by the `reserved` byte of the `_id` (`_id % 4`):

| Kind | `reserved` | Author | Meaning |
|---|---|---|---|
| **Original**  | 0 | Farmer    | Raw imported real data — the generator's input, not yet processed |
| **Processed** | 2 | Distiller | A real document rewritten into the distilled stream |
| **Synthetic** | 1 | Distiller | Distiller-generated gap fill (and the hourly seal) |

"Synthetic" means *distiller-authored*, not *inaccurate* — a synthetic document is a faithful
snapshot of real-derived state, marked synthetic only because the distiller, not BitMEX,
produced it.

The generator consumes **original** documents and replaces them: each real document is
rewritten as a **processed** copy, synthetic documents fill the silences between them, and once
an hour is fully written the originals it consumed are deleted. Behind the frontier the
collection holds only processed and synthetic documents — the continuous stream replay
consumes; ahead of the frontier it holds farmer's raw originals, waiting.

### The `_id` scheme

`_id`s come from [`shared/utils/src/mongoIds.ts`](../../shared/utils/src/mongoIds.ts). Layout
(53-bit safe integer): `_id = dateOffset · 2³⁸ + slot · 2⁸ + reserved` (`slot = position − 1`,
epoch 2000-01-01 UTC).

- The generator assigns `_id`s itself, in a single forward pass at write time (§9). It does not
  preserve farmer `_id`s and keeps no reverse mapping — none is needed.
- `position` is a per-day sequential counter assigned in stream (timestamp) order, so within a
  day `_id` order equals timestamp order. The counter resets each day; `dateOffset` dominates,
  so all of day D precedes all of day D+1.
- `reserved` is only ever `0`, `1`, or `2`. Because it occupies the low byte, `_id % 4` recovers
  it directly — the basis of the cheap filters in §2 and §9.

## 2 — The hour as the unit of work

The generator processes one hour at a time: gather the hour's data, walk it, seal it with an
anchor, advance. A ten-day outage is not a special case — it is 240 one-hour gaps, each sealed
at its boundary and processed identically. This bounds every gap to one hour by construction;
the trailing-gap and multi-day-gap special cases disappear.

A **partial** (`action: 'partial'`) is a full-state snapshot of every active instrument. The
generator seals every hour with one synthetic unfiltered partial, timestamped at the hour
boundary `HH:00:00.000`. That sealing partial is the **anchor**: the resume point (§10), and
what lets a replay consumer seed state at any hour boundary without replaying from the start.
One anchor per hour, unconditionally — so no span lacking a full snapshot is ever longer than
one hour. Source partials (BitMEX emits them) are applied to the accumulator like any other
message; the generator does not depend on finding them — it generates its own anchor every hour.

Days carry meaning in only two incidental places: the `_id` space is partitioned by day, and
import progress is tracked per day (§3). Everything else that looks day-shaped — the rolling
24 h window, the hourly anchors — is a duration or cadence, not a calendar concept.

## 3 — The universe boundary

The generator processes `[start, boundary)`. Neither end is hardcoded — both are read from the
Redis `farm:{table}:{date}` markers farmer writes as it imports into MongoDB.

- **`start`** is the hour of the first real instrument document — whatever the earliest
  instrument data we have happens to be (§10 cold start).
- **`boundary`** is the frontier of settled data: the generator must not process past the point
  any source it depends on is fully imported.

**Redis is the source of truth, not vault.** `farm:{table}:{date}` is `done:{n}` once the date
is in MongoDB, a bare `{n}` mid-import, absent otherwise. These markers are the **only** input
to the boundary. Vault is a transient staging area (files are removed once imported), so it is
never consulted; the generator works identically whether or not vault exists.

**Gating tables.** The generator reads seven tables — `instrument` and the six proxies
`compositeIndex`, `tick`, `quote`, `trade`, `funding`, `settlement`. Six gate the boundary:
`instrument` plus `compositeIndex`, `tick`, `quote`, `trade`, `funding`. `settlement` is
deliberately **excluded** — it is so sparse (often one or two dates a month) that gating on it
would hold the whole universe a month back; whatever settlement exists is consumed within the
boundary the others define. `tick` is the index-value fallback for `compositeIndex` (§6) and
gates like any other source.

**Calculation** (re-run at startup and on each idle wait, from the markers alone):

1. For each gating table, its frontier = the **day after its furthest `done` date**. Dates
   still importing are not `done`, so they don't extend the frontier; a table with no `done`
   markers never gates.
2. Universe boundary = the **minimum** of the gating-table frontiers.

Everything up to a table's furthest `done` date is taken as complete: an absent date *below* the
frontier is a real gap BitMEX never published, which the generator synthesizes rather than
waiting for. The *trailing* edge beyond the furthest `done` date is simply not yet collected —
the boundary stops there and the generator idles. This holds even though farmer imports out of
order (the frontier is the furthest `done`, not a contiguous run, so a late back-fill of an
older date never moves it backward); the trade-off is that a date imported *after* the generator
passed it needs a re-distill (§11).

## 4 — Pipeline: six actors

Data flows through six focused actors, each knowing its own job and nothing else:

- **Reader** — knows where data lives. Reads the seven source tables from MongoDB, serves them
  in hourly buckets (§5).
- **Provider** — knows how to organize data. Combines real and proxy data into one ordered
  stream, identifies gaps, owns the rolling 24 h window (§6).
- **Synthesizer** — knows how to turn a proxy event into instrument deltas. A pure,
  deterministic function (§7).
- **Merger** — collapses a millisecond's per-symbol contributions to one delta per symbol,
  last-write-wins per field. A pure function.
- **Walker** — knows how to process the stream. Drives the hour loop, owns the accumulator and
  the Conflator, applies every document, seals each hour (§8).
- **Writer** — knows how to persist. Assigns `_id`s, writes, deletes consumed originals (§9).

The Walker drives the loop: for each hour from `start` to `boundary` it pulls the hour's stream
from the Provider (which pulls raw buckets from the Reader), processes it — delegating
proxy→delta work to the Synthesizer and per-symbol collapse to the Merger — seals it, and hands
the result to the Writer. At the boundary it idles and recomputes.

## 5 — Reader: partition-aware reading

The Reader serves the oldest unserved hour's documents across all seven tables, bucketed by hour
(`timestamp.slice(0, 13)`). It reads the source **one day at a time**, and within a day splits
each table into **partitions** — contiguous `_id` ranges streamed independently. The split is
what makes symbol-major storage safe.

**The problem it solves.** The REST/S3 proxies (`compositeIndex`, `quote`, `trade`) are stored
**symbol-major**: each symbol's whole day is one contiguous `_id` run, the runs concatenated
alphabetically. Streamed as a single `_id` sequence, a cluster sorted near the end of the range
is reached only *after* serving has advanced past the early hours — so that cluster's early-hour
rows land at or before the serve frontier and are dropped unseen. The loss is the *tail* of the
symbol-major order (the alphabetically-last indices), not "most symbols." `instrument`, `tick`,
`funding`, `settlement` are time-ordered and unaffected.

**Which days are clustered is decided per `(table, day)` from the data, never from a date rule**
— BitMEX's S3 layout is inconsistent (e.g. `quote`/`trade` ran time-ordered for stretches of
2017–2018) and scribe collects `trade` unfiltered (time-ordered) from 2026-04. The clustering
key is per table (`CLUSTER_FIELD`): `compositeIndex` clusters by **`indexSymbol`** (BitMEX's
REST `?symbol=` filter on that table matches `indexSymbol`, so a basket index's `symbol` churns
*inside* each block), `quote`/`trade` by `symbol`. `mayCluster = {compositeIndex, quote, trade}`
is the only gate; every other table uses one whole-day partition.

**Discovery is index-less** — only the existing `_id` index, no `{symbol, _id}` index (dozens of
GB) and no full-day scan. It lives in its own module (`partitions.ts`); the Reader stays generic,
consuming opaque `_id` ranges:

1. **Real endpoints.** Two indexed `findOne`s (`sort _id: ±1`, projecting the cluster field)
   over the day's `_id` range give the *actual* lowest/highest used `_id` and their keys. Every
   probe stays inside `[min, max]`, so the search never wanders the sparse 38-bit slot space.
2. **Boundary search (divide and conquer).** Given two endpoints, if their keys are equal the
   whole segment is one contiguous run (no query); otherwise probe the one document nearest the
   `_id` midpoint and recurse on both halves. No document strictly between two differing
   endpoints means they are adjacent — an exact boundary. Cost ≈ `runs × log(span)` indexed
   point reads (seconds), never a scan.
3. **Classification by budget.** A `maxRuns`/`maxProbes` ceiling stops the search when
   boundaries pile up without end (the signature of time-ordered data) and the day collapses to
   one whole-day partition. The ceiling sits far above any real symbol count and far below the
   millions a time-ordered day would yield.

The classifier is an **efficiency guard, not a correctness requirement**: partitions always tile
`[min, max]` with no gaps or overlaps, and reading needs only that each partition is
**time-monotone as `_id` ascends** — true for both a clustered run (within a symbol, `_id` order
is time order) and a time-ordered range. The one genuine assumption is the symbol-major guarantee
that a symbol occupies a single contiguous run; a symbol split into two runs merely widens a
partition, never silently loses data.

**Reading.** Each partition runs the read-ahead rule independently — read until it is
`MIN_BUCKET_BUFFER` (3) hours past the serve frontier, or exhausted — all accumulating into the
table's shared hourly buckets. When every partition has read that far, the oldest bucket is
complete across all of them, so a row ≤ 3 h late within its cluster is always still in time. The
fetch is sized **per partition** (`max(MIN_PARTITION_BATCH, READ_BUDGET / partitionCount)`): a
clustered run is often smaller than a fixed batch, so an undivided budget would pull a cluster's
entire day into memory before the next horizon check — dividing it keeps a table's total fetch ≈
one budget regardless of partition count, so the warm horizon (not the batch) bounds memory.
Peak memory is ≈ `MIN_BUCKET_BUFFER / 24` of a day per table, never a whole day.

**Placement** turns on one witness, `servedThrough` (the last hour served), never a fixed start
timestamp. A row whose hour is **after** `servedThrough` joins (or opens) that hour's bucket —
even one earlier than buckets already open, so out-of-order leading hours land correctly. A row
whose hour is **at or before** `servedThrough` belongs to an already-served, sealed hour: it is
dropped and **counted** (`dropped` / `lossPct` in the daily summary, reference and trading
alike). Measured `_date_`↔`timestamp` skew is ≤ ~2 min (far under the 3 h horizon), so this is
effectively never hit in forward processing — badly disordered source days (observed in 2022) are
the only ones that shed real rows here, which is why the loss is metered rather than assumed away.
For `instrument` the Reader serves **originals only** (`_id % 4 === 0`), so it never re-reads the
generator's own output and a re-run reads the same originals.

The Reader holds no persisted cursor: on restart it re-discovers the resume day's partitions and
refills its buffers from the day's start, dropping the already-served head.

## 6 — Provider: gaps and the rolling 24 h window

The Provider yields an ordered, ready-to-walk stream for one hour. It always folds the hour's
`trade` bucket into the rolling 24 h window (kept warm even in gapless hours), and scans the
`instrument` bucket for gaps. **No gaps** → it yields the real instrument documents straight
through (the non-trade proxies go unused). **Gaps** → for each gap span it k-way merges the proxy
buckets and the materialized rolling-window output into the real documents, dropping proxy data
wherever real instrument data exists. Real data always wins.

A **gap** is a silence of at least `GAP_THRESHOLD` (≈ 1 min, tunable) between consecutive real
instrument documents within the hour. `instrument` is a dense table, so a silence this long is a
genuine candidate for missing data rather than normal sparsity. Gap detection is per-hour and
local — every hour begins with the previous hour's anchor at `HH:00:00.000`, the reference point
for the first gap. The generator synthesizes only where it adds value: filling everywhere would
cost processing and storage and produce near-duplicate no-ops wherever BitMEX was already emitting.

For the index value the Provider picks one source per hour: `compositeIndex` normally, or `tick`
for an hour where `compositeIndex` has no data at all (a BitMEX compositeIndex outage, ~5–6
days/decade). Both carry the same index value, so only one is merged; the Synthesizer treats
whichever it gets identically.

**The rolling 24 h window** reproduces BitMEX's trailing-24 h statistics (`volume24h`,
`turnover24h`, `homeNotional24h`, `foreignNotional24h`, `prevPrice24h`, `vwap`) inside a gap. It
is fed exclusively by `trade`, carried and updated every hour (gap or not) so it is warm when a
gap begins, and holds only what minute resolution needs — per-minute aggregates plus a per-minute
price for `prevPrice24h`, not every trade. The Provider materializes its output as a synthetic
**`rollingData`** source: per-trade rows (driving `lastPrice`/`lastChangePcnt`/`lastTickDirection`)
plus per-minute 24 h-stats cron rows. `rollingData` rows are produced only for gap spans; the
window itself is fed in every hour regardless.

The merged stream is totally and deterministically ordered by `(timestamp, source-priority,
_id)` — load-bearing for byte-identical re-runs (§10.1).

## 7 — Synthesizer: proxy → instrument deltas

A pure, deterministic function: a proxy row plus the instrument state it needs yields zero or
more instrument deltas. It holds no state. Per source:

- **`compositeIndex` / `tick`** → the index value, fanning out to *every* instrument referencing
  that index (1-to-N). The index is the instrument's `indicativeSettlePrice`; `markPrice` is the
  Fair Price (index + the symbol's `fairBasis`, carried from the accumulator); `limitUpPrice` /
  `limitDownPrice` ride on `markPrice` (×1.10 / ×0.90). It also emits the **index symbol's own**
  value (§8) — a direct emission, not a fan-out.
- **`quote`** → `bidPrice`, `askPrice`; `midPrice` derived from bid/ask and the symbol's
  `tickSize`.
- **`rollingData`** — these rows arrive **already shaped as instrument deltas** (per-trade
  `lastPrice`/`lastTickDirection`/`lastChangePcnt`, and the per-minute 24 h block), computed by
  the Provider's rolling window (§6), not transformed here; the Synthesizer passes them through
  and only adds the derived `lastPriceProtected` (from `lastPrice` + `markPrice`).
- **`funding`** → `fundingRate`, `fundingInterval`, `fundingTimestamp`.
- **`settlement`** → `state: 'Settled'`, `settledPrice`.

Only symbols already known from real data are synthesized — with no static seed the generator
cannot introduce a brand-new instrument; it emits `update`s only, never `insert`s. A row for an
unknown or settled symbol yields nothing. Reference (`.`-prefixed) series are **never fan-out
targets** (an index doesn't mark against another index), so they are excluded from the `refMap`.

### Mark method

The Synthesizer **branches on `markMethod`** (per symbol, carried in the accumulator's
per-symbol cache). Definitions are BitMEX's, captured verbatim in
[`FAIR_PRICE_MARKING.md`](../BitMEX/FAIR_PRICE_MARKING.md) — see [`INSTRUMENT.md`](../BitMEX/INSTRUMENT.md)
§6.4 for the per-method summary. `markFamily()` classifies the method into two families that
decide where `markPrice` comes from in a gap:

- **fair** (`FairPrice` and the index-marked fallbacks) → marked off the index, `markPrice =
  index + fairBasis`, set by the index fan-out.
- **last** (`LastPrice`/`LastPricePreLaunch`, and the best-effort fallback for `LastPriceProtected`
  / `LastPriceAdjusted`) → marked off the symbol's own trades, `markPrice = lastPrice`, set by the
  trade/rolling path (`deriveFields`) and **skipped in the index fan-out**.

A method we don't reproduce exactly degrades to the closest method in the same family — never a
fabricated formula — and the fallback is **recorded** (`recordMarkFallback`): the distinct
fallback methods used in a day surface in the `Day distilled` summary as `markFallback: [...]`,
so the approximation is auditable. One accepted simplification remains: `fairBasis` is held
constant across a gap (its decay toward funding/expiry is ignored). `LastPriceProtected`'s
maintenance-margin band + ratchet are not reproduced (best-effort `lastPrice`).

## 8 — Walker, accumulator, and conflation

The Walker drives the hour loop and owns the **accumulator** — a `bitmex-database` instrument
table holding the full current state of every instrument. Applying a `partial` resets it to that
snapshot; applying an `update` merges the change. From it the Walker derives the caches synthesis
reads (the index→symbols `refMap`, known symbols, per-symbol `tickSize`/last prices/`markMethod`,
the settled set) — all a pure projection of the accumulator, rebuilt at the start of each hour.

For each hour the Walker consumes the Provider's ordered stream, batching events by millisecond
(all events sharing a timestamp are merged per symbol by the Merger, so a quote and a trade for
one symbol at one instant become a single delta). Per entry:

- **real instrument document** → apply to the accumulator, then pass through **whole** as a
  *processed* document — every symbol, reference series included (real data already carries them
  on BitMEX's grid). Real data shortcuts synthesis and conflation entirely.
- **proxy row** → synthesize, apply the returned delta(s) to the accumulator, and emit. Trading
  deltas split into order-book fields (throttled, below) and the rest (passed through at their own
  cadence); reference deltas are throttled whole.

When the hour's stream is exhausted the Walker **seals**: snapshots the accumulator into one
unfiltered `partial` timestamped at the next hour boundary, and hands the whole hour — processed
documents, synthetic documents, and the seal — to the Writer.

### The Conflator — order book and references on a 5 s grid

Two field groups are emitted on a fixed ≈5 s grid because that is exactly what the real feed does
(see [`INSTRUMENT.md`](../BitMEX/INSTRUMENT.md) §6.1 bid/ask, §6.6 references): order-book
`bidPrice`/`askPrice`/`midPrice`, and reference index values. Everything else passes through at
its own cadence (`lastPrice` per-trade, the 24 h block per-minute, marking already index-paced at
5 s, funding/settlement as they occur). A single **`Conflator`** handles both groups uniformly,
reproducing BitMEX's emit-on-change behaviour: a value publishes a delta only when it changed
since the last emission.

`CONFLATED_FIELDS = {bidPrice, askPrice, midPrice}`. The Walker `splitConflated`s each **trading**
delta — order-book fields go to `conflator.accept`, the rest is written immediately — while a
**reference** delta (carrying only `lastPrice`/`markPrice`, neither in `CONFLATED_FIELDS`) is
`accept`ed whole. One baseline map keyed by symbol; trading and reference symbols are disjoint, so
they share the grid without collision. The conflated value is always **applied to the accumulator
immediately** (so the hour's seal carries the finest state) while its *emission* is throttled.

The Conflator is **delta-aware**, not a plain merge: per symbol it keeps a **baseline**
(last-emitted state) and an open **working** window; `accept` merges fields into the window;
`flush` (on each 5 s tick) emits only the fields that net-changed vs the baseline, advances the
baseline, and clears the window (`0→1→0` nets to nothing; `A:1; A:3` collapses to `A:3`; an
unchanged window emits nothing). `midPrice` rides along as an ordinary conflated field and stays
consistent with its bid/ask because `deriveFields` recomputes it whenever bid or ask changes.

**Gap tracking.** The Walker tracks an `inGap` flag. An all-real batch sets it false (a real
stretch — the Conflator stays idle). The first synth batch of a gap calls `conflator.reset(snapshot)`
— re-basing the baseline from the current real accumulator state and clearing any stale window —
then sets it true, so a gap's synth diffs against the latest real values and real always wins
over an earlier pending synth. Tick-flush and the hour-boundary seal are gated on `inGap`, so the
Conflator only acts while there is synth to emit. A gap continuing across an hour boundary keeps
`inGap` and is **not** re-based (the hour seal already reconciled it).

The 5 s tick is **data-driven**: as the stream's timestamps cross each grid point (anchored at the
hour boundary, a multiple of 5 000 ms) the Walker flushes the closed window, emitting in timestamp
order *before* the same-or-later batch — preserving the Writer's `_id`-order == timestamp-order
invariant. The final `xx:00:00` window is **sealed, not emitted**: the hour-boundary partial
already snapshots all conflated state, so `seal()` advances the baseline without emitting.

### Reference reconstruction

Reference (`.`-prefixed) index series are reproduced in the distilled stream. Real reference
deltas pass through whole (BitMEX already throttled them). In a gap, each index symbol's **own**
value is synthesized from the `compositeIndex` BMI tick — `{lastPrice, markPrice}` both equal the
index (no fair-basis applies to an index) — and throttled by the Conflator like order-book fields.
The reconstruction source is `compositeIndex`, collected BMI-only (`SCRIBE_INDEX_TICK_ONLY`), so
each row's `lastPrice` **is** the index value, at the same 5 s/15 s cadence as the WS stream; the
existing trading-index path is reused verbatim. The only unreconstructable references are the
**premium indices** (`…PI`/`…PI8H`/`30M`/`_NEXT`) — absent from `compositeIndex` and `tick`, with
no historic REST endpoint — so they freeze in gaps and pass through only in real stretches. The
measured referential facts this rests on (clock-locked 5 s/15 s grids, emit-on-change, the thin
price object) are in [`INSTRUMENT.md`](../BitMEX/INSTRUMENT.md) §3, §6.6.

## 9 — Writer and `_id` assignment

The Writer assigns every output document its `_id` and persists it. It keeps a per-day sequential
`position` counter; for each document in the hour's stream, in order: `position++`, then
`_id = makeMongoId(date, position, isReal ? 2 : 1)`. Because documents arrive in timestamp order,
`_id` order equals timestamp order. The counter resets each day. The hour-23 seal carries timestamp
`(D+1)T00:00:00.000` but is allocated as day D's **last** document (a synthetic `_id` can never
precede a real `_id` at the same slot, so the seal must live in day D's `_id` space to sort ahead
of day D+1's first real document).

Writes are idempotent: `insertMany` unordered, duplicate-key errors (`11000`) ignored. A re-run
produces identical `_id`s and content, so re-emitting an already-written document is a harmless
no-op.

## 10 — Determinism, sealing, and restart

### 10.1 Determinism

Every stage is a deterministic function of settled input: the Reader serves a fixed order, the
Provider's k-way merge uses a fixed total comparator, the Synthesizer and Merger are pure, the
Conflator's ticks are data-driven (never wall-clock), and the Writer's counter is a pure function
of stream position. The same hour against the same input yields byte-identical output with
identical `_id`s. This is what makes idempotent recovery possible.

The Conflator preserves this across a crash without any run-start re-seed: at every hour boundary
the baseline's conflated fields equal the accumulator's (synth conflated values are applied to the
accumulator immediately and the seal advances the baseline to match), and on resume `reset` from
the anchor partial reproduces exactly that baseline. A resumed process enters with `inGap=false`,
so tick-flushes before the first synth `accept` are skipped — safe, because the working window is
empty until the first `accept`, making those flushes no-ops either way.

### 10.2 Sealing an hour

An hour is committed through a two-phase marker in a single Redis key, `distiller_instrument`,
holding the current anchor `_id` and a phase. Sealing hour N:

1. **Write** the hour's documents (processed, synthetic, and the anchor) via idempotent `insertMany`.
2. **Mark `sealed`** — set the key to anchor N, phase `sealed` (data and anchor are durable).
3. **Delete** the hour's consumed originals — the `_id`s the Reader handed over, filtered
   `_id % 4 === 0`.
4. **Mark `complete`** — set the key to anchor N, phase `complete`.

Crash recovery falls out of the phase: a crash before step 2 reprocesses hour N in full (its
originals are untouched, partial writes absorbed by the idempotent `insertMany`); a crash between
2 and 4 finishes the job (run the delete, mark `complete`) then resumes; a crash after 4 resumes
from the hour after anchor N. The delete must never run before the `sealed` mark — deleting
originals while the key still names the previous hour would leave the re-run with no input and it
would mis-read the hour as one long gap. The `_id % 4 === 0` filter on the delete is load-bearing:
processed and synthetic documents must never be touched.

### 10.3 Bootstrap and resume

All resume state lives in the one Redis key. On start, if the phase is `sealed`, first finish that
hour (run the delete, mark `complete`); then reconstruct running state from the anchor and resume
at the hour after it. Resuming is identical to a first run — the same hour is re-processed from the
same input and produces the same result. Running state, reconstructed from the anchor:

- **Accumulator** — fetch the anchor partial by its `_id` and apply it; the derived caches come
  back with it.
- **Position counter** — `parseMongoId(anchor).position`; reset to 0 if the anchor was a day's
  final seal and the next hour falls in a new day.
- **Next hour** — the hour after the anchor's timestamp.
- **Rolling 24 h window** — replay roughly the last 25 h of `trade` through the rolling logic
  (including the per-minute crons) up to the anchor. A plain fold rebuilds the window's contents
  but not its memory (`vwap` is emitted only on change, so the last emitted value must be
  reconstructed too); replaying slightly more than 24 h keeps eviction and the final cron's 24 h
  look-back correct.
- **Conflator** — not separately restored; re-based by `reset` from the accumulator at the first
  gap after resume (§8, §10.1).
- **Universe boundary** — recomputed fresh (§3); an input, not restored state.

On a cold start (no anchor) the generator begins at the first hour with real instrument data; the
accumulator starts empty and is seeded by the first real partial in the source stream.

## 11 — Out of scope

- **Pre-2019 backfill.** Synthesizing the instrument stream *earlier* than the first real data
  (toward 2016-12-01, the proxy era) is a separate effort — feasible but needing instrument
  metadata sourced from REST (incl. expired contracts) and a seed script that manufactures a
  synthetic `reserved=0` start partial + per-`listing` inserts the generator consumes unchanged.
  Design: [`docs/planning/INSTRUMENT_BACKFILL.md`](../planning/INSTRUMENT_BACKFILL.md).
- **Re-distill after a late import.** If real instrument data arrives for hours the generator
  already sealed, the anchor must be reset before those hours and the affected range cleaned. A
  `tb` command to do this ergonomically is future work.
- **The `_partials_` collection / partials distiller.** A separate generator — see
  [`DISTILLER.md`](DISTILLER.md).
