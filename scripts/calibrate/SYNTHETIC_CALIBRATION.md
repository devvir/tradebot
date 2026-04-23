# Synthetic Orderbook Calibration

This document covers the statistical modelling work needed to go from the stage1 hard-fact skeleton to a realistic orderbook (stage2+). It captures the design thinking, open questions, and the planned approach. It is intentionally exploratory — the data will answer most of the open questions.

---

## What stage1 gives us and what is missing

Stage1 output (`orderBookStage1`) contains one document per real trade:

```
{ timestamp, symbol, side, price, size }
```

This is the minimal provable truth: at `timestamp`, size `size` existed on `side` at `price`. Nothing else is known.

What reality has that stage1 does not:

- **Order appearance timing.** The resting order existed *before* the trade hit it. Stage1 inserts it at trade time. In reality it may have been sitting there for seconds, minutes, or hours.
- **Pre-trade size history.** The level may have had more than `size` before the trade — it could have been partially filled earlier or amended. Stage1 records only what the trade consumed.
- **Phantom levels.** At any moment the book has many resting orders that will never trade — they will be cancelled. Stage1 has none of these.
- **Depth shape.** A real book has a characteristic density profile: dense near the quote, thinning out at greater distances.

Stage2 adds all of this. The challenge is doing it in a way grounded in real observed behaviour rather than arbitrary assumptions.

---

## The core statistical problem

The behaviours above (when an order appears, how long it lives, what size it is, how many phantom orders exist at each distance) are not fixed constants. They are distributions that depend on context. The question is: which contextual variables matter, and how?

Identified conditioning dimensions, roughly in order of expected importance:

### 1. Distance from quote

The single most important dimension. Behaviour near the top of book vs mid-book vs extremes is qualitatively different:

- Near-quote orders: short-lived, frequently cancelled, typically smaller. Subject to intense HFT activity.
- Mid-book orders: mixed population, moderate lifetimes.
- Far-from-quote orders: some are long-lived "resting" orders placed algorithmically as anchors. Others are placed during volatile moments as "just in case" hedges and may rot there for days. This likely produces a bimodal lifetime distribution at extreme distances — one population cancels quickly, another stays indefinitely.

Model as a continuous variable (% distance from mid-price), not discrete buckets. Bucket only for initial exploration.

### 2. Volatility regime

Order behaviour changes with market conditions. During calm periods, patterns are stable and predictable. During elevated volatility (FOMO, capitulation, macro events), near-quote orders turn over faster, depth thins, spreads widen.

Do not try to label regimes semantically ("FOMO", "crisis"). Use observable proxies:
- Rolling realised volatility at multiple windows (1h, 4h, 1d)
- Spread at the moment of observation
- Price momentum (rolling return over some window)

These are directly computable from `quote` and `trade` data. Three or four vol percentile buckets (calm / normal / elevated / extreme) are likely sufficient for a first model. The exact boundaries should emerge from the data.

### 3. Temporal patterns

May include intraday cycles (trading session open/close), day-of-week effects, month-end effects. These are real in equity markets and plausible in crypto. Add only after validating the base model — they require enough data samples to detect reliably and may turn out to be small relative to regime effects.

### 4. Symbol

Start with XBTUSD only. Do not generalise across symbols prematurely. The hypothesis is that symbols group into clusters (e.g. XBTUSD is its own thing, ETH/LTC USD markets may be similar, smaller markets another group), but the data should determine this. Possible approaches once multi-symbol work begins:

- Independent models per symbol — straightforward but expensive in data.
- A single model with a small per-symbol adjustment parameter (e.g., a liquidity scalar that adapts distance-from-quote distributions). Parsimonious if it fits.
- Clustering symbols by model similarity after fitting independently.

Do not decide this before seeing data.

---

## What we need to measure

By tracking each order ID through its lifecycle in the `orderBookL2` stream, we can directly observe:

| Measurement | How to obtain |
|---|---|
| Order lifetime | `delete_timestamp - insert_timestamp` per order ID |
| Lifetime classification | Cross-reference deletes with simultaneous trades at same price/size to classify as fill vs cancellation |
| Inserted size | Size field on insert/partial action |
| Size history | Sequence of update actions between insert and delete |
| Depth profile | At each timestamp snapshot: count of active levels per price-distance bucket |
| Arrival rate | Count of new inserts per unit time per price bucket |
| Cancellation rate | Fraction of orders that end in cancellation vs fill |

**Mid-price at each moment** is required as the anchor for distance calculations. Compute from the `quote` stream (bid/ask → mid = (bid+ask)/2), which lives in the `quote/` subfolder alongside `orderBookL2/` — same directory structure, separate per-day files.

---

## Source data

All source data lives on the filesystem as gzipped CSV files under `/data/bitmex/vault/`. MongoDB is not involved in calibration.

```
/data/bitmex/vault/<stream>/<year>/YYYYMMDD.csv.gz
```

Streams relevant to calibration: `orderBookL2`, `quote`, `trade`.

Available days of real orderbook data:
- **Historical monthly samples**: ~84 days (first day of each month, April 2019 – February 2026)
- **Live collection**: ~45 days (March 8, 2026 onward, growing daily)
- **Total**: ~130 days of real orderbook data

All data is in the same vault format regardless of origin. Some files may be in cold storage and downloaded as needed.

---

## Statistical frameworks

### Order lifetime → survival analysis

Survival analysis is the natural framework. The "event" is cancellation or fill; orders still alive at end-of-day are right-censored (not dead — survival analysis handles this). The Kaplan-Meier estimator gives non-parametric survival curves stratified by conditioning variables. A Cox proportional hazards model reveals which variables matter most and how much.

Key consideration: lifetime distributions at extreme distances may be bimodal. If so, a mixture of two survival distributions (with a mixing weight) is more appropriate than a single-distribution fit.

Library: `lifelines` (Python).

### Order size → parametric fit

Order size distributions in financial markets are typically power-law in the tail and approximately log-normal in the body. Fit both and compare. Possibly needs a mixture model if there are visually distinct populations (e.g. small algorithmic orders vs large block orders).

Library: `scipy.stats`.

### Depth profile → conditional empirical means

At each snapshot, record levels-per-price-tick at each distance from mid. Compute mean and spread (std or percentile range) conditional on vol regime. This is a simpler estimation problem — aggregated counts are well-behaved and don't require complex modelling.

### Arrival rate → Poisson process

Count new inserts per unit time per price bucket. Model as a Poisson process with rate λ(distance, regime). Fit λ empirically as a conditional mean.

---

## Toolchain

Python, reading directly from gzipped source files. No MongoDB step.

- **Polars** (not Pandas) — 10–50× faster on large datasets, lower memory pressure, native Parquet/gzip support. Can read gzipped CSVs directly.
- **lifelines** — survival analysis.
- **scipy** — distribution fitting.
- **matplotlib / seaborn** — visualisation. Prefer charts over tables throughout; the goal is to develop visual intuition for the patterns before formalising them into parameters.
- **pyarrow / Parquet** — intermediate storage after converting from gzipped source files. Process each source file once, write Parquet, work from Parquet for all subsequent analysis.

---

## Visualisation-first approach

Numbers alone are not sufficient for building intuition about these distributions. Every analytical step should produce charts. Examples of what is useful:

- Survival curves by distance bucket (overlaid, one per vol regime)
- Size distribution histograms with fitted curves overlaid, log-scale x-axis
- Depth profile heatmap: distance from mid (y) × time of day (x), colour = mean number of levels
- Scatter: order lifetime vs distance from mid at insert, colour = vol regime
- Cancellation rate vs distance from mid, with error bars
- Mid-price time series with realised vol overlay (to visually identify regime transitions)
- Comparison charts: synthetic vs real depth profiles, synthetic vs real lifetime curves (for validation)

---

## Validation approach

Since we have one day of data per month for the historical period, we can hold out some days and validate:

1. Train calibration models on a subset of days (e.g., odd months).
2. Generate synthetic data for held-out days (e.g., even months) using the calibrated parameters.
3. Compare statistical properties of synthetic vs real held-out days:
   - Depth profile shape
   - Lifetime distribution
   - Spread distribution
   - Order flow imbalance

This gives a concrete quality signal. If the synthetic and real distributions are visually similar, the calibration is working. If not, the comparison charts will show where the model is wrong.

---

## Data scope and pragmatism

- Start with XBTUSD only.
- Start with a handful of days (3–5) as a development set before processing all available data.
- It may be acceptable to ignore pre-2023 data if market microstructure has changed enough that older patterns are misleading rather than informative. Do not decide this upfront — look at whether models fit consistently across time before discarding data.
- The goal is not a universal model that fits every symbol and every era. It is a model that is good enough to produce synthetic data that a bot cannot trivially distinguish from real data, for the symbols and periods that matter for training. Imperfect is fine; obviously wrong is not.

---

## Concrete first step

Build a single Python script (Polars-based) that:

1. Reads one gzipped CSV from the vault for XBTUSD (one day of `orderBookL2`).
2. Converts to Parquet (one-time, reused for all subsequent analysis on that file).
3. Reads the corresponding `quote` gzipped CSV for the same day and converts it as well. Joins on timestamp to get mid-price at each moment.
4. Tracks each order ID from insert to delete, classifying the outcome (fill vs cancel by cross-referencing trades at same price/size/time).
5. Outputs a lifecycle table:

```
order_id | insert_time | delete_time | lifetime_s | insert_size | distance_from_mid_pct | outcome | vol_at_insert
```

6. Produces the first round of visualisations: survival curves by distance bucket, size histogram (log scale), depth profile heatmap over the day.

This script, extended to iterate over all ~130 available days and all symbols, is the foundation for all calibration work.

---

## Open questions

- Are order lifetimes stable enough across months to pool, or do they shift significantly over time? The held-out validation will answer this.
- Is the bimodal lifetime hypothesis at extreme distances visible in the data, or is it a single distribution with a very heavy tail?
- What is the right distance metric — absolute price difference, percentage from mid, or number of ticks? Percentage is scale-invariant across price levels; ticks are instrument-specific. Start with percentage.
- How many days are needed before calibration parameters stabilise? Unknown — monitor parameter variance as more days are added.
- Does vol regime need to be defined at the order level (vol at insert time) or at a coarser granularity (daily vol bucket)? Likely order-level for lifetime models, daily for depth profiles.
