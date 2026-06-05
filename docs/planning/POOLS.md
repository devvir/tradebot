# BitMEX Protected Liquidity Pools — impact review & plan

BitMEX segments market-data into liquidity pools and exposes a `pool` field across
the market-data API. This doc captures what the change is, how to select a pool,
what is and isn't recoverable, what in the codebase is affected, and the plan. All
the "how it actually behaves" claims below are verified against the live API
(2026‑06‑05), not inferred from docs — BitMEX's swagger is incomplete here.

## TL;DR

- Liquidity is split into **Primary** (the standard public book), **Secondary** (a
  protected book where eligible market makers post passively), and **Aggregated**
  (Primary + Secondary blended into one book).
- **The pool view is selected explicitly per request/subscription — not by identity
  or authentication.** Default (no selector) is **Aggregated**, for guest *and*
  authenticated connections alike. Authentication is irrelevant to which pool you
  receive.
  - **REST:** `?pool=Primary|Secondary|Aggregated` query param (undocumented in
    swagger, which lists only `symbol` and `depth` — but it works).
  - **WS:** colon-suffix on the subscription arg — `orderBookL2:SYMBOL:Pool` for one
    symbol, or **`orderBookL2::Pool` (empty symbol) to pool-filter *all* symbols in a
    single subscription** (the form broadcast needs). The ack echoes the channel
    *without* the suffix (`subscribe: "orderBookL2"`) but reports the pool in `ack.pool`.
- **All three pools are readable by an unauthenticated connection — including
  Secondary.** Secondary is not hidden from data consumers; it is simply thin
  (often 0–2 levels on a given symbol). The access restriction in BitMEX's "Client
  Classification" table is about **order entry** (who may *post* to Secondary —
  DMMs, passive only), **not** market-data visibility.
- **Canonical collection = Primary, uniformly across every table**, selected via the
  pool selector. No authentication required.
- **Secondary is collectable directly** (`pool=Secondary` / `orderBookL2:SYM:Secondary`)
  for signals/analysis. Store it in a separate, non-training namespace. **No
  Aggregated − Primary diff is needed** — you read each pool straight from the API.
- **Aggregated is the default.** It collapses both pools into one row per price
  (tagged `Aggregated`); the exact merge logic (simple sum vs cross-resolving) is
  **unverified** and needs time-series data. Don't store it as canonical regardless.
- **Nothing in the accumulator (`@devvir/bitmex-database`) needs to change** — it is
  fully key-driven from the partial (verified).

## What a protected liquidity pool is (plain language)

Market makers post the resting bids/asks everyone trades against. They are
vulnerable to being "picked off" by fast/informed flow right before the price
moves, so they defend themselves with wider, smaller quotes — worse prices for
everyone. BitMEX created a **protected pool** where eligible makers post passively,
shielded from toxic flow, so they quote **tighter spreads and deeper size**.
Aggressive/ineligible flow trades in the public (Primary) book.

"Protected from" = protected from toxic/predatory order flow. The protection is on
*order matching* (who may rest/route orders where), not on who may *observe* the
book.

## The three pool views

- **Primary** — the standard public order book. What an ordinary account routes to
  and trades against.
- **Secondary** — the protected book (tighter, deeper). **Order-entry** access is
  restricted (DMMs, passive only — see Client Classification); **data** is readable
  by anyone via the pool selector.
- **Aggregated** — Primary + Secondary blended into a single book. The default
  view. One row per price tagged `Aggregated`; the merge logic is unverified (see
  "How the Aggregated book is built").

### Client Classification (order entry, not data)

| Classification | Order entry access |
|---|---|
| Directional (individuals, some institutions) | Primary + Aggregated |
| DMM | Primary + Secondary (passive only) |
| Institutional (most institutional traders) | Primary only |

Our account is Directional: it can only *route orders* to Primary/Aggregated, never
post into Secondary. This says nothing about reading Secondary data, which is open.

### Why "skip the protected order" is not a paradox

Price-time priority is a guarantee *within one book*, not across separate books. The
protected order is not in the book an ineligible order routes to, so there is no
better price being "skipped" — it is liquidity in a venue you can't route to. If a
level shows `1000 @ 100` in Aggregated but `600` is Primary and `400` is Secondary,
an ordinary market order fills the reachable `600` at `100` and walks the rest of
*its* book; the `400` is never touched.

## How to select a pool (verified 2026‑06‑05)

Same schema, pool chosen by explicit selector. Auth does not change the result.

**REST** `GET /orderBook/L2?symbol=XBTUSD&pool=<Pool>` (guest):

| selector | result |
|---|---|
| `pool=Primary` | 3504 rows, all `Primary` |
| `pool=Aggregated` | 3519 rows, all `Aggregated` |
| `pool=Secondary` | 2 rows, all `Secondary` |
| *(none)* | Aggregated (default) |

**WS** `{op:"subscribe", args:["orderBookL2:XBTUSD:<Pool>"]}` (guest):

| arg | ack.pool | partial |
|---|---|---|
| `orderBookL2:XBTUSD:Primary` | `Primary` | 3502 rows, all Primary |
| `orderBookL2:XBTUSD:Secondary` | `Secondary` | 1 row, Secondary |
| `orderBookL2:XBTUSD:Aggregated` | `Aggregated` | 3469 rows, all Aggregated |
| `orderBookL2:XBTUSD` *(no suffix)* | `Aggregated` | Aggregated (default) |

A bare `orderBookL2:SYMBOL` returns Aggregated whether or not the connection is
authenticated (verified: signed and guest both default to Aggregated).

### Filtering all symbols at once (the broadcast case)

A subscription with no symbol (`orderBookL2`) streams all symbols. To pool-filter it
**without** fanning out into one subscription per symbol, use the **empty-symbol
double-colon** form — `orderBookL2::Primary` — which applies the pool to every symbol
in a single subscription. Verified: `trade::Primary` → 1134 symbols, all Primary;
`orderBookL2::Secondary` → all Secondary. Every other plausible mechanism is silently
ignored except the last:

| attempt | result |
|---|---|
| URL `wss://…/realtime?pool=Primary` | ignored (returns union) |
| op field `{op:subscribe, args:["quote"], pool:"Primary"}` | ignored (returns union) |
| op field `{op:subscribe, args:["quote"], filter:{pool:"Primary"}}` | ignored (returns union) |
| arg `quote:Primary` | `400 Unknown symbol PRIMARY` (taken as a symbol) |
| **arg `quote::Primary`** | **works — all symbols, Primary only** |

The ack drops the suffix (reports `subscribe: "orderBookL2"`, pool in `ack.pool`).

### `trade` / `quote` selector semantics differ from the book

A `trade`/`quote` row's `pool` is only ever `Primary` or `Secondary` — an event
executes in one pool, there is no summed "Aggregated" event. So the selector means:

- `pool=Primary` / `pool=Secondary` → filter to that pool.
- `pool=Aggregated` **and no selector (the default)** → the unfiltered **union** of
  both pools, each row keeping its own tag. `Aggregated` is *not* Primary-only: e.g.
  quote `Aggregated` → `Primary:460, Secondary:40`. It only *looks* Primary-only
  when Secondary is empty in the window (common for `trade`, where Secondary prints
  are rare).
- invalid value → `400` `'pool' must be one of Primary/Secondary/Aggregated.`

Consistent principle across the API: `Aggregated` = combine both pools (book → one
merged row per price tagged `Aggregated`; trade/quote → union of the individually
tagged events); `Primary`/`Secondary` → filter. Behavior is identical for `trade` and
`quote`, guest and authenticated. In practice the default **trade** tape is ~100%
Primary (Secondary prints are minutes apart, so a 1000-row window is usually all
Primary) and **quote** ~95% Primary — so the default trade/quote data is effectively
the Primary tape, not a blend. Only the **book** has real `Aggregated`-tagged rows.

### REST vs WS paths for the book families

REST exposes only `/orderBook/L2?symbol=&depth=N` (`depth=10` → 20 rows,
`depth=25` → 50; pool selector via `&pool=`). There is **no REST path** for
`orderBook10` or `orderBookL2_25` (both `404`), and the legacy `/orderBook` is gone
(`404`). Those two are **WS-only** channels; over WS both exist and **honor the pool
selector** — `orderBook10:SYM:Primary`, `orderBookL2_25:SYM:Primary` — and both
carry a `pool` field. The swagger models only `OrderBookL2` (there is no
`OrderBook10` or `orderBookL2_25` definition at all), so their pool support was
established by live WS test, not the spec.

## Pool support per table

`pool` is declared on these swagger definitions: **Execution, Order, OrderBookL2,
Quote, Trade, TradeBin**. Behavior per table:

| Table | How pool appears | Notes |
|---|---|---|
| `orderBookL2` (+ `_25`, `orderBook10`) | one row per price; pool **selectable** | Aggregated merges both pools into one row per price (merge logic unverified). Pick the pool you want. |
| `trade` | **per-row tagged** `Primary`/`Secondary` | A trade prints in one pool. Guest stream carries both, filterable. ~0.5–1% Secondary. |
| `quote` | **per-row tagged** | Interleaved Primary/Secondary quote updates. ~5–7% Secondary. |
| `tradeBin` / `quoteBin` (1m/5m/1h/1d) | **pool-selectable** | Default is Aggregated, but `::Primary` returns a Primary-tagged bin (`ack.pool=Primary`). Whether the OHLCV is strictly Primary-computed vs relabeled is unverified — verify before trusting, else rebuild from raw `trade`/`quote`. |
| `order` / `execution` (private) | your order/fill's pool | For a Directional account, Primary/Aggregated only. |
| `liquidation`, `settlement`, `funding`, `insurance` | **no pool** | Not affected. |
| `instrument` | REST row `pool=Primary`; WS row `pool=null` | Fanned out like the other pooled tables; the WS `::Pool` filter **appears** to be a no-op (all three pools return the same items, `pool=null`) — to be confirmed by collected data, not assumed. |

## Data sources — what carries pool

- **Live WS / REST:** pool-selectable (book) or per-row pool-tagged (trade/quote).
  The only source from which per-pool data can be obtained.
- **BitMEX S3 daily dumps:** **no `pool` column at all** on `trade` or `quote`
  (verified headers), and the book/quote dumps are the Aggregated/BBO view. The S3
  `trade` dump is the full tape with both pools mixed and **unlabeled** — cannot be
  split. S3 is pool-blind by construction.
- **tardis.dev dumps:** `orderBookL2` comes through as `Aggregated` (they ride
  BitMEX's default). No per-pool data.

**Consequence:** pool-tagged history can only come from our own live capture going
forward. S3/tardis backfill is pool-agnostic and cannot be coerced into a single
pool view.

## How the Aggregated book is built — open question

We do **not** know how BitMEX merges the two pools into the Aggregated book, and we
must **not** assume it is a naive per-price sum. A naive sum of two independently-valid
books can be **crossed** — e.g. Secondary ask below Primary bid: each book is fine on
its own, but the union shows bids above asks (two spreads), which is not a tradeable
book. So either BitMEX resolves crosses into one coherent book, or Aggregated is a
display construct that can be incoherent and needs processing before use. Snapshots
can't distinguish these — Secondary is currently too thin and sits outside Primary's
touch, so nothing crosses today. Settling it requires collecting the Aggregated delta
stream over time and comparing against Primary (the deferred analysis). For collection
it is **moot**: an ordinary account trades Primary, so we store Primary and never
trade or train off Aggregated.

## The realism problem (why Primary is canonical)

For honest replay/training the stored market must be internally **coherent**: every
table a slice of the *same* book at the same instant. An ordinary (Directional)
account only ever interacts with **Primary**, so Primary is the canonical view.
Mixing pool views across tables — e.g. a Primary book against an Aggregated/mixed
trade tape — produces an incoherent market: the fill engine would match trades
against levels that never existed in that book (phantom fills), and depth/imbalance
features would read liquidity the bot could never hit. That is the
"binance + bitmex mixed together" failure mode. So: **pick Primary, and every table
conforms to it.**

## Already-collected Aggregated window (not recoverable)

The default-Aggregated book we collected (post‑30‑Apr, before applying the selector)
stores **one `Aggregated`-tagged row per price** with no per-pool breakdown (ids are
deterministic from price and `pool` is not in the dedup key `['symbol','id','side']`,
so the two pools can't coexist as separate rows at one price). Whatever the merge
logic, the Primary component was never stored separately, so Primary is
**unrecoverable** from it. That window is lost at the pool level; re-collect forward
with the selector, or exclude it from training. (Trades in that window are only
salvageable where the per-row `pool` tag was populated — S3 has no tag at all.) In
practice the gap is small — Secondary is ~1–2% of book depth and near‑0% of trades —
so the stored Aggregated is very close to Primary, which is why extracting it isn't
worth the effort.

## Codebase impact

### Not affected — verified

- **`@devvir/bitmex-database` accumulator.** Fully key-driven from each partial:
  `newState` reads `keys` off the partial; insert/update/delete index via
  `makeIndexKey(table, item, state.keys)`. `tableSchemas` is only for zod
  validation, never keying. Whatever BitMEX declares in `keys`, the accumulator
  obeys — no change regardless of pool.
- **`orderBookL2` key in `TABLE_SPECS`** (`['symbol','id','side']`,
  [shared/utils/src/tables.ts](../../shared/utils/src/tables.ts)) — still correct;
  BitMEX kept the key. The replay path rebuilds keys from this spec
  ([services/farmer/src/process/reconstruct.ts](../../services/farmer/src/process/reconstruct.ts)),
  so it must keep matching BitMEX — and it does.

### Affected — broadcast + farmer (the substantive change)

The collector ([services/broadcast](../../services/broadcast)) subscribes the bare,
all-symbol channels over WS → Aggregated. The plan splits the work across the pipeline
so vault stays untouched:

**broadcast** — driven by a new `BROADCAST_POOLS` env (csv of `default, primary,
secondary, aggregated`, case-insensitive):
- For each requested non-`default` pool, subscribe the **all-symbol empty-symbol
  form** per pool-affected table — `orderBookL2::Primary`, `trade::Primary`,
  `quote::Primary`. `default` keeps today's bare subscription; `primary,secondary`
  issues **two** subscriptions per table (individual per-pool messages, never
  Aggregated). `default` and `aggregated` store the same rows.
- broadcast fans out the pool **uniformly across the pooled set** (`POOLED_CHANNELS`:
  `instrument`, `orderBookL2`, `orderBookL2_25`, `orderBook10`, `trade`, `quote`,
  `tradeBin{1m,5m,1h,1d}`, `quoteBin{1m,5m,1h,1d}`) with **no per-table special-casing**.
  Whether the filter actually partitions a given table (apparent no-op on `instrument`;
  `::Aggregated` duplicates the union on `trade`/`quote`) is left to collected data to
  confirm before any prod-time pruning. This is the analysis-correct default.
- **No authentication** — the selector works on the guest connection.
- **Ack ambiguity (must handle):** the ack drops the suffix, reporting `subscribe:
  "orderBookL2"` with the pool only in `ack.pool`. Two pool subs on one connection
  both ack as `orderBookL2`, so the subscription-confirmation in `commands.ts` and the
  resubscribe set in `pool.ts` — which key on the channel string — must become
  pool-aware (match `ack.pool`, or track the full arg).

**vault** — no changes. Every orderBookL2 action carries `pool` on every row (verified:
`partial`/`insert`/`update`/`delete` all 100% tagged, both pools), so the intermixed
stream is losslessly splittable later.

**farmer (assembler)** — splits by pool during the vault→mongo import. The orderBookL2
key is `['symbol','id','side']` with **no `pool`**, and `id` is derived from price, so
a Secondary delta at price X shares the Primary level's `id` — feeding a mixed stream
to one accumulator corrupts the book. So farmer runs a **separate accumulator per
pool** and routes Primary → the canonical `orderBookL2` collection (unchanged for
consumers), Secondary → a separate store. Same-table-with-`pool`-field is a non-starter
for the reconstructed book for this reason.

### Affected — value/label assumptions that hardcode `Primary`

| Location | Issue |
|---|---|
| [services/distiller/src/distillers/quote.ts](../../services/distiller/src/distillers/quote.ts) (`const POOL = 'Primary'`) | Stamps every synthesized quote bin `Primary`; should carry the source pool through. |
| [services/farmer/src/process/reconstruct.ts](../../services/farmer/src/process/reconstruct.ts) (`pool ?? 'Primary'`) | Backfill default + docstring assume "always Primary"; stale. |
| [services/distiller/tests/distillers/quote.test.ts](../../services/distiller/tests/distillers/quote.test.ts) | Asserts `pool === 'Primary'`. |
| [services/farmer/tests/process/reconstruct.test.ts](../../services/farmer/tests/process/reconstruct.test.ts) | Fixture/assertion pins `Primary`. |
| [docs/services/DISTILLER.md](../services/DISTILLER.md) ("`pool` \| Always `Primary`") | Now false. |
| [docs/BitMEX/WS_TABLES.md](../BitMEX/WS_TABLES.md) (`pool: "Primary"` in the partial filter) | Default is Aggregated; pool is selected. |

`pool` is typed `'symbol'` across these tables in `TABLE_SPECS`, so it stores fine;
the issue is purely the assumed *value*.

## Timeline (effective dates)

- **2026‑01‑28** (testnet) / **2026‑02‑03** (prod) — `pool` field added (empty
  initially) to REST `order`/`execution`/`quote`(+bucketed)/`trade`(+bucketed) and
  the WS orderbook/quote/trade families. Additive.
- **2026‑04‑30 06:00 UTC** — default view for public subscriptions becomes
  **Aggregated**. (This is the change that altered our collected data.)
- **2026‑05‑13** (testnet) / **2026‑05‑19** (prod) — `pool` populated on WS
  subscribe acks.

## Recommended plan

1. **Collect Primary canonically** — drive broadcast via `BROADCAST_POOLS`; for
   `primary` it subscribes the all-symbol empty-symbol form (`orderBookL2::Primary`,
   `trade::Primary`, …) on every pool-affected table. Farmer splits by pool on import.
   No per-symbol fan-out, no authentication.
2. **Rebuild bins from raw Primary** — don't store BitMEX's Aggregated `tradeBin`/
   `quoteBin`; bin the Primary-filtered `trade`/`quote` yourself.
3. **Collect Secondary directly for signals** (optional) — `:Secondary`
   subscriptions into a separate, non-training namespace, walled off from the replay
   accumulator and teller. No diff required.
4. **Don't store Aggregated as canonical.** It's the default blend; not the
   tradeable book.
5. **The post‑30‑Apr Aggregated window is lossy** — re-collect forward with the
   selector, or exclude it from training. It cannot be reduced to Primary.
6. **Fix the hardcoded `Primary` spots and stale docs** (table above) to carry the
   source pool through rather than assert a constant. Low-risk cleanup.

## Open questions / notes

- WS authentication "took" was not independently confirmed (no private-channel
  test), but it's moot: auth does not select the pool, the selector does.
- Secondary **order-entry** eligibility (DMM rules) only matters if a bot ever
  trades as an eligible participant — not relevant to data collection.
- **How Aggregated merges the two books** (sum vs cross-resolving) is unknown — see
  "How the Aggregated book is built". A temporary journal collecting all three pools
  for a couple of days can settle it, and decide whether reverse-engineering the
  Aggregated-only weeks is feasible/worthwhile.
- **Are BitMEX's Primary bins truly Primary-computed?** `tradeBin`/`quoteBin`
  `::Primary` returns Primary-tagged bins (verified), but whether the OHLCV is computed
  from Primary prints only — vs a relabeled Aggregated bin — is unverified. Confirm
  before trusting them instead of rebuilding from raw Primary.
- **Are the S3 `trade`/`quote` dumps Primary or the union?** No `pool` column; test by
  checking whether a known Secondary `trdMatchID` appears in that day's S3 dump —
  present ⇒ union (Aggregated-equivalent), absent ⇒ Primary-only.
- **Canonical `orderBookL2` crosses a pool seam** at 2026‑04‑30: Aggregated before,
  Primary after. Rows self-describe via `pool`, but book depth steps across the seam —
  mark it or treat the pre-fix window as known-contaminated.

## Sources

- [API Update: Protected Liquidity Pool Rollout](https://www.bitmex.com/blog/api-update-protected-liquidity-pools)
- [API Update: Introducing the 'pool' Field](https://www.bitmex.com/blog/api-change-03-02-2026)
- [API Update: 'pool' field on WS subscription response](https://www.bitmex.com/blog/api-update-introducing-the-pool-field-to-ws-subscription-response)
- BitMEX WS API reference: https://www.bitmex.com/app/wsAPI
- Protected pools user guide (JS-rendered): https://www.bitmex.com/app/protectedLiquidityPools
