# BitMEX Protected Liquidity Pools — behaviour, consequences & plan

BitMEX splits market data into liquidity pools and exposes a `pool` field across the
market-data API. This doc states what the pools are, how to select one, **what the
`Aggregated` stream actually is at the byte level**, what can and cannot be recovered
from it, and the collection plan.

The pool-selection mechanics are corroborated by live capture (we hold real
per-pool `quote.secondary`/`trade.secondary` slices, which only exist because the
selector works). The **level/id model and the no-merge result are proven from raw
`orderBookL2` data** — XBTUSD, 2026‑05‑14, the post-flip Aggregated stream — and the
method is recorded below so it can be re-derived, not taken on faith.

## TL;DR

- Liquidity is split into **Primary** (the standard public book a normal trader sees
  and executes against), **Secondary** (a protected book; **order-entry restricted**
  to eligible passive makers, but its **data is readable** by anyone), and
  **Aggregated** (both pools combined into one stream).
- **Pool is chosen by an explicit selector, never by auth.** Default (no selector) is
  **Aggregated**.
- **BitMEX does NOT merge price levels.** In the Aggregated stream the two pools'
  levels at the same `(symbol, side, price)` are **two separate rows with two
  different `id`s and their own sizes** — never one summed row. The source is
  lossless; only the **pool label is fused** (every row is stamped `Aggregated`).
- **You still cannot recover the pools from the Aggregated stream.** The `id` is an
  opaque, ephemeral per-level handle that carries no pool (or side) information and is
  never reused, so there is **no lookup** that maps an Aggregated `id` back to a pool.
  The information that would separate them (the per-pool tag) was discarded at the
  source.
- **Therefore Aggregated is the worst tier to collect:** it can't be decomposed, it
  doesn't match the Primary `quote`/`trade` we already collect (tier mismatch), and it
  isn't even an executable book (it shows Secondary depth a normal account can't hit).
- **Canonical collection = Primary, uniformly across every table.** Capture
  `orderBookL2` with `pool=Primary` (it is currently riding the Aggregated default),
  and optionally capture Secondary as a separate, labelled stream. Never store
  Aggregated as canonical.

## The three pools

- **Primary** — the standard public order book. What an ordinary (Directional)
  account routes to and trades against. This is the canonical view.
- **Secondary** — a protected book where eligible market makers post passively.
  **Order entry** is restricted (DMMs, passive only); **market data is open** to any
  connection via the pool selector. On XBTUSD it rests characteristically **huge,
  stable, round sizes** (~1,019,000 contracts per level on 2026‑05‑14) — institutional
  resting liquidity, not retail flow.
- **Aggregated** — both pools streamed together. The default. **Not** a merged book:
  it is the union of the two pools' levels, every row relabelled `Aggregated`.

### Access (order entry vs data)

| Classification | Order-entry access |
|---|---|
| Directional (individuals, most institutions) | Primary + Aggregated |
| DMM | Primary + Secondary (passive only) |
| Institutional | Primary only |

Our account is Directional — it can only route orders to **Primary**. This is why
Primary, not Aggregated, is the realistic book: an ordinary market order can only
consume Primary liquidity. A 1M-size Aggregated bid that is mostly Secondary would
**not** fill a normal seller; they'd take the small Primary part and walk to the next
level. Order-entry access says nothing about *reading* Secondary, which is open.

## How to select a pool

Same schema everywhere; the pool is chosen by an explicit selector. Auth is
irrelevant.

- **REST:** `?pool=Primary|Secondary|Aggregated` query param (works despite being
  absent from swagger).
- **WS:** colon-suffix on the subscription arg — `orderBookL2:SYMBOL:Pool` for one
  symbol, or the **empty-symbol double-colon** form `orderBookL2::Pool` to apply the
  pool to **all** symbols in a single subscription (the broadcast case). The ack drops
  the suffix (`subscribe: "orderBookL2"`) and reports the pool in `ack.pool` — so two
  pool subscriptions on one connection both ack as the bare channel and must be
  disambiguated by `ack.pool`.

For `trade`/`quote` the selector filters per-pool, and the default/`Aggregated` is the
**union** of the individually-tagged events (each row keeps its own `Primary`/
`Secondary` tag — there is no summed "Aggregated" trade or quote). For the **book**,
`Aggregated` is the combined level stream described below.

## The level / id model (proven, XBTUSD 2026‑05‑14)

A **level** is the ephemeral life of non-zero size at a `(symbol, price, side, pool)`
tuple — from `insert`, through any `update`s/`partial`s, to `delete`. Crossing zero,
or the price crossing to the opposite side, **ends the level** (a `delete`); a later
occupancy at the same price is a **new level**.

- **`id` is the key of a live level for its lifetime**, and BitMEX keys the table by
  `(symbol, id, side)`. Every `update`/`delete` references that exact `id`.
- **`id` is opaque and not derivable from price.** The legacy price-encoding scheme
  was deprecated (May 2023); `price` now rides on every row precisely because it can
  no longer be computed from `id`. Empirically one price (Sell 79604.2) carried **132
  distinct ids** over the day — one per occupancy.
- **`id` is not reused.** A genuine new occupancy always gets a fresh id. (Apparent
  "reuse" in the 2026‑05‑14 slice is ghost-subscription **duplication**: a re-delivered
  `insert` with an **identical `(id, transactTime)`** but a later collector
  `timestamp`. Dedup on `(id, transactTime)`.)
- **`id` encodes neither side nor pool.** Of 5,775,337 distinct XBTUSD ids in the day,
  **zero** appeared on both sides — a level never changes side (it would cross zero
  first). And the two pools' ids are interleaved (paired-collision deltas ±15…±2687,
  mixed sign); ids are not even one global counter (across 122 symbols they span
  ~2.3e9–2.1e11, i.e. per-symbol ranges). Nothing in the id distinguishes a pool.

## What "Aggregated" actually is — NO merge (proven)

BitMEX does **not** collapse the two pools into one summed row. Both pools' levels
coexist as **separate rows with distinct ids**.

Proof method (re-derivable): scan the Aggregated stream for two items in **one WS
message** (one action, one timestamp) at the same `(side, price)` with **different
ids** and both live (`size` present). A single message carries one action, so this
cannot be a delete/insert swap — it is two coexisting levels. Eight such cases were
found on XBTUSD/2026‑05‑14; in every one the two ids carried **separate sizes** (e.g.
Sell 79604.2 → `id …955439` size **400** and `id …954594` size **1019400**), and the
large size matched the contemporaneous **`quote.secondary`** exactly (secondary ask
79604.2 size 1019400). The most coexisting live ids at any one `(price, side)` was
**2** — the pool count — never 3.

So: the Aggregated stream is **lossless at the source** (two ids, two sizes, summable
or separable in principle) but the **pool label is fused** — every row reads
`Aggregated`, with nothing to say which id is Primary and which is Secondary.

### Replaying the Aggregated book

Maintain state keyed by `(symbol, id, side)`; apply `insert`/`update`/`delete` by
`id`. The deltas are **id-addressed, not price-addressed**, so two pools at one price
are never ambiguous — each delta lands on its own id. To render a price ladder, **sum
the live ids per `(symbol, side, price)`** (within a side). This reproduces the true
combined depth and is unambiguous; no preprocessing is required to replay the
*combined* book.

What you **cannot** do is read each pool's trajectory out of it: the ladder shows the
sum, not the Primary-vs-Secondary split, and (per the id model) there is no way to
attribute the split. And the combined book is **not an executable book** — a normal
account can't take the Secondary portion — so its depth overstates fillable size.

## Pools cannot be recovered from the Aggregated stream

There is **no mechanism** to label an Aggregated `id` with its pool:

- The id is **ephemeral and never reused**, so a lookup table built from any past
  per-pool capture only ever holds retired ids; every new Aggregated delta carries a
  fresh id you have never seen.
- The id carries **no pool structure** (interleaved, per-symbol ranges, mixed-sign
  neighbour deltas).
- The only signal that ever attributes a pool is matching a level's **size** to the
  per-pool `quote`/`quote.secondary` — and that reaches **top-of-book only**, never
  depth. Useful to *verify* (as above), useless to *reconstruct*.

**Consequence:** any window collected Aggregated-only is permanently fused — Primary
and Secondary cannot be separated from it by any post-processing. Per-pool data can
only come from capturing the per-pool subscriptions directly.

## Tier consistency (the three streams must describe one reality)

For coherent replay, the book, `quote`, and `trade` must be at the **same pool tier**
at every instant — otherwise the fill engine matches trades against levels that never
existed in that book (phantom fills) and depth features read liquidity the bot can't
hit.

Today this is **violated**: `orderBookL2` rides the Aggregated default while base
`quote`/`trade` are **Primary** (their `.secondary` counterparts are captured
separately). Evidence: at price-coincidence instants base `quote` showed primary-scale
sizes while Secondary sat separately at ~1.0M — base quote is Primary-only, not a sum.

Resolve it **downward, not upward**: capture `orderBookL2` at `pool=Primary` so it
matches the already-Primary `quote`/`trade`. (Merging `quote`/`trade` *up* to an
aggregate is both wrong-tier — non-executable — and impossible to do exactly, since
quotes are top-of-book only and can't reconstruct aggregated depth.)

## Per-table pool behaviour

| Table | How pool appears | Notes |
|---|---|---|
| `orderBookL2` (+ `_25`, `orderBook10`) | level stream; pool **selectable** | `Aggregated` = union of both pools' levels (separate ids, **not** merged). Pick `Primary`. |
| `trade` | per-row tagged `Primary`/`Secondary` | A fill prints in one pool. Default/`Aggregated` = union of tagged rows. Secondary prints rare. |
| `quote` | per-row tagged | Interleaved Primary/Secondary top-of-book. Secondary rests ~1.0M sizes. |
| `tradeBin`/`quoteBin` | pool-selectable | Whether `::Primary` OHLCV is strictly Primary-computed vs relabelled is **unverified** — rebuild from raw Primary `trade`/`quote` rather than trust. |
| `order`/`execution` (private) | your order/fill's pool | Directional account → Primary/Aggregated only. |
| `instrument` | REST `pool=Primary`, WS `pool=null` | The pool selector is **accepted but silently ignored** (all pools return the same items); instrument is not pool-partitioned. Out of scope. |
| `liquidation`/`settlement`/`funding`/`insurance` | no pool | Unaffected. |

## Data sources — what carries pool

- **Live WS / REST:** the **only** source of per-pool data — book selectable per
  subscription, `trade`/`quote` per-row tagged. Must capture per-pool going forward.
- **BitMEX S3 daily dumps:** no `pool` column; both pools mixed and **unlabelled** —
  pool-blind, cannot be split.
- **tardis.dev:** `orderBookL2` rides BitMEX's Aggregated default — no per-pool data.

## The already-collected Aggregated window (lost at the pool level)

The `orderBookL2` we collected on the default subscription is Aggregated: fused labels,
wrong tier vs our Primary `quote`/`trade`, and on ghost-sub dates additionally
contaminated by duplicate inserts. None of that is recoverable to Primary by
post-processing. Treat it as a **hole**: re-collect forward at `pool=Primary`, and
either exclude the window from training or replay it only as an explicitly-labelled,
non-executable aggregate. (On dup dates, dedup on `(id, transactTime)` first.)

## Collection plan

1. **Capture `orderBookL2` at `pool=Primary`** (all-symbol `orderBookL2::Primary`),
   matching the Primary `quote`/`trade` already collected. Stop storing the Aggregated
   default as canonical.
2. **Capture Secondary separately** (optional, `::Secondary`) into a labelled,
   non-training namespace for signals — never mixed into the Primary book.
3. **Rebuild bins from raw Primary** `trade`/`quote` rather than trusting BitMEX's
   pooled `tradeBin`/`quoteBin`.
4. **Handle the ack ambiguity:** two pool subscriptions ack as the bare channel;
   key subscription tracking on `ack.pool`, not the channel string.
5. **Mark the pool seam** in canonical `orderBookL2` (Aggregated before the per-table
   flip, Primary after) and the ghost-sub dup dates as known-contaminated.

## Timeline (effective dates)

- **2026‑02‑03** (prod) — `pool` field added (initially empty) to the pooled REST/WS
  tables. Additive.
- **2026‑04‑30 06:00 UTC** — announced default flip to Aggregated for public
  subscriptions. The **per-table effective flip differs**: XBTUSD `orderBookL2` was
  still Primary on 2026‑05‑01 and fully Aggregated by 2026‑05‑14 (exact per-table flip
  ≈ 2026‑05‑06; pin it from `data.pool` of the first/last doc per day if needed).
- **2026‑05‑19** (prod) — `pool` populated on WS subscribe acks.

## Open / to confirm

- **Exact per-table Aggregated-flip date** for `orderBookL2` (≈05‑06) — low priority.
- **Are BitMEX's `::Primary` bins Primary-computed** or relabelled Aggregated? Rebuild
  from raw until confirmed.
- **Non-overlap of the 5,776 ghost-sub duplicate inserts** (delete strictly between
  the two inserts) was inferred from same-spot, seconds-apart recreation, not proven.

## Sources

- [API Update: Protected Liquidity Pool Rollout](https://www.bitmex.com/blog/api-update-protected-liquidity-pools)
- [API Update: Introducing the 'pool' Field](https://www.bitmex.com/blog/api-change-03-02-2026)
- [API Update: 'pool' field on WS subscription response](https://www.bitmex.com/blog/api-update-introducing-the-pool-field-to-ws-subscription-response)
- BitMEX WS API reference: https://www.bitmex.com/app/wsAPI
- Raw evidence: XBTUSD `orderBookL2`/`quote`/`quote.secondary`, 2026‑05‑14 (and 05‑01
  pre-flip control) under `/storage/bitmex/Tmp.Pools/`.
