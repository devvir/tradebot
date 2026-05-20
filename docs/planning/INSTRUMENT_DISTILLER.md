# Instrument distiller — design

## Goal

Produce a continuous `instrument` collection from `2019-04-01` to the settled
boundary, mixing **real** documents (farmer-imported) with **synthetic** ones
(distiller-generated) so there are no time gaps. Real data always wins.

The instrument stream is the primary signal for liquidation detection during
replay, so synthetic fill must preserve every price oscillation — no lossy
aggregation.

The distiller is a forward-only time walker: it advances through history one
hour at a time and never moves backward. Each hour is either observed (real
instrument data is present) or reconstructed (silences filled from the proxy
tables), and every hour is sealed with a full-state snapshot before the next
begins.

---

## 1 — Concepts

### 1.1 — Real vs synthetic, in one collection

The distiller reads and writes a single `instrument` collection. Three kinds of
document coexist there, told apart by the `reserved` byte of the `_id`:

| Kind | `reserved` | Author | Meaning |
|---|---|---|---|
| **Original**  | 0 | Farmer    | Raw imported real data — the distiller's input, not yet processed |
| **Processed** | 2 | Distiller | A real document rewritten into the distilled stream |
| **Synthetic** | 1 | Distiller | Distiller-generated gap fill |

"Synthetic" means *distiller-authored*, not *inaccurate* — a synthetic document
is a faithful snapshot of real-derived state; it is marked synthetic only
because the distiller, not BitMEX, produced it.

The distiller consumes **original** documents and replaces them: every real
document is rewritten as a **processed** copy in the distilled stream, synthetic
documents fill the silences between them, and once an hour is fully written the
originals it consumed are deleted. Behind the distiller's frontier the
collection holds only processed and synthetic documents — the continuous stream
replay consumes. Ahead of the frontier it holds farmer's raw originals, waiting.

### 1.2 — The `_id` scheme

`_id`s come from `shared/utils/mongoIds.ts`. Layout (53-bit safe integer):

```
[ dateOffset: 15 bits ][ slot: 30 bits ][ reserved: 8 bits ]
_id = dateOffset · 2³⁸ + slot · 2⁸ + reserved        (slot = position − 1)
```

- The distiller assigns `_id`s itself, in a single forward pass at write time
  (§8). It does not preserve farmer `_id`s and keeps no reverse mapping to
  source bucket positions — none is needed.
- `position` is a per-day sequential counter assigned in stream (timestamp)
  order, so within a day `_id` order equals timestamp order for the distilled
  stream. The counter resets each day; `dateOffset` dominates the `_id`, so all
  of day D precedes all of day D+1.
- `reserved` is only ever `0`, `1`, or `2`. Because `reserved` occupies the low
  byte, `_id % 4` recovers it directly — the basis of the cheap filters in §4
  and §8.
- 2³⁰ ≈ 1.07 billion slots per day — never a constraint.

### 1.3 — Partials and anchors

A **partial** is an `action: 'partial'` document — a full-state snapshot of
every active instrument. The distiller seals every hour with one synthetic
unfiltered partial, timestamped at the hour boundary `HH:00:00.000`.

That sealing partial is the **anchor**. It is the resume point (§9.3), and it
lets a replay consumer seed state at any hour boundary without replaying from
the start. One anchor per hour, unconditionally — there is no suppression rule.
Because every hour ends with an anchor, no span lacking a full snapshot is ever
longer than one hour.

Partials present in the *source* data (BitMEX emits them, filtered and
unfiltered) are applied to the accumulator like any other message; the distiller
does not depend on finding them — it generates its own anchor every hour.

### 1.4 — The hour as the unit of work

The distiller processes one hour at a time: gather the hour's data, walk it,
seal it with an anchor, advance. A ten-day outage is not a special case — it is
240 one-hour gaps, each sealed at its boundary, each processed identically to
any other hour. This collapses every "how large is the gap" question: gaps are
bounded to one hour by construction, and the trailing-gap and multi-day-gap
special cases disappear.

Days carry meaning in exactly two places, both incidental: the `_id` space is
partitioned by day (§1.2), and import progress is tracked per day (§2).
Everything else that looks day-shaped — the rolling 24h window, the hourly
anchors — is a duration or a cadence, not a calendar concept.

---

## 2 — The universe boundary

The distiller processes `[2019-04-01, boundary)`. The boundary is the frontier
of settled data: the distiller must not read past the point where any source it
depends on is not yet fully imported into MongoDB.

It reads seven tables — `instrument` and the six proxies `compositeIndex`,
`tick`, `quote`, `trade`, `funding`, `settlement`. Six of them **gate** the
boundary: `instrument` plus the five proxies `compositeIndex`, `tick`, `quote`,
`trade`, `funding`. `settlement` is sparse and never gates — it is consumed
where present.

`tick` is the index-value fallback for `compositeIndex` (§6) — a referential
index-tick stream that fills `compositeIndex` outages such as BitMEX's missing
days in March 2023. It gates like any other source: until `tick` is imported
for a date, the boundary holds short of it.

For each gating table and date, three cases:

| Case | Vault file | Redis `farm:{table}:{date}` | Effect on the boundary |
|---|---|---|---|
| Settled          | either  | `done:*`                | data is in MongoDB — safe |
| Not yet imported | present | absent / not `done:*`   | **stops the boundary here** |
| Never collected  | absent  | absent                  | skipped — does not stop the boundary |

Redis `done:*` is the sole authority for "data is in MongoDB" — a vault file may
be deleted or cold-stored after import. The vault file list is consulted only to
tell *not yet imported* (a file exists) from *never collected* (no file ever).

**Boundary calculation**, re-run at startup and on each idle wait:

1. For each of the six gating tables, list the dates with a vault bucket
   (`GET /files/{table}`).
2. Per-table boundary = the earliest such date whose `farm:` value is not
   `done:*`; or the day after the last date when every date is `done:*`.
3. Universe boundary = the minimum of the six per-table boundaries.

A never-collected date has no vault file, so it never appears as a per-table
boundary — the universe extends past it, and gap fill there simply has fewer
events to work with. Only a *not-yet-imported* file stops the universe.

The distiller processes whole hours strictly before the boundary; on reaching
it, it idles, recomputes the boundary, and resumes if it advanced.

---

## 3 — Pipeline: five actors

Data flows through five focused actors. Each knows its own job and nothing else:

- **Reader** — knows where data lives. Reads the seven source tables from
  MongoDB, serves them in hourly buckets.
- **Provider** — knows how to organize data. Combines real and proxy data into
  one ordered stream, identifies gaps, owns the rolling 24h window.
- **Synthesizer** — knows how to turn a proxy event into an instrument delta. A
  pure, deterministic function.
- **Walker** — knows how to process the stream. Drives the hour loop, owns the
  instrument accumulator, applies every document, seals each hour.
- **Writer** — knows how to persist. Assigns `_id`s, writes, deletes consumed
  originals.

The Walker drives the loop: for each hour from the universe start to the
boundary it pulls the hour's stream from the Provider (which pulls raw buckets
from the Reader), processes it — delegating proxy-to-delta work to the
Synthesizer — seals it, and hands the result to the Writer. At the boundary it
idles and recomputes.

---

## 4 — Reader

The Reader exposes one operation: `pop(hour)` returns a record of all seven
source tables' documents for that hour.

- It streams each table from MongoDB by `_id`. No `timestamp` indexes are needed
  on the proxy tables.
- It buckets documents by hour — `bucketKey = timestamp.slice(0, 13)`, e.g.
  `2026-04-01T01`.
- It keeps buckets warm by prefetching: it reads ahead until at least
  `MIN_BUCKET_BUFFER` (≥ 3) buckets per table are buffered before serving the
  earliest. With N buckets buffered, a document is mis-bucketed only if its
  `_id`-vs-timestamp skew exceeds roughly (N − 2) hours — far beyond observed
  source disorder. N is the tunable safety margin; an explicit invariant.
- For `instrument` it serves **original** documents only — it filters
  `_id % 4 === 0`. The distiller's own processed and synthetic output is
  invisible to it, so it never re-reads what the distiller has written, and a
  re-run reads the same originals the first run did.

The Reader holds no persisted cursor; on restart its buffers refill from the
next hour to process.

---

## 5 — Provider

The Provider exposes `getHourlyData(hour)`: an ordered, ready-to-walk stream for
one hour. It pulls all seven buckets via `reader.pop(hour)` and decides what to
do with them.

- It always folds the hour's `trade` bucket into the rolling 24h window (§5.2) —
  the window must stay warm even in hours with no gaps.
- It scans the hour's `instrument` bucket for gaps (§5.1).
- **No gaps** — it yields the real instrument documents straight through; the
  four non-trade proxy buckets go unused.
- **Gaps** — for each gap span it k-way merges the proxy buckets and the
  materialized `rollingData` (§5.2) into the real instrument documents, dropping
  proxy data wherever real instrument data exists. Real data always wins.

For the index value the Provider picks one source per hour: `compositeIndex`
normally, or `tick` for an hour where `compositeIndex` has no data at all — a
BitMEX compositeIndex outage. Both carry the same index value (`tick` at
1-minute resolution, `compositeIndex` finer), so only one is fed into the merge;
the Synthesizer treats whichever it gets identically.

The merged stream is totally and deterministically ordered by
`(timestamp, source-priority, _id)` — a fixed source-priority that includes the
synthetic `rollingData` source. This determinism is load-bearing: it is what
makes re-runs reproduce byte-identical output (§9.1).

### 5.1 — Gaps

Conceptually the distiller could combine all six sources at 100% and arrive at
essentially the same instrument state at every instant. It does not, for two
reasons: filling costs processing and storage, and wherever BitMEX was already
emitting instrument data the proxy-derived deltas would be near-duplicate
no-ops — wasteful to generate, store, and replay.

So the Provider synthesizes only where it adds value. A **gap** is a silence of
at least `GAP_THRESHOLD` (≈ 1 minute, tunable) between consecutive real
instrument documents within the hour. `instrument` is a dense table, so a
silence this long is a genuine candidate for missing data rather than normal
sparsity; the threshold is a constant to tune if it proves too eager.

Gap detection is per-hour and local — there is no cross-hour gap. The reference
point at the start of an hour is the hour boundary itself: every hour begins
with the previous hour's anchor at `HH:00:00.000`.

### 5.2 — The rolling 24h window

BitMEX instruments carry trailing-24h statistics — `volume24h`, `turnover24h`,
`homeNotional24h`, `foreignNotional24h`, `prevPrice24h`, `vwap` — and republish
them every minute, on a cron at `:15` past the minute, as `update` deltas.

To reproduce them inside a gap the Provider keeps a rolling 24h window, fed
exclusively by `trade` events. It is carried state, updated every hour — gap or
not — so it is always warm when a gap begins. The window holds only what minute
resolution needs: per-minute aggregates plus a per-minute price for
`prevPrice24h`, not every individual trade.

`trade` is therefore dual-purpose: every trade feeds the window, and (inside gap
spans) every trade is also a synthetic `lastPrice` / `lastChangePcnt` /
`lastTickDirection` delta.

The Provider materializes the window's output as **`rollingData`** — a synthetic
source "table": per-trade rows plus per-minute cron rows. It joins the k-way
merge as another source with no special treatment; once materialized it is just
a timestamped stream. `rollingData` rows are produced only for gap spans — in
real stretches BitMEX's own 24h updates are already present — but the window
itself is fed in every hour regardless.

---

## 6 — Synthesizer

The Synthesizer is a pure, deterministic function: a proxy row, plus the
instrument state it needs, yields zero or more instrument deltas. Same inputs,
same output, always. It holds no state of its own.

Per source:

- **`compositeIndex` / `tick`** → the index value, fanning out to *every*
  instrument referencing that index (a 1-to-N transform). The index value is
  the instrument's `indicativeSettlePrice`; `markPrice` is the Fair Price —
  the index plus the instrument's `fairBasis` (carried from the accumulator);
  `limitUpPrice` / `limitDownPrice` ride on `markPrice` (× 1.10 / × 0.90). The
  Provider supplies whichever source has data for the hour (§5).
- **`quote`** → `bidPrice`, `askPrice`; `midPrice` derived from bid/ask and the
  instrument's `tickSize`.
- **`rollingData`** → the per-trade fields (`lastPrice`, `lastTickDirection`,
  `lastChangePcnt`) and the per-minute 24h-statistics block. `lastPriceProtected`
  is derived from `lastPrice` and `markPrice`.
- **`funding`** → `fundingRate`, `fundingInterval`, `fundingTimestamp`.
- **`settlement`** → `state: 'Settled'`, `settledPrice`.

The `markPrice` mapping carries two accepted simplifications: `fairBasis` is
held constant across a gap (it is funding-derived and slow-moving), and
Fair-Price marking is assumed — a `LastPrice`-marked instrument's `markPrice`
really tracks its own last trade, which the gap fill does not reproduce.

Only symbols already known from real data are synthesized — with no static
seed, the distiller cannot introduce a brand-new instrument. It emits `update`s
only, never `insert`s. A row for an unknown or settled symbol yields nothing —
the transform is 1-to-0 in that case.

Cross-field derivations (`midPrice`, `lastPriceProtected`) need accumulator
state; the Walker supplies it, keeping the Synthesizer pure.

---

## 7 — Walker

The Walker drives the hour loop and owns the **accumulator** — a
`bitmex-database` instrument table holding the full current state of every
instrument. Applying a `partial` resets it to that snapshot; applying an
`update` merges the change. From the accumulator the Walker derives the caches
synthesis needs — the index→symbols `refMap`, the set of known symbols,
per-symbol `tickSize` and last prices, the set of settled symbols — all a pure
projection of the accumulator.

For each hour it consumes the Provider's ordered stream. It batches events by
timestamp — all events sharing a millisecond are processed together and merged
per symbol, so a quote and a trade for one symbol at the same instant become a
single delta — then, for each entry:

- **real instrument document** → apply to the accumulator, pass through
  unchanged (it becomes a *processed* document).
- **proxy row** → hand to the Synthesizer with the accumulator state it needs,
  apply the returned synthetic delta(s) to the accumulator, emit them
  (*synthetic* documents).

When the hour's stream is exhausted the Walker **seals**: it snapshots the
accumulator into one unfiltered `partial` timestamped at the next hour boundary,
and hands the whole hour — processed documents, synthetic documents, and the
seal — to the Writer.

---

## 8 — Writer

The Writer assigns every output document its `_id` and persists it.

It keeps a per-day sequential `position` counter. For each document in the
hour's stream, in order:

```
position++
_id = makeMongoId(date, position, isReal ? 2 : 1)
```

`reserved` is `2` for a real (processed) document, `1` for a synthetic one.
Because documents arrive in timestamp order, `_id` order equals timestamp order.

The counter resets each day. The hour-23 seal carries timestamp
`(D+1)T00:00:00.000` but is allocated as day D's **last** document: a synthetic
`_id` (`reserved ≥ 1`) can never precede a real `_id` at the same slot, so the
seal must live in day D's `_id` space to sort ahead of day D+1's first real
document. `generateId` is given `date = D` for it; the counter resets
afterward.

Writes are idempotent: `insertMany` unordered, duplicate-key errors (`11000`)
ignored. A re-run produces identical `_id`s and identical content, so
re-emitting an already-written document is a harmless no-op.

---

## 9 — Determinism, sealing, and restart

### 9.1 — Determinism

Every stage is a deterministic function of settled input: the Reader serves a
fixed order, the Provider's k-way merge uses a fixed total comparator
`(timestamp, source-priority, _id)`, the Synthesizer is pure, and the Writer's
counter is a pure function of stream position. The same hour against the same
input yields byte-identical output with identical `_id`s. This is what makes
idempotent recovery possible.

### 9.2 — Sealing an hour

An hour is committed through a two-phase marker in a single Redis key,
`distiller_instrument`, which holds the current anchor `_id` and a phase.
Sealing hour N:

1. **Write** the hour's documents — processed, synthetic, and the seal
   (anchor N) — via idempotent `insertMany`.
2. **Mark `sealed`** — set `distiller_instrument` to anchor N, phase `sealed`.
   This records that the hour's data and its anchor are durable.
3. **Delete** the hour's consumed originals — the `_id`s the Reader handed
   over, filtered `_id % 4 === 0`.
4. **Mark `complete`** — set `distiller_instrument` to anchor N, phase
   `complete`.

Crash recovery falls out of the phase:

- Crash before step 2 — the key still names hour N−1, `complete`. Hour N is
  reprocessed in full; its originals are untouched (the delete is step 3) and
  the partially-written documents are absorbed by the idempotent `insertMany`.
- Crash between steps 2 and 4 — the key reads anchor N, `sealed`. The data and
  the anchor are durable; bootstrap finishes the job — run the delete (a no-op
  if it already ran), mark `complete` — then resumes from anchor N.
- Crash after step 4 — `complete`; resume from the hour after anchor N.

Every failure point reduces to one of two safe outcomes: reprocess the whole
hour, or finish a `sealed` hour's cleanup. The delete must never run before the
`sealed` mark — deleting the originals while the key still names the previous
hour would leave the re-run with no input, and it would mis-read the hour as one
long gap and re-synthesize it whole.

The `_id % 4 === 0` filter on the delete is load-bearing: processed and
synthetic documents must never be touched.

### 9.3 — Bootstrap and resume

All resume state lives in the one Redis key `distiller_instrument` — the anchor
`_id` of the last processed hour and its phase (§9.2). Nothing else is
persisted: the universe boundary is recomputed, the Reader's buffers refill from
the next hour, the position counter and next hour are read from the anchor, and
the rolling window is replayed. The key stays small by design — the rolling
window is far too large to belong in it.

On start:

- If the phase is `sealed`, first finish that hour — run the delete, mark
  `complete`.
- Reconstruct running state from the anchor (below), then resume at the hour
  after it.

Resuming is identical to a first run: the same hour is re-processed from the
same input and produces the same result, until the work advances past where the
crash happened.

Running state, reconstructed from the anchor:

- **Accumulator** — fetch the anchor partial by its `_id` and apply it. It is a
  full snapshot, so the derived caches (`refMap`, known symbols, last prices,
  settled set) come back with it.
- **Position counter** — `parseMongoId(anchor).position`; reset to 0 if the
  anchor was a day's final seal and the next hour falls in a new day.
- **Next hour** — the hour after the anchor's timestamp.
- **Rolling 24h window** — replay roughly the last 25 hours of `trade` through
  the rolling logic, *including the per-minute crons*, up to the anchor. A plain
  fold of trades rebuilds the window's contents but not its memory: `vwap` is
  emitted only when it changes, so the last emitted value must be reconstructed
  too, or the first cron after a resume emits a `vwap` a non-crashed run would
  have suppressed. Replaying slightly more than 24h keeps eviction and the final
  cron's own 24h look-back correct at the boundary.
- **Universe boundary** — recomputed fresh (§2); it is an input, not restored
  state.

On a cold start (no anchor in Redis) the distiller begins at the first hour with
real instrument data; the accumulator starts empty and is seeded by the first
real partial in the source stream.

---

## 10 — Out of scope

- **Re-distill after a late import.** If real instrument data arrives for hours
  the distiller has already sealed, the anchor must be reset before those hours
  and the affected range cleaned. A `tb` command to do this ergonomically is
  future work.
- **The `_partials_` collection / partials distiller.** A separate concern,
  designed elsewhere.
