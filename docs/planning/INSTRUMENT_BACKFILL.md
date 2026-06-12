# Instrument distiller — pre-2019 backfill (toward 2016-12-01)

Design notes (in progress) for extending instrument distillation **earlier than the
first real instrument data**. Today the distiller's `start` is the first real
instrument partial (2019-04-01, our WS collection start). The proxy tables go back to
**2016-12-01** (first `compositeIndex` day), so in principle the instrument stream can
be synthesized for that whole earlier window. This doc records what's feasible, what
isn't, and the decisions made along the way.

Related: [DISTILLER_INSTRUMENT.md](../services/DISTILLER_INSTRUMENT.md) (the distiller design,
including reference re-emission), [INSTRUMENT.md](../BitMEX/INSTRUMENT.md) (the BitMEX feed).

## What we have

- **Proxy tables from 2016-12-01**: `trade`, `quote`, `funding`, `insurance`,
  `compositeIndex`, `tick`, `settlement`.
- **Real instrument (WS-origin) from 2019-04-01** — our collection start.
- **BitMEX REST `/instrument` serves active *and* expired instruments** (e.g. `XBTU17`)
  with full metadata. This is load-bearing (see below).

## The core constraint — proxies carry prices, not structure

Instrument fields split in two:

- **Price-derived (from proxies, converge forward):** `lastPrice` (trade),
  `bidPrice`/`askPrice`/`midPrice` (quote), `fundingRate` (funding),
  `settledPrice`/`state` (settlement), the index value → `markPrice` /
  `indicativeSettlePrice` (compositeIndex/tick).
- **Structural metadata (in NO proxy):** `referenceSymbol` (the perp→index mapping —
  the load-bearing one, with zero proxy footprint), `isInverse`, `multiplier`,
  `settlCurrency`, `tickSize`, `listing`/`expiry`/`front`/`settle`. These must come
  from instrument metadata.
  - **Exception:** `tickSize` is inferable from observed price granularity (a
    data-derived fallback if metadata is ever missing).

So 31 days — or any amount — of proxy warmup converges the *price* state but can never
snapshot structural fields that aren't in the inputs. `referenceSymbol` especially has
no proxy linkage (compositeIndex maps *constituent→index*, never *perp→index*), which
is exactly why REST instrument metadata is required.

## Two tiers

- **Reference (`.`-prefixed) symbols — free.** A reference symbol's value *is* the
  `compositeIndex` BMI value; synthesis needs only "is this a known index symbol,"
  which `compositeIndex` answers directly. Backfillable to 2016-12-01 with **no
  instrument-metadata dependency** — it's the existing `Conflator` path fed earlier
  proxy data.
- **Trading instruments — need the structural metadata**, sourced per symbol (next).

## Metadata sourcing — closest real data wins (verified)

REST coverage is **confirmed**: `GET /instrument?reverse=false` enumerates the full
history back to **2014-11-21** (`XBTF15`), states `Settled`/`Open`/`Delisted`, and on
settled rows the structural fields are essentially fully populated (`isInverse`,
`multiplier`, `tickSize`, `lotSize`, `settlCurrency` ~100%; `referenceSymbol` 445/451;
`settledPrice` 94%; `markMethod` 98%). So pre-2019 expired contracts are fully
sourceable.

The rule is **field-level**, not symbol-level — measured by comparing XBTUSD's 2019
partial against current (2026) REST:

- **Structural fields are stable over a symbol's life → either source:**
  `referenceSymbol`, `isInverse`, `multiplier`, `settlCurrency`, `markMethod`,
  `fairMethod` are identical 2019 vs 2026.
- **Evolving fields drift → use the *closest real data*:** `tickSize` (0.5→0.1),
  `lotSize` (1→100), `makerFee`/`takerFee`, `riskLimit` all changed 2019→2026. So:
  - **Surviving symbols** (in our collection): take these from the **oldest real
    partial that contains the symbol** (2019-04-01), not 2026 REST. `tickSize`
    especially matters — it feeds `midPrice` rounding.
  - **Settled-before-2019 futures**: take everything from the **frozen REST
    snapshot** — a `state=Settled` record can't change after settlement, so it is
    authoritative for that contract's date.
- **`listing`/`expiry` dates → REST** (present for every symbol incl. expired; needed
  to time the inserts and settlements).
- Use the `listing` date to know which symbols are relevant at a backfill date and
  where the oldest real data should be — rather than blindly walking full history.

## Architecture — a seed script feeds the **unchanged** distiller

The distiller is complex enough; do **not** add bootstrapping to it. Instead a separate
**seed script** manufactures synthetic `instrument` documents that look exactly like
farmer-imported originals (`reserved=0`), and the distiller consumes them with **no
changes at all**:

- A **seed `partial`** at the start date (e.g. 2017-01-01) — every symbol active then,
  `state=Open`, structural metadata filled (per the sourcing rule above), prices empty.
  This becomes "the first real instrument data," so the distiller cold-starts here and
  treats the whole 2017→2019 stretch as gaps it synthesizes from the proxies.
- **`insert` deltas** at each symbol's `listing` timestamp for symbols that list *after*
  the seed date. The distiller applies them like any real delta — the symbol becomes
  known and is synthesized from then on. **This is why the distiller needs no insert
  path: inserts are input, not something it emits.** (The alternative — pre-seeding
  every future symbol in the start partial — would prematurely list not-yet-listed
  symbols, so per-`listing` inserts are preferred.)

The distiller then does its normal job over the synthetic input: cold-start at the
seed, synthesize prices/index/funding from proxies, apply settlements from the
`settlement` proxy, seal each hour. The script owns all the metadata sourcing; the
distiller owns nothing new.

### Script steps

1. **Enumerate** the full instrument set (active + expired) from REST → static metadata
   + `listing`/`expiry`/settlement dates.
2. **Resolve per-symbol metadata** by the closest-real-data rule above (oldest real
   partial for survivors; frozen REST snapshot for pre-collection settled futures).
3. **Write the seed `partial`** (`reserved=0`) at the start date with the symbols
   `listing ≤` start, `state=Open`.
4. **Write `insert` deltas** (`reserved=0`) at the `listing` timestamp of every symbol
   that lists between the start and 2019-04-01.
5. Hand off — the distiller cold-starts at the seed and runs forward; the real partial
   at 2019-04-01 is the checkpoint that resets the accumulator to truth.

## Drift bounding

The real partial at 2019-04-01 is a **hard checkpoint** — anything synthesized in
2016–2019 is corrected there and cannot propagate past it. So backfill error is bounded
to the pre-2019 window and self-heals at the boundary. (Same property the hourly seals
give within the live range.)

## Open items / risks

- **REST coverage — VERIFIED.** `/instrument?reverse=false` reaches 2014-11 with
  settled-contract structural fields ~100% populated; field-level sourcing decided
  above. (Pagination via `start`/`count≤500` to enumerate everything is mechanical.)
- **`markMethod` — handled generally, not backfill-specific.** The Synthesizer branches on
  `markMethod` (see [DISTILLER_INSTRUMENT.md](../services/DISTILLER_INSTRUMENT.md) §7 and
  [INSTRUMENT.md](../BitMEX/INSTRUMENT.md) §6.4): `FairPrice` marks off the index, the
  `LastPrice` family off the symbol's own trades. This matters across **every era**, not just
  backfill — `FairPrice` is dominant from 2017 on, `LastPrice` a persistent minority across all
  years (even our 2019 real partial has `XBT7D_U105`/`XBT7D_D95`); the affected set is old
  2014–2016 futures + niche barrier products, while the major perps are all `FairPrice`. Backfill
  only makes the all-synth 2014–2016 window a bit more exposed, and the branch already covers it.
- **Verify the distiller cold-starts at the seed.** The cold-start picks "the first
  instrument data"; confirm a `reserved=0` seed partial at 2017-01-01 makes it cold-start
  there, and that the boundary (min of gating-table frontiers) lets it process
  2017→2019 (instrument absent below the frontier is treated as a synthesizable gap).
  No distiller change expected — but verify, don't assume.
- **Re-seeding on re-distill (operational).** The distiller deletes consumed originals
  (`reserved=0`) after sealing, so the synthetic seed/inserts are removed as they're
  processed. A clean re-distill of the backfill range therefore needs the seed script
  re-run first. The script must be idempotent / re-runnable.
- **Mid-life param changes** aren't captured — frozen-final for settled futures (fine,
  they don't change post-settlement), oldest-real-partial for perps (mild). Dynamic
  fields come from proxies regardless.
- **`fairBasis`** — dynamic; carried/synthesized; refinable from `funding` if precision
  is needed.
- **`openInterest` / `openValue`** — not proxy-derivable (see
  [[project_instrument_reference_drop]]); they freeze/stale in synth. Bounded; does not
  affect `markPrice`.
- **`state`/`settledPrice`** — driven by the distiller's settlement-timing (Open during
  the contract's life, Settled at its `settlement` event), not the REST final state. So
  the script seeds futures as `state=Open`; the distiller settles them when their
  `settlement` event arrives.

## Value

- **References + survivor perps (XBTUSD, ETHUSD) + long-lived indices** → backfill
  cleanly to 2016-12-01, drift-bounded by the 2019 checkpoint.
- **Expired-before-2019 futures** → now feasible via REST frozen snapshots (the
  population that was blocked when REST historical metadata was assumed unavailable).
- The whole 2016-12 → 2019-04 range becomes distillable.

## Status

Discussion / design only — no prototype. REST coverage and field-level sourcing are
verified. The **last unverified assumption** is whether the distiller's cold-start
(`boundary.ts` `firstCompleteDate` + `instrument.ts`) naturally picks up a synthetic
`reserved=0` seed at the start date and the boundary lets it run start→2019 as a
synthesized gap — a code-reading check before building the seed script.

---

## Practical reference (data access, code, docs) — handoff

**MongoDB.** `localhost:17017`, db `tradebot`, `authSource=admin`; credentials in the
**repo root `.env`** (`DB_USER` e.g. `readerdb`, `DB_PASS`). String:
`mongodb://$DB_USER:$DB_PASS@localhost:17017/tradebot?authSource=admin`. **Only the
`_id` index exists** (no symbol/timestamp indexes — intentional, ~200 GB saved) — always
bound queries by an `_id` range; never full-scan `instrument` (~1e9 docs).
- `_id` scheme (`shared/utils/src/mongoIds.ts`): `dateOffset·2^38 + slot·2^8 + reserved`;
  `reserved` via `_id % 4` → **0 = original/real (farmer), 1 = synthetic, 2 = processed-real**.
- Day bounds: `off = (Date.UTC(y, m, d) − Date.UTC(2000,0,1)) / 86400000`, then
  `lo = off·274877906944`, `hi = (off+1)·274877906944` (mongosh months are 0-indexed;
  e.g. 2019-04-01 → off 7030, 2016-12-01 → off 6179).
- Collections: `instrument` (WS-origin: partials + deltas); proxies `trade`, `quote`,
  `funding`, `insurance`, `compositeIndex` (collected **BMI-only**, `SCRIBE_INDEX_TICK_ONLY`),
  `tick`, `settlement`. `compositeIndex` currently reaches only ~2023-03 (REST backfill
  ongoing at the 180 msg/s limit); the others reach ~2026.

**BitMEX REST** (instrument needs no auth):
- `GET /api/v1/instrument?reverse=false&count=500&start=N&columns=...` — full history
  oldest-first (reaches **2014-11**), incl. `Settled`/`Delisted`; paginate via `start`.
- `GET /api/v1/instrument?symbol=X` — one symbol incl. expired.
- `GET /api/v1/instrument/compositeIndex?symbol=.X&reverse=true&count=N` — index
  constituents plus the `reference:'BMI'`, `weight:null` composite tick (= the index value).
- `GET /api/v1/instrument/indices` — current index values (premiums are live-only here;
  no historic endpoint — they're out of scope, §"Two tiers").

**Distiller code:** `services/distiller/src/distillers/instrument/` — `instrument.ts`
(entry/bootstrap/resume), `boundary.ts` (universe boundary + `firstCompleteDate`
cold-start — *the place to verify seed pickup*), `reader.ts` + `partitions.ts`,
`provider.ts` (gaps + rolling window), `synthesizer.ts` (pure), `merger.ts` (per-symbol
collapse), `walker.ts` (owns the `Conflator`, seals), `conflator.ts`, `accumulator.ts`,
`writer.ts`, `record.ts`, `rolling.ts`, `schema.ts`, `types.ts`.
Tests: `services/distiller/tests/distillers/instrument/`.
Build/test: `command pnpm --filter @tradebot/distiller build|test` (never raw `tsc -b`).
Live logs: `tb logs farm distiller`.

**Docs:** [DISTILLER_INSTRUMENT.md](../services/DISTILLER_INSTRUMENT.md) (the full distiller
design), [INSTRUMENT.md](../BitMEX/INSTRUMENT.md) (the BitMEX feed — fields, cadences,
referential measured facts), `docs/services/DISTILLER.md` (service-level). Memory:
`reference_instrument_referential_symbols`, `project_instrument_reference_drop`,
`project_distiller_reader_clustering_bug`, `project_instrument_boundary`.

**Raw WS instrument buckets** (to validate output / study the real stream):
`/storage/bitmex/ghosts/instrument/<year>/` — `.mtav`/`.local` collectors (same stream,
two collectors), gzipped CSV in flattened-WS form (first row has `_date_`+`_action_`,
continuation rows leave the first two columns blank; **ignore `.dedup*` variants**).
Vault: `/storage/bitmex/vault/<table>/<year>/`. Pull missing buckets from mega:
`mega-get -c /User/Tradebot/vault/<table>/<year>/<date>.csv.gz /storage/bitmex/ghosts/<table>/<year>/`
(trailing slash on the destination matters).

**Current DB state (this session):** `instrument` cleared and reimported all-`reserved=0`
(real) for 2019–2023; distiller Redis progress cleared; a clean-slate distill is running
(reference re-emission validated on 2019-04-02). First real instrument data = **2019-04-01**.
Pinned: 2019-04-01 showed `dropped: 13` out-of-order rows — investigate *what* later.
