# Synthetic Market Data Backfilling

## Problem

Real orderbook data collection started **8 March 2026**. Prior to that, we have:

| Dataset | From |
|---|---|
| `trade` | November 2014 |
| `quote` | November 2014 |
| `funding` | ~2016 |
| `compositeIndex` | ~2016 |
| `orderBookL2` | March 2026 |

Training bots on real OB data is bottlenecked by date — we will always have far more trade/quote history than OB history. The goal of this work is to extend the training surface backwards using data we do have, while maintaining **hard compatibility constraints** with real executed trades.

---

## Core Principle: Compatibility Constraints

A synthetic orderbook is **compatible** with the trade history if:

> At the exact moment of every real trade (price P, size Q, side S), the synthetic book contains at least size Q at price P on the correct side.

Nothing else is constrained. This gives us a lot of freedom to fabricate everything between real events.

---

## Phase 1 — Baseline Orderbook (Deterministic)

The baseline is the minimal synthetic book that satisfies all compatibility constraints and nothing else. It makes no attempt to be realistic beyond what the trades force.

### Algorithm

1. **Forward pass over `trade` collection**, sorted by timestamp ascending.
2. Maintain two maps: `bids: Map<price, size>` and `asks: Map<price, size>`.
3. For each trade `(timestamp, side, price, size)`:
   - If side is **Buy** (taker bought, maker sold): the level `asks[price]` must have had at least `size` at this moment.
     - If `asks[price]` is not yet in the book, set `asks[price] = size` **retroactively from the earliest available timestamp** (in practice: emit an insert at `t=0` or at the start of the current trading session).
     - Subtract `size` from `asks[price]`. If `asks[price] <= 0`, emit a **delete** event at this timestamp and remove from map.
   - Mirror for **Sell** trades on the bid side.
4. Levels that remain in the map at the end of the dataset are never consumed — treat them as resting orders still present at the latest timestamp.

### Output format

The baseline is stored in the same `orderBookL2` WS message format used by the collector. This means it can be fed directly into the existing reconstruction engine.

### Properties

- Every price level in the baseline was traded at least once → no phantom levels
- The book is always sparse — only levels that will eventually be hit exist
- No bid/ask spread management — bids and asks can overlap (unrealistic but compatible)
- Retroactive inserts: a level set at t=0 means "we don't know when it was placed, so we assume it was always there"

---

## Phase 2 — Noise Passes (Stochastic)

Each noise pass augments a baseline (or previous noisy version) while preserving all compatibility constraints. Multiple independent noise passes over the same baseline produce multiple distinct but equally-valid training samples.

### Invariant check

Before any modification: record the full set of compatibility constraints as `(timestamp, side, price, min_size)` tuples derived from the trade history. After every noise pass, verify no constraint is violated.

### Noise operations

**Size fluctuation on existing levels:**
- For a level at price P, baseline size Q, consumed at time T:
  - Insert random size updates between `[insert_time, T)` — any value ≥ 1
  - The final value at T must be exactly Q (the real execution amount)
  - Simple model: Brownian motion clamped to [1, Q*3], ending at Q

**Temporary disappearance:**
- A level may be deleted and re-inserted any number of times before T
- Constraint: must be present at T with correct size
- This models limit order cancellations and re-placements

**Phantom levels (never traded):**
- Insert/update/delete freely at any price not subject to a compatibility constraint
- These are the majority of real OB activity (most limit orders are cancelled)
- Price distribution: cluster around mid-price with exponential decay outward
- Size distribution: power law (many small, few large)
- Lifetime distribution: exponential (many short-lived, few long-lived)
- Parameters can be fitted to real OB data once we have enough (post-March 2026)

**Spread modelling:**
- The baseline may have crossing bids/asks (unrealistic)
- A noise pass can enforce a minimum spread by offsetting phantom levels
- Real spread data is available from `quote` collection → can be used to parameterise

---

## Phase 3 — Calibration from Real OB Data

Once sufficient real OB data accumulates (months to years), fit the noise parameters to real statistics:

| Parameter | Source |
|---|---|
| Phantom level density (levels per price tick) | Real OB snapshots |
| Phantom order size distribution | Real OB size histogram |
| Phantom order lifetime distribution | Track insert→delete intervals |
| Cancellation rate | (inserts - fills) / inserts |
| Spread distribution | `quote` collection (available from 2014) |
| Depth decay away from mid | Real OB snapshots |

These parameters can be fitted per symbol and per market regime (trending vs ranging, high vs low volatility).

---

## Data Sources Available Per Era

| Period | trade | quote | funding | compositeIndex | OB |
|---|---|---|---|---|---|
| Nov 2014 – 2015 | ✅ | ✅ | ❌ | ❌ | synthetic only |
| 2016 – Feb 2026 | ✅ | ✅ | ✅ | ✅ | synthetic only |
| Mar 2026+ | ✅ | ✅ | ✅ | ✅ | ✅ real |

For the synthetic era, all constraints come from `trade`. Spread shape can be approximated from `quote` (best bid/ask). Funding can inform carry-related depth skew (if desired).

---

## Storage

Synthetic OB data should be stored separately from real OB data to avoid contamination:

```
orderBookL2          ← real WS data (Mar 2026+)
orderBookL2_synthetic_baseline  ← deterministic baseline from trades
orderBookL2_synthetic_v1        ← noise pass variant 1
orderBookL2_synthetic_v2        ← noise pass variant 2
```

Or use a `synthetic: true` flag plus a `variant` field if storage is a concern.

The format is identical to real `orderBookL2` so the same reconstruction engine and derived collections (`orderBook10`, `orderBookL2_25`) work without modification.

---

## Training Usage

When training a bot on pre-March-2026 data:
- Use real `orderBookL2` for post-March-2026 periods
- Use synthetic baseline for earlier periods where realism is less important
- Use noise-augmented variants for data augmentation (multiple passes = multiple training episodes from the same historical period)

The bot should never be told which data is synthetic — it should learn to trade on the features as presented. The compatibility guarantee ensures no training signal contradicts real market outcomes.

---

## Implementation Plan

1. **`services/synthesiser`** (new service) — reads `trade`, writes `orderBookL2_synthetic_baseline`
   - Single forward pass, streaming cursor over `trade`
   - Emits WS-format messages with `action: partial | insert | update | delete`
   - Idempotent via `$merge`

2. **Noise pass CLI tool** (not a running service — a one-shot script)
   - Takes a source collection and a variant name
   - Reads constraints from `trade`, loads source collection, applies stochastic mutations
   - Writes to `orderBookL2_synthetic_<variant>`

3. **Calibration** — deferred until sufficient real OB data exists (estimate: mid-2027)

---

## Open Questions

- Should synthetic inserts use real `_id` encoding (same sequence as real data) or a separate namespace? Separate is safer to avoid collisions.
- How many noise variants are useful before diminishing returns? Likely 3–5 per training run.
- Should the synthesiser respect known market microstructure (e.g. tick size, min order size)? Yes — these are hard constraints from the exchange spec.
- Is it worth synthesising OB for all symbols or just XBTUSD? Start with XBTUSD; extend if training broadens to alts.
