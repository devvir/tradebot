# Trade / Quote Migration — retire courier, collect via scribe

Moving `trade` and `quote` collection off BitMEX's S3 daily buckets (courier) and
onto the REST pipeline (scribe). This doc captures why, where the boundary sits,
how pools are handled, the configuration refactor it forces, and the plan.

Pool behaviour below is taken from [POOLS.md](./POOLS.md) (verified against the live
API 2026‑06‑05), not re-probed here.

## TL;DR

- **Keep** courier's collected `trade`/`quote` data **up to 2026‑03‑31**. It stays in
  vault; courier is retired (no longer polled forward).
- **Scribe collects `trade` and `quote` from 2026‑04‑01 onward** via REST, like every
  other table.
- Full REST backfill of all history is infeasible (~180 req/min ⇒ months for the
  trade/quote volume), which is exactly why courier's bulk S3 history is retained.
- **Four tables**, pool encoded in the name: `trade`/`quote` (canonical, `pool=Primary`)
  and `trade.secondary`/`quote.secondary` (`pool=Secondary`). Separate vault files and
  mongo collections; Secondary kept for analytics. The 2026‑04‑01 boundary is chosen so
  the entire pooled era is owned by the pool-aware path (see below).
- Two design changes fall out of this:
  1. A **generic per-symbol subtask configuration** (now that both `compositeIndex`
     *and* `quote` need per-symbol subtasks, over **different** symbol sets).
  2. A **trade/tick partitioning** decision — accept fetching ticks twice for
     downstream simplicity (Option A), not a vault-side refactor (Option B).

## Why retire courier for forward data

The S3 buckets stopped being a trustworthy source for the current era for two
independent reasons:

1. **No pool dimension.** The buckets carry no `pool` column. Once a symbol's flow
   splits across Primary/Secondary books, an untagged row is *unrecoverably*
   ambiguous — pool cannot be derived after the fact. REST tags every `trade`/`quote`
   row with `pool`.
2. **Missing days.** BitMEX has begun skipping daily buckets (the June 10 hole that
   started this work). REST does not have this gap.

REST is the authoritative, pool-aware source. The only thing S3 still does better is
**cheap bulk history**, so we keep what courier already collected and switch the
forward edge to scribe.

## The boundary: 2026‑04‑01

From [POOLS.md](./POOLS.md) timeline:

- `pool` field added to REST `trade`/`quote` **2026‑02‑03** (prod), empty initially.
- Default public view became **Aggregated** (union of both pools, each row tagged)
  **2026‑04‑30 06:00 UTC**.
- First observed **Secondary** prints: trade `2026‑04‑16`, quote/XBTUSD `2026‑04‑23`.

So everything courier collected **through 2026‑03‑31 is unambiguously Primary** — it
predates the first Secondary prints and the default-view change. Drawing the line at
**2026‑04‑01** means:

- Historical (courier, ≤ Mar 31): pure Primary, no pool ambiguity, header matches.
- Forward (scribe, ≥ Apr 1): the entire pooled era is collected by the pool-aware
  path, with `pool=Primary` selecting the canonical tape cleanly.

## Pool handling

Per [POOLS.md](./POOLS.md): for `trade`/`quote`, `pool=Primary` filters to the Primary
tape, `pool=Secondary` to the Secondary tape; the default (no selector) returns the
**union of both, each row tagged**. Canonical = Primary; Secondary is thin but useful
(DMM/whale passive flow).

**Decision — split each into a canonical and a Secondary table.**

| Table              | Selector         | Role                                  |
|--------------------|------------------|---------------------------------------|
| `trade`            | `pool=Primary`   | canonical real-trade tape             |
| `quote`            | `pool=Primary`   | canonical quote tape                  |
| `trade.secondary`  | `pool=Secondary` | Secondary trades (analytics)          |
| `quote.secondary`  | `pool=Secondary` | Secondary quotes (analytics)          |

- Pool is encoded in the **table name**, so **no `pool` column** is needed anywhere —
  all four tables keep the identical S3 column layout, and the canonical tables stay
  **byte-identical to the historical S3 buckets** so reads span the Apr‑1 boundary
  seamlessly.
- Separate vault files (`/files/<table>/<date>`) and separate mongo collections, so the
  canonical training tables stay lean while Secondary remains available for analysis —
  consistent with POOLS.md ("store Secondary in a separate, non-training namespace").
- Secondary only exists from mid‑April 2026 (first prints Apr 16/23), so the Secondary
  tables are simply empty for early days — scribe already handles empty days.

Storing the *union with a `pool` column* was the rejected alternative: it would break
header parity with the historical files and force a non-canonical pool into the
training tables. The split keeps everything **and** keeps canonical clean.

> Note: table names contain a `.` (`trade.secondary`). Confirm nothing downstream
> parses table names by splitting on `.` (vault paths, farm collection mapping). The
> `.` here is a table-name separator, unrelated to the `.`-prefix on referential
> *symbols*.

## Generic per-symbol subtask configuration

### Problem

Today, per-symbol subtasking is hardcoded for exactly one table. In
[runner.ts](../../services/scribe/src/runner.ts) `getTasks`:

```ts
if (table.name !== 'compositeIndex') return [{ id: 'default', filter: { count, ... } }];
// else: one task per index symbol
```

`quote` also needs per-symbol subtasks — but over a **different symbol set** than
`compositeIndex`. The name-based special-case doesn't scale to two such tables.

### Symbol sets

- **`compositeIndex` → indices** (`.`-prefixed instruments;
  [symbols.ts](../../services/scribe/src/utils/symbols.ts) `fetchSymbols`).
- **`quote` → trading (non-`.`) symbols.** Referential `.`-index symbols are
  **excluded** — they have no order book, so no quotes.

  *Evidence (probed 2026‑06‑14):* 8 referential symbols — 6 obscure (one per `typ`
  category) + the flagship `.BXBT`/`.BETH` — all returned `HTTP 200 []` on
  `GET /quote?symbol=<sym>&count=1&reverse=true`. With `reverse=true` and **no
  `startTime`**, an empty result scans all of history, so this is conclusive that
  those symbols have had **zero** quotes since 2014, not merely a sparse window. The
  control `GET /trade?symbol=.BXBT&count=1&reverse=true` returned a fresh row
  (`2026‑06‑14T12:07`, `trdType:"Referential"`), proving `.BXBT` is live — so its
  empty quote is real, not inactivity. Reinforced conceptually: BitMEX signals index
  price moves via *referential trades* (the `tick` table), so duplicating that as
  quotes would be redundant.

  > Coverage-test method, for reuse: prove "ever had data" with `reverse=true` and
  > **no `startTime`** (a `startTime` filter yields false negatives). Probe sparingly
  > and spaced out — hammering all symbols risks rate-limit errors / a ban.

  Quote requires an explicit `symbol` (observed in-browser), so it is genuinely a
  per-symbol table.

### Shape (implemented)

The name check is replaced by an optional **function** on the table config — a symbol
resolver. Present ⇒ the runner fans the table into one subtask per returned symbol;
absent ⇒ a single default task. The resolver is the *only* per-table special thing; the
runner/fetch/rows code carries no table names. Static behaviours (pool, reference,
size-drop, clock) stay as plain data. Types in
[types.ts](../../services/scribe/src/types.ts):

```ts
type SymbolResolver = (cache: RedisClient, baseUrl: string) => Promise<string[]>;
type RowFilter      = (row: Row) => boolean;

interface TableConfig {
  name; path; maxStart; count;
  symbols?: SymbolResolver;            // present → per-symbol subtasks; absent → single task
  keep?:    RowFilter;                 // post-fetch row predicate (drop referential trades)
  from?:    string;                    // yyyymmdd hard floor on the first date, combined with global startDate
  filter?:  Record<string, unknown>;   // server-side filter — also carries `pool`
  tsField?: string;
}
```

- **no `symbols`** → one default task, no symbol (funding, insurance, settlement, tick,
  **trade**).
- **`symbols: getOrderedIndices`** → one task per `.`-symbol (compositeIndex).
- **`symbols: getTradingSymbols`** → one task per non-`.` symbol, all states (quote —
  incl. inactive/expired contracts, which still carry order-book history).

`getTasks` is now generic: `table.symbols ? fan-out : single default`. Resolvers live in
[settings.ts](../../services/scribe/src/utils/settings.ts) (renamed from `tables.ts`).
Both `getOrderedIndices` and `getTradingSymbols` order symbols by a stable, append-only
registration ID in a Redis hash (`scribe:indices` / `scribe:symbols`) via the shared
`orderByRegistry`. This keeps a day's output reproducible — a re-fetch is byte-identical
even if symbols listed in between — which is what makes regression diffs reliable.

**Why a function here and static data elsewhere:** the symbol list is *computed at
runtime* (fetched + ordered), so a function fits; `pool`/`reference`/`size` are fixed
values, so they ride the static `filter` (verified: `filter={"pool":"Primary"}` filters
identically to the `?pool=` selector). `keep` is a function only because `size != 0`
can't be expressed as a server-side equality filter.

### Capacity (the binding constraint)

`quote` volume is large: **27.3M docs for a single day** (2026‑06‑13, observed in
mongo). At BitMEX's ~180 req/min and an assumed `count=1000`/req (max count to be
confirmed), that's ~27.3k requests ≈ **~2.5h of API time per day-of-data** (Primary;
Secondary adds ~5%).

Implications:
- **Going forward** (daily): ~2.5h/day ≪ 24h — keeps up comfortably.
- **Backfilling the gap** Apr 1 → now (~2.5 months ≈ 74 days): ~74 × 2.5h ≈ **~8 days
  of continuous collection** before the forward edge is reached. One-time, acceptable —
  and the whole reason full history (years) stays on courier's S3 bulk.

Max `count` is **1000** for both (empirically confirmed), which the arithmetic above
assumes.

## Trade / tick partitioning

`tick` is the referential trade tape: `/trade` filtered to `size=0` (the `.`-symbol
index prints). `trade` is the real tape: `size>0`. BitMEX offers no `size!=0` filter.

**Decision — Option A (accept double-fetch of ticks).**

- `trade`: fetch `/trade` (`filter: { pool: 'Primary' }`), **`keep: row => row.size !== 0`**
  post-fetch → real trades only.
- `tick`: fetch `/trade` `filter: { size: 0 }` → referential only (unchanged).
- Cost: the `size=0` rows are fetched once inside the trade stream and discarded, and
  fetched again for `tick`. Wasteful, but downstream stays simple: two clean,
  pre-separated tables.

*Alternative — Option B (deferred):* store the full unfiltered `/trade` tape in vault
once and let farm's assembler split `size=0` vs `size>0` when building the DB. Less
fetch waste, but more refactoring across vault + farm. Not now.

The `keep` row-predicate on `TableConfig` is the mechanism (a function, since `size != 0`
isn't a server-side equality filter), applied per row in `fetchAndWriteDay`. It's kept on
`trade.secondary` too — a no-op there (Secondary has no referential prints) but cheap
insurance against that assumption.

## Vault headers

Scribe writes via the `/rows` path, which encodes against `TABLE_HEADERS`
([vault headers.ts](../../services/vault/src/data/headers.ts)); courier's raw-PUT
files already embed the S3 header. For reads to span the boundary, the registered
headers must equal the S3 columns exactly. Observed from the on-disk buckets:

- `trade`: `timestamp,symbol,side,size,price,tickDirection,trdMatchID,grossValue,homeNotional,foreignNotional,trdType`
- `quote`: `timestamp,symbol,bidSize,bidPrice,askPrice,askSize`

Add both to `TABLE_HEADERS` verbatim — **no `pool` column** (canonical = Primary; see
Pool handling). This keeps scribe-written files header-identical to courier's historical
files.

## Scribe table configs (implemented, [settings.ts](../../services/scribe/src/utils/settings.ts))

`maxStart`/`count` empirically confirmed: `count: 1000` for both; `maxStart` 100000 for
trade, 2500000 for quote.

```ts
{ name: 'trade',           path: '/trade', maxStart: 100000,  count: 1000, from: '20260401', filter: { pool: 'Primary'   }, keep: realTrades }
{ name: 'trade.secondary', path: '/trade', maxStart: 100000,  count: 1000, from: '20260401', filter: { pool: 'Secondary' }, keep: realTrades }
{ name: 'quote',           path: '/quote', maxStart: 2500000, count: 1000, from: '20260401', filter: { pool: 'Primary'   }, symbols: getTradingSymbols }
{ name: 'quote.secondary', path: '/quote', maxStart: 2500000, count: 1000, from: '20260401', filter: { pool: 'Secondary' }, symbols: getTradingSymbols }
```

## Plan / status

**Code — done** (scribe + vault build & tests green):

1. ✅ Generic subtask refactor: `symbols` resolver + `getTasks` carries no table names;
   `compositeIndex` migrated; `tables.ts` → `settings.ts`.
2. ✅ `keep` row-predicate applied in `fetchAndWriteDay`; `from` floor in `taskStartDate`.
3. ✅ The four tables added with the confirmed configs above.
4. ✅ Vault headers for all four (S3 columns, no pool column).

**Farm — verified, no changes needed:** farmer auto-discovers vault tables (`FARMER_TABLES`
unset ⇒ all), routes by `WS_TABLES` (a `Set<string>` excluding trade/quote/`.secondary`)
to the REST path, and already farms `trade`/`quote` today — the `.secondary` variants are
the same shape. Mongo handles dotted collection names fully (verified: insert/find/
aggregate/index on a `trade.secondary` collection); only the mongosh shorthand
`db.trade.secondary` misparses — use `db.getCollection('trade.secondary')`. `BitmexTable`
deliberately lists only real BitMEX tables (like `tick`, these pseudo-tables aren't in it).

**Operational — remaining** (the code alone does not finish the migration):

5. **Retire courier + purge its ≥ 2026‑04‑01 trade/quote vault files.** Scribe skips
   dates already closed in vault, so without purging courier's April-onward (no-pool, S3)
   files, scribe won't replace them with pool-aware data. Stop courier, purge ≥ Apr 1,
   keep ≤ Mar 31.
6. **Capacity:** ~8 days of continuous collection to backfill Apr 1 → now (Primary +
   thin Secondary); steady-state daily keeps up easily.

## Open questions

- None blocking. (Farm verified; mongo dotted-collection names verified.)

## Sources

- [POOLS.md](./POOLS.md) — pool selector semantics & timeline (verified 2026‑06‑05).
- On-disk S3 buckets under the vault data dir — `trade`/`quote` header columns.
- [scribe runner.ts](../../services/scribe/src/runner.ts),
  [symbols.ts](../../services/scribe/src/utils/symbols.ts),
  [tables.ts](../../services/scribe/src/utils/tables.ts) — current subtask machinery.
