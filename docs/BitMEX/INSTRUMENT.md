# BitMEX `instrument` feed — reference

The single source of truth for **how the BitMEX `instrument` feed behaves**: its message
model, its fields and what they mean, the cadence/emission pattern of each, and how those
fields relate to the other collected tables (the *proxy* sources). It exists so we stop
re-discovering the same facts every time we touch the instrument table or the distiller.

**Scope.** This describes the feed *as it is*. It is **not** the distiller design — for how
we reconstruct instrument data in gaps (including how the synthetic stream is throttled to
match these cadences) see the instrument distiller docs under `docs/services/`, and the
mark-price spec in [`FAIR_PRICE_MARKING.md`](FAIR_PRICE_MARKING.md). Understanding
*this* document is what makes those decisions legible.

## Verification convention

Every non-trivial behavioural claim is tagged:

- **(measured)** — verified this project against the real self-collected WS vault
  (`/storage/bitmex/vault/instrument/2026/*.csv.gz`) and/or the collected proxy tables in
  Mongo (`tradebot.*`). Reproducible.
- **(schema)** — the field exists and its meaning is per BitMEX's published API schema; we
  rely on BitMEX docs for the semantic, not independent measurement.
- **(unverified)** — stated for completeness but neither measured nor confidently known.
  Treat as a lead, not a fact. **Do not promote these to facts without checking.**

Field semantics below are **(schema)** unless tagged otherwise; cadence/emission claims are
**(measured)** unless tagged otherwise.

---

## 1 — What the feed is

`instrument` is BitMEX's per-contract state object. One row per instrument (perpetual swap,
future, index, etc.) carrying its **full state**: static contract specification, lifecycle,
margin/fee parameters, funding, live prices, order-book top, 24 h statistics, marking, and
open interest — ~100 columns in one record. It is delivered over the WebSocket `instrument`
table and, historically, via REST `/instrument`.

It is a **stateful, delta-compressed** feed: a consumer builds the current object by applying
a `partial` snapshot then a stream of sparse `update` deltas. It is **not** a per-event log;
it is a *sampled projection* of many underlying processes (the order book, the trade tape,
the index, funding, settlement), each of which BitMEX exposes separately and at higher
fidelity in its own stream. That distinction — instrument as a conflated digest of richer
underlying streams — is the central fact this document exists to make precise (§5–§6).

## 2 — Message model

### 2.1 Actions

The WS table emits four actions (measured frequencies over a full day, 2026-04-01, XBTUSD
universe ~1,755 instruments):

| action | meaning | frequency (measured) |
|---|---|---|
| `partial` | full-state snapshot of **every** active instrument; sent on (re)subscribe | rare — 16 that day (≈ one per WS (re)connection) |
| `update` | a delta: the key (`symbol`) + **only the changed fields** | the workhorse — 5,577,555 that day |
| `insert` | a genuinely new listing | rare — 24 that day |
| `delete` | a delisting | **not observed** in any sampled day; shape **(unverified)** |

`keys: ["symbol"]` — `symbol` is the primary key; a delta carries it plus whatever changed.

### 2.2 Emit-on-change, sparse deltas

An `update` carries **only the fields whose value changed**, never the full object (measured:
the vast majority of update rows populate 1–5 columns). A field that does not change is not
re-sent. So an observed gap in a field's emissions means "unchanged," not "missing." This is
true per-field, not per-message: one update can carry `lastPrice` while another simultaneously
carries `bidPrice`/`askPrice` — different underlying processes, different messages.

### 2.3 Vault CSV representation

Our collector flattens each WS message to CSV (`/storage/bitmex/vault/instrument/`):

- Columns: `_date_, _action_, <all ~100 instrument fields…>, timestamp`.
- **`_date_`** — the collector's *receive* time. **`timestamp`** (last column) — BitMEX's
  *event* time. Their difference is collection skew (measured: sub-second typically, ≤ ~2 min
  worst case under a collection-lag event; never hours).
- One WS message → **one or more CSV rows**: a delta is always single-item → **one row** with
  only changed columns populated. A `partial` is **multi-row** — the first row carries
  `_date_` + `_action_=partial` + the first instrument; each continuation row has **empty
  `_date_` and `_action_`** and carries exactly one more instrument. (measured: one partial ≈
  1,738 continuation rows for ~1,738 active instruments.)

### 2.4 Ordering and skew

The carried `timestamp` *is* the emission time — there is no "stamped at hour X but emitted at
hour Y" (measured: `|_date_ − timestamp|` < 60 s for ~99–100 % of deltas, worst case ~2 min,
identical for trading and reference symbols — it's a collection-lag trait, not per-symbol).
BitMEX timestamps are fixed-width ISO-8601 UTC, so lexicographic order = chronological order.

## 3 — Symbol taxonomy

A symbol is **referential** iff it starts with `.` (e.g. `.BXBT`, `.BLINKT`, `.BVOL24H`,
`.ETHUSDPI8H`), **trading** otherwise (`XBTUSD`, `ETHUSD`, `XBTM19`). There is no third
category (measured). The two differ in **field content** and **cadence**, not message
structure:

- **Trading instrument** — a *rich market object*: order book, volume/turnover, OI, funding,
  fair/settle prices, lifecycle `state`, plus the contract spec. ~40+ populated fields.
- **Reference (index) instrument** — a *thin price object*: an index value and a few derived
  stats (`lastPrice`, `markPrice` (= `lastPrice` for indices), `lastChangePcnt`,
  `prevPrice24h`, `highPrice`, `lowPrice`). **No** order book, funding, OI, or settlement.
  (measured: referential-only fields = none; the ~7 it carries are a subset of the trading set.)

Reference families seen in partials (measured): the **premium-index** family dominates —
names containing `PI`, ending `PI8H`, `30M`, `_NEXT` — alongside the BMI composites (`.BXBT`,
`.BETH`, …). This matters for derivability (§5.4, §7).

## 4 — Fields

Grouped by role. **Static** = set at listing, rarely/never changes. **Slow** = changes on a
schedule or rarely. **Live** = market-driven, the focus of §6. Cadence column applies to the
live/slow groups and is **(measured)** where given.

### 4.1 Identity & lifecycle (static/slow)

`symbol`, `rootSymbol`, `instrumentID`, `state`, `typ` (contract-type code, e.g. perpetual
vs future vs index), `listing`, `front`, `expiry`, `settle`, `listedSettle`, `relistInterval`,
`launchingTimestamp`, `publishTime`. `state` is the lifecycle (`Open`, `Settled`, `Unlisted`,
…); it changes at lifecycle events (slow).

### 4.2 Underlying & quote definition (static)

`positionCurrency`, `underlying`, `quoteCurrency`, `underlyingSymbol`, `settlCurrency`,
`reference` (the index provider/source), `referenceSymbol` (the index this contract marks
against, e.g. `.BXBT`). `referenceSymbol` is **load-bearing**: it links a trading instrument
to its index (§5.3).

### 4.3 Contract specification (static/slow)

`maxOrderQty`, `minPrice`, `maxPrice`, `lotSize`, `tickSize`, `minTick`, `multiplier`,
`underlyingToPositionMultiplier`, `underlyingToSettleMultiplier`, `quoteToSettleMultiplier`,
`isQuanto`, `isInverse`. `isInverse`/`isQuanto` and the multipliers define the contract's PnL
math (inverse vs linear vs quanto). `tickSize` evolves over an instrument's life (measured
elsewhere: e.g. XBTUSD tickSize moved 0.5 → 0.1) — so it is **slow, not strictly static**.

### 4.4 Margin, risk, fees (slow)

`initMargin`, `maintMargin`, `riskLimit`, `riskStep`, `limit`, `taxed`, `deleverage`,
`makerFee`, `takerFee`, `settlementFee`. `maintMargin` is referenced by the protected-mark
band (§6.5). These change on risk-policy updates (slow).

### 4.5 Funding (perpetuals)

`fundingRate`, `fundingInterval`, `fundingTimestamp`, `indicativeFundingRate`,
`fundingBaseSymbol`, `fundingQuoteSymbol`, `fundingPremiumSymbol`, `fundingBaseRate`
**(unverified semantic)**, `fundingQuoteRate` **(unverified semantic)**, `rebalanceTimestamp`,
`rebalanceInterval`. Funding applies to perpetual swaps: `fundingRate` is the rate applied at
each `fundingInterval` boundary (8 h on most perps), `fundingTimestamp` the next funding time,
`indicativeFundingRate` the live estimate for the next interval.

### 4.6 Last-trade price (live)

`lastPrice`, `lastPriceProtected`, `lastTickDirection`, `lastChangePcnt`, `prevClosePrice`,
`prevPrice24h`, `highPrice`, `lowPrice`. `lastPrice` is the last traded price;
`lastTickDirection` the up/down classification; `lastChangePcnt` the 24 h change;
`lastPriceProtected` a banded last price (see §6.5). **Cadence: trade-driven (measured)** — §6.2.

### 4.7 Order-book top & impact (live)

`bidPrice`, `askPrice`, `midPrice`, `impactBidPrice`, `impactMidPrice`, `impactAskPrice`,
`hasLiquidity`. `bid/ask` are the top of book; `midPrice` the mid; the `impact*` prices are the
average fill price for the impact notional (used in fair-price/funding calc). **Cadence: 5 s
grid (measured)** — §6.1.

### 4.8 Volume & turnover — the 24 h rolling block (live)

`volume`, `volume24h`, `turnover`, `turnover24h`, `totalVolume`, `totalTurnover`,
`homeNotional24h`, `foreignNotional24h`, `vwap`, `prevPrice24h`. The `*24h` set + `vwap` form a
**rolling-24 h statistics block**; `total*` are lifetime running totals; `volume`/`turnover`
(no suffix) are the latest increment. **Cadence: ~per-minute computed cron (measured)** — §6.3.

### 4.9 Marking & fair price (live)

`markMethod`, `markPrice`, `fairMethod`, `fairBasis`, `fairBasisRate`, `fairPrice`,
`indicativeSettlePrice`, `referencePrice`, `limitUpPrice`, `limitDownPrice`. **`markMethod`
selects how `markPrice` is computed** — the central marking decision; full spec in
[`FAIR_PRICE_MARKING.md`](FAIR_PRICE_MARKING.md), summarized in §6.4. `fairBasis` is the
absolute fair-value premium over the index; `fairPrice` = index + `fairBasis`;
`indicativeSettlePrice` tracks the index; `limitUp/DownPrice` are the price bands (±10 % of the
mark, measured). **Cadence: 5 s server cron (measured)** — §6.4.

### 4.10 Open interest (live)

`openInterest` (open contracts), `openValue` (their value). **Cadence: dense and irregular —
median ~3 s, ranging ~1–8 s (measured, XBTUSD 06-10; min gap 24 ms, so it can burst).**
**Not derivable from any proxy** (§5.5, §7).

### 4.11 Settlement (event)

`settledPrice`, `settledPriceAdjustmentRate` **(unverified semantic)**, `instantPnl`
**(unverified semantic)**. Populated at settlement events; for options the `settlement` source
also carries `optionStrikePrice`/`optionUnderlyingPrice` (measured in the settlement table).

### 4.12 Spread legs

`farLegSymbol`, `nearLegSymbol` — populated for calendar-spread instruments; identify the two
legs. Static per spread.

## 5 — Source (proxy) tables and the derivability map

BitMEX exposes the *underlying* processes the instrument digest samples, and we collect them
as separate tables. Schemas below are **(measured)** — sampled from `tradebot.*`:

| table | fields (measured) | what it is |
|---|---|---|
| `quote` | `timestamp, symbol, bidSize, bidPrice, askPrice, askSize` | top-of-book stream, ~50 ms-conflated public tier — **denser than instrument's bid/ask** |
| `trade` | `timestamp, symbol, side, size, price, tickDirection, trdMatchID, grossValue, homeNotional, foreignNotional` | the trade tape — one row per execution |
| `compositeIndex` | `timestamp, symbol, indexSymbol, reference, lastPrice, logged` | index values. We keep only `reference:'BMI'` rows (the composite value); per-exchange constituents are dropped at collection (`SCRIBE_INDEX_TICK_ONLY`). `lastPrice` **is** the index value |
| `tick` | `timestamp, symbol, price, tickDirection` | a coarse (~1-min) downsample of index values; **fallback** for `compositeIndex` only on the ~5–6 days/decade BitMEX missed publishing it |
| `funding` | `timestamp, symbol, fundingInterval, fundingRate, fundingRateDaily` | realized funding rate per interval |
| `settlement` | `timestamp, symbol, settlementType, settledPrice, optionStrikePrice, optionUnderlyingPrice` | settlement events (sparse — often 1–2 dates/month) |

Note the **`logged` vs `timestamp` split on `compositeIndex`** (measured, documented in
`reference_bitmex_rest_logged_clock`): REST sorts/filters that table on `logged` (insertion),
not `timestamp` — relevant when reasoning about its ordering, not its values.

### 5.1 Derivability classes

Mapping each live instrument field group to its source and whether the instrument value can be
reconstructed from what we collect:

| instrument field group | source | derivable? |
|---|---|---|
| `bidPrice`/`askPrice`/`midPrice` | `quote` | **Yes** — directly; quote is *denser* than instrument (§6.1), so reconstruction means *sampling* it to the instrument cadence |
| `lastPrice`/`lastTickDirection`/`lastChangePcnt` | `trade` | **Yes** — directly per trade |
| 24 h block (`volume24h`/`turnover24h`/`vwap`/notionals/`prevPrice24h`) | `trade` | **Yes** — by aggregating the trade tape over a rolling 24 h window |
| `markPrice` (fair-marked) / `fairPrice` / `indicativeSettlePrice` / limit bands | `compositeIndex` (+ carried `fairBasis`) | **Partial** — `markPrice = index + fairBasis`; `fairBasis` itself is **not** in a proxy (carried from last real value, treated constant — see §6.4 caveat) |
| `markPrice` (last-price-marked) | `trade` | **Yes** — equals `lastPrice` for the LastPrice family (§6.4) |
| `fundingRate`/`fundingInterval`/`fundingTimestamp` | `funding` | **Yes** — directly |
| `state`/`settledPrice` | `settlement` | **Yes** — directly (sparse) |
| reference (`.`-symbol) `lastPrice`/`markPrice` | `compositeIndex` (BMI) | **Yes for BMI composites; No for premiums** (§5.4) |
| `openInterest`/`openValue` | — | **No** (§5.5) |
| static/slow contract spec, margin, fees, multipliers, lifecycle | — | **Not derived** — carried from the last real value; sourced from REST `/instrument` for backfill (see `INSTRUMENT_BACKFILL.md`) |

### 5.3 The index→contracts fan-out

`referenceSymbol` links each trading instrument to its index. One `compositeIndex` value for
`.BXBT` therefore informs **every** instrument whose `referenceSymbol` is `.BXBT` (XBTUSD,
XBTM19, …). This 1-to-N relationship is intrinsic to the feed: a single index tick drives a
mark/limit/indicativeSettle update across all referencing contracts (and the index symbol's
own reference row). Reference series are **never** fan-out targets (an index doesn't mark
against another index).

### 5.4 Reference symbols — what's reconstructable

(measured; how the distiller uses this is in
[`DISTILLER_INSTRUMENT.md`](../services/DISTILLER_INSTRUMENT.md) §8)

- **BMI composites** (`.BXBT`, `.BLINKT`, …) — present in `compositeIndex` as the `BMI` value;
  `lastPrice` is the index. Reconstructable. For an index symbol, `markPrice == lastPrice ==
  index` (no fair-basis applied to indices — measured).
- **Premium family** (`…PI`, `…PI8H`, `30M`, `_NEXT`) — **not** in `compositeIndex` (confirmed
  zero rows) and **not** in `tick`. BitMEX exposes current premium values via REST, but **no
  historic endpoint** exists. **Not reconstructable for past gaps.**

### 5.5 Open interest — why it can't be derived

`openInterest` is the count of open contracts. A trade does **not** reveal whether it *opens*
or *closes* interest (a fill can be open↔open, open↔close, or close↔close), so OI cannot be
integrated from the `trade` tape, and no other proxy carries it. It is a server-maintained
aggregate available **only** in the instrument stream itself. (measured: it updates densely and
irregularly — median ~3 s, ~1–8 s, XBTUSD 06-10 — a fidelity we cannot match.)

## 6 — Cadences & emission patterns

The heart of this document. Each live field group has its **own** cadence, driven by a
distinct underlying process. All measured on the real WS vault (XBTUSD/ETHUSD/SOLUSDT/others,
multiple 2026 dates). The discriminator between a "grid" field and an "event" field is the
**minimum inter-emission gap**: a grid field never emits faster than its grid; an event field
can burst sub-millisecond.

### 6.1 Order book: bid/ask — a clean 5 s emit-on-change grid

(measured) Per-symbol, `bidPrice`/`askPrice` ride a **fixed 5 s grid** with a per-symbol phase
offset, emitting only when the top of book changed since the last grid point:

- Full-day 06-10: XBTUSD 15,865 bid/ask updates, **99.86 %** of inter-update gaps are 5 s
  multiples (5000 ms, or 10000/15000/… where it didn't change); SOLUSDT 99.84 %.
- 100 % on-grid in calmer 10-min windows (05-05: ETHUSDT, XBTUSD).
- The ~0.15 % off-grid emits come in **compensating pairs that sum to 5000 ms** (e.g.
  3582 + 1418): a current bid/ask occasionally *rides along* with a message triggered by some
  other, less-dense field, splitting one interval; the grid resumes on phase afterward. A
  **rider effect, not variable conflation.** Earlier "variable conflation / sub-5 s" claims
  were this rider effect and are **rejected**.

Crucially, the **`quote` proxy is far denser**. The quote→instrument ratio **just tracks
liquidity** — it is not a fixed throttle constant. Measured 05-05 10:00–10:15: XBTUSDT 21,770
quotes → 153 bid/ask (**142:1**), TONUSDT 4,343 → 177 (**24:1**), ETHUSDT 2,591 → 154 (**17:1**).
The invariant is the *output*: ~130–180 bid/ask updates per 15 min (one per 5 s grid point)
**regardless of symbol or quote volume**. So instrument bid/ask is a **5 s sample of the live
book**, and a consumer must **not** depend on it for tick-by-tick top-of-book — that resolution
simply isn't there in the real feed.

### 6.2 Last trade: lastPrice — trade-driven, emit-on-change

(measured) `lastPrice`/`lastTickDirection`/`lastChangePcnt` track the **trade tape**, not a
clock: minimum inter-emission gap **0 ms** (sub-ms bursts at *different* prices — impossible
for a grid field; XRPUSDT 06-10: min gap 0 ms, 85 same-millisecond emissions in the day),
emitting on **price change** (consecutive same-price trades coalesced). So real instrument **is** a dependable
per-price-move source at trade granularity — a consumer can rely on it for that, and a faithful
reconstruction must match it (not down-sample to a grid).

### 6.3 24 h statistics block — ~per-minute computed cron

(measured) `volume24h`/`turnover24h`/`vwap`/`prevPrice24h`/notionals refresh on a roughly
**per-minute** cron (XBTUSD minGap ~60 s; quieter symbols irregular ~25–76 s — the sub-minute
emits are sporadic, not a reliable finer cadence). These are *computed aggregates* over the
trailing 24 h, not samples of a single value, so they re-emit when the window's content shifts
(new trades in, old trades aging out). Per-minute is the dependable cadence.

### 6.4 Marking — 5 s server cron, method-dependent source

(measured cadence; spec in [`FAIR_PRICE_MARKING.md`](FAIR_PRICE_MARKING.md)) `markPrice`,
`indicativeSettlePrice`, `fairBasis` ride a **clean 5 s server cron** — the same fixed 5 s grid
as bid/ask (§6.1), including the same rare (~0.15 %) rider effect: full-day 06-10 markPrice has
16,376/16,404 (XRPUSDT) and 17,028/17,056 (XBTUSD) inter-update gaps on the 5 s grid, with ~22–24
off-grid riders that compensate back to phase. So marking is index-paced at 5 s, not faster.
Where `markPrice` comes from depends on **`markMethod`** (schema + FAIR_PRICE_MARKING.md):

- **`FairPrice`** (dominant since ~2017) → `markPrice = index + fairBasis` (fair family).
- **`LastPrice` / `LastPricePreLaunch`** → `markPrice = lastPrice` (follows the contract's own
  trades, not the index — a persistent minority all eras, e.g. `XBT7D_*`).
- **`LastPriceProtected`** → `lastPrice` clamped to a ±0.5·`maintMargin` band around fair price
  **with a ratchet** (path-dependent).
- **`LastPriceAdjusted`** → a yield-swap formula needing a Yield Index **not in our proxies**.
- **`IndicativeSettlePrice`** → seen as a `markMethod` in old 2016 data, **not in the current
  spec**; legacy/**(unverified)**.

**Caveat (measured-adjacent):** `fairBasis` is not in any proxy. In our own data it is carried
from the last real value and treated **constant** through a gap, but fair value actually decays
toward the index as a future approaches expiry — so a long fair-marked reconstruction drifts.
This is an accepted approximation, documented here so it isn't mistaken for a bug.

### 6.5 lastPriceProtected

(schema) A banded `lastPrice` that cannot move more than a margin-derived band away from the
mark — `min(max(lastPrice, mark·(1−b)), mark·(1+b))`. (Our reconstruction uses a fixed band as
an approximation; the exact band is `maintMargin`-derived.)

### 6.6 Reference (index) symbols — clock-locked grid, emit-on-change

(measured over three full days of WS-origin ghost buckets, ~9.6 M referential deltas)
A reference (`.`-symbol) index is **recomputed on a fixed per-symbol grid** and emits a delta
**only when its value changed** since the last grid point — throttled, quantized emission, as
opposed to a trading symbol's free-running event stream:

- **Clock-locked grid.** Each reference symbol carries a per-symbol base tick; its `timestamp`s
  land on an exact grid (proven by phase-lock: `timestamp mod base` concentrates at ~0). Active
  per-instrument indices (`.BLINKT`) sit on a **5 s** grid; some families (`.BCHUSDPI`,
  `.BVOL24H`) on **15 s**; long-interval families (`…PI8H`, `…30M`, `…_NEXT`) emit only a
  handful of times a day.
- **Emit-on-change, never republished.** A quiet index stays silent across unchanged ticks —
  `.BUSUALT` is on the 5 s grid but emits ~224×/day, not the ~17,280 a fixed-5 s republish would
  give. So a gap in a reference symbol's emissions means "value unchanged," not "missing." An
  `update` carries only `lastPrice`, `markPrice` (= `lastPrice` = the index, §3), and
  `lastChangePcnt` *only on ticks where it moved*.
- **⚠ `publishInterval` does NOT describe the observed cadence — do not use it.** It is a
  declared field whose exact meaning is unverified and which contradicts measurement: `.BLINKT`
  declares `1min` but emits every **5 s**; `.BCHUSDPI` declares `1min` but goes silent up to
  **18 min** (emit-on-change). Measure cadence empirically from `timestamp`, or take it from the
  `compositeIndex` source (whose BMI tick matches the WS grid — e.g. `.BLINKT` 5 s in both).

### 6.7 Cadence summary

| field group | cadence | mechanism |
|---|---|---|
| `bidPrice`/`askPrice`/`midPrice` | **5 s grid**, emit-on-change | sample of live book |
| `lastPrice` family | **per-trade**, emit-on-change (price) | trade tape |
| `markPrice`/`indicativeSettlePrice`/`fairBasis`/limits | **5 s server cron** | index recompute |
| 24 h block (`volume24h`/`turnover24h`/`vwap`/…) | **~per-minute cron** | rolling-24 h aggregate |
| `openInterest`/`openValue` | **~3 s median (1–8 s, irregular)** | server aggregate (not derivable) |
| `fundingRate`/funding fields | per `fundingInterval` (8 h typ.) | funding calc |
| `state`/`settledPrice` | settlement events (rare) | settlement |
| reference (`.`-symbol) `lastPrice`/`markPrice` | **per-symbol 5 s/15 s grid**, emit-on-change | index recompute (§6.6) |
| contract spec / margin / fees / lifecycle | rare / on policy change | static-ish |

The single highest-volume field is **bid/ask**, sampled to a 5 s grid while its `quote` proxy
runs far denser (the ratio tracks liquidity — 17:1 to 142:1 across symbols, §6.1 — not a fixed
constant); `lastPrice` is ~1:1 with trades; the 24 h block is aggregated to per-minute; marking
is index-paced at 5 s. This cadence map is *why*
reconstruction throttles bid/ask but passes trade/funding/settlement through, under the
guiding principle that the synthetic stream must be dependable for *precisely* what the real
stream is — no denser (a false dependability signal) and no sparser (a real gap).

## 7 — Limitations & special care (read before trusting instrument data)

1. **Instrument is a digest, not ground truth, for book and trades.** Bid/ask is a 5 s sample;
   for true top-of-book use `quote`, for true executions use `trade`. Do not infer sub-5 s book
   moves from instrument.
2. **`openInterest`/`openValue` and the `…PI` premium indices are not reconstructable** from our
   proxies (§5.5, §5.4). In synthesized stretches they are **frozen** at their last real value —
   expected, not a bug.
3. **`fairBasis` is carried constant** in reconstruction; real fair value decays toward index
   near expiry → drift on long fair-marked gaps (§6.4).
4. **`markMethod` matters.** A contract marked off `lastPrice` (LastPrice family) does **not**
   move with the index; treating all marks as `index + fairBasis` is wrong for that minority.
   `LastPriceProtected`/`LastPriceAdjusted` have band/yield mechanics we approximate or cannot
   reproduce (§6.4).
5. **Tier/conflation differences between sources.** Some externally-sourced instrument data
   (e.g. tardis) is a *less-conflated* tier than our own 50 ms-public collection and is not
   1:1 mergeable (documented in `project_tardis_conflation_tier`); and ghost-subscription bugs
   have duplicated some local instrument days (`project_ghost_subscription_days_2026`). Know
   which tier a given file is before reconciling counts.
6. **`_date_` ≠ `timestamp`.** Use `timestamp` (BitMEX event time) for all time logic; `_date_`
   is collection time and lags by sub-second to ≤ ~2 min.
7. **Reference vs trading is by leading `.` only** — there is no other discriminator, and
   reference symbols carry only a thin price subset (§3), never book/OI/funding.
8. **`delete` action shape is unverified** — never observed; don't assume its structure.

## 8 — Related documents

- [`FAIR_PRICE_MARKING.md`](FAIR_PRICE_MARKING.md) — verbatim BitMEX mark-price spec.
- [`WS_TABLES.md`](WS_TABLES.md) — partial semantics across all WS tables.
- [`docs/services/DISTILLER_INSTRUMENT.md`](../services/DISTILLER_INSTRUMENT.md) — how we
  reconstruct instrument data in gaps (the "how" to this doc's "what/why").
- [`docs/planning/INSTRUMENT_BACKFILL.md`](../planning/INSTRUMENT_BACKFILL.md) — sourcing
  static/structural fields from REST for pre-2019 backfill.
