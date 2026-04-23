# Synthetic Market Data

## Problem

Real orderbook data collection started **8 March 2026**. Tardis offers raw orderbook snapshots from **1 April 2019** onwards (first day of each month). Before that, and between Tardis sample dates, we have no orderbook data. We do have:

| Dataset | From |
|---|---|
| `trade` | November 2014 |
| `quote` | November 2014 |
| `funding` | ~2016 |
| `compositeIndex` | ~2016 |
| `orderBookL2` (Tardis) | April 2019 (monthly samples) |
| `orderBookL2` (live) | March 8, 2026 |

Training bots on real OB data is bottlenecked by date — we will always have far more trade/quote history than OB history. The goal is to generate useful, rich, realistic orderbook data covering the full history, using what we have.

---

## Guiding Principles

**Separate hard facts from educated guesses.** Each pass produces a dataset with a clearly defined epistemic status. Pass 1 contains only things we know for certain. Later passes add progressively more realistic detail, but always labeled as approximation. A bot trained on Pass 1 output alone is already valid for strategies that do not rely on OB distribution.

**Real data is a density question, not a structural one.** Tardis samples and live collection are both spans where we have real data — the gaps between them are just shorter after March 2026 (minutes) than before (most of each month). The synthesis problem and its solution are the same in both cases. The passes apply uniformly across the full timeline.

**Output format is a downstream concern.** Passes produce and consume an internal event log. Conversion to snapshot+delta or any other consumption format is a materialization step applied at the end, not a constraint on synthesis.

---

## Compatibility Constraint

A synthetic orderbook is **compatible** with the trade history if:

> At the exact timestamp of every real trade (price P, size Q, side S), the book contains at least size Q at price P on the correct side.

This is the only hard constraint. Everything else is approximation.

---

## Data Sources

| Period | trade | quote | funding | compositeIndex | OB |
|---|---|---|---|---|---|
| Nov 2014 – Mar 2019 | ✅ | ✅ | ❌ | ❌ | synthetic only |
| Apr 2019 – Mar 2026 | ✅ | ✅ | ✅ | ✅ | Tardis samples + synthetic gaps |
| Mar 2026+ | ✅ | ✅ | ✅ | ✅ | live + synthetic gap-fill |

---

## Pass 1 — Trade-Constrained Skeleton

**Input:** `trade` collection (November 2014 onwards).
**Output:** The minimal orderbook consistent with every real trade. Nothing else.

### Algorithm

1. Scan trades in chronological order.
2. Maintain `bids: Map<price, size>` and `asks: Map<price, size>`.
3. For each trade `(timestamp, side, price, size)`:
   - **Buy** (taker bought, maker sold): `asks[price]` must hold at least `size` at this moment.
     - If the level is not yet in the book: insert it now, at this exact timestamp, with exactly `size`.
     - Subtract `size`. If the level reaches zero, remove it.
   - Mirror for **Sell** on the bid side.

No backdating. No phantom levels. No assumptions beyond what the trade record proves.

### Properties

- Every event is grounded in a real trade.
- A level appears at the earliest timestamp where it is proven to have existed.
- Usable immediately for bots that do not rely on OB depth or distribution.

---

## Pass 2 — Realistic Augmentation

**Input:** Pass 1 skeleton + microstructure statistics extracted from Tardis samples and live data.
**Output:** A richer book with phantom levels, realistic lifetimes, cancellations, and depth shape.

This pass is explicitly approximate. Everything it adds is an educated guess calibrated to observed market behavior — it is not fact.

### Microstructure statistics (extracted from real OB data)

- Phantom level density (levels per price tick per unit time)
- Order size distribution
- Order lifetime distribution (insert → cancel intervals)
- Cancellation rate (ratio of cancels to fills)
- Spread distribution and depth profile shape
- Price clustering of resting orders around mid-price

### Augmentation operations

**Phantom levels:** Insert resting orders that never trade, drawn from Tardis-observed distributions (price relative to mid, size, lifetime). These model the visible depth that surrounds real activity.

**Size history on traded levels:** For a level that trades at time T with size Q, add plausible size updates in the interval before T. Final value at T must be exactly Q. Model: Brownian motion clamped to [1, Q×3], ending at Q.

**Temporary disappearance:** Levels may be deleted and re-inserted before their trade time, modeling limit order cancellations and replacements. Must be present at trade time with correct size.

**Spread enforcement:** Enforce minimum spread consistent with Tardis-observed spread statistics.

### Invariant

After every augmentation operation, verify no compatibility constraint is violated: for every real trade `(timestamp, side, price, size)`, the book still holds at least `size` at `price` on the correct side at that moment.

---

## Pass 3+ — Optional Further Refinement

Additional passes can apply more sophisticated statistical models: regime-aware parameters (trending vs ranging, volatility), intraday patterns, cross-symbol relationships. Each pass must preserve the compatibility invariant and must be clearly labeled as a further layer of approximation.

Calibration parameters can be re-fit as more live data accumulates post-March 2026.

---

## Storage

A single collection with metadata is preferred over multiple collections:

- `source: 'live' | 'tardis' | 'synthetic'`
- `pass: 1 | 2 | 3 | null` (null for real data)
- `variant: null | number` (for stochastic augmentation variants)

Materialization to snapshot+delta or other consumption formats is a separate step applied on top of stored data.

---

## Open Questions

- What intermediate event log format is most efficient for passes to consume and produce?
- For Pass 2 phantom levels, should price distribution be calibrated per-symbol or per-regime?
- How many stochastic variants per period are useful before diminishing returns for training? Likely 3–5.
- Should synthesis respect known microstructure constraints (tick size, min order size)? Yes — extract from BitMEX API specs.
- Start with XBTUSD; extend to other symbols as training broadens.
