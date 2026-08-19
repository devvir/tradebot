# The bitget seed

`seeds/bitget/{pattern,series,transform}.csv`, read once by `seed.ts` when a catalog is created. It
is migration data: once it has been applied, the catalog's own passes own those rows and the files
never change again.

The venue's naming rules are in [BITGET.md](BITGET.md).


## What this seed is for

**It puts bitget where a walk would have left it.** That is the whole of it.

The service has one mechanism, not two. A catalog starts from a search space - the patterns a venue
publishes under, a series for every instrument that has ever occupied one, and the floor each shape
starts at - and every pass after that generates keys from it, probes them, and records what answers.

For a venue whose archive can be listed, a walk produces that search space as a by-product of
reading the index once: it sees real paths, a reader recognises each one's shape, and `walkSeries`
writes the patterns and series it meets. That is a convenience, not a second design. Throw away
everything a walk learned except the patterns, the series and the floors, hand those over as a seed,
and the first update rediscovers every file by generation and arrives at the same catalog.

**Bitget has no index to read.** Its bucket answers `AccessDenied` to a key that does not exist -
S3 declining to say whether it exists - so no path is ever *found* there and nothing can infer a
shape from one. The same three facts therefore have to be established by research: sweep the venue's
download form, read the patterns out of the URLs it returns, and write them down. The seed is that
research, in the shape a walk would have produced.

After it is applied, bitget is indistinguishable from a walked venue. Updates find new instruments
through the v2 and v3 listings and give them series under the shapes their market already has.

**Instruments that no longer trade are in the seed because nothing else would ever create them** -
no listing names them, and their files are in the archive all the same.

**Neither kind ever discovers a pattern on an update.** An update generates keys from patterns it
already holds; only a walk creates one, and only from a path it was handed. So a venue that changes
its naming is a re-walk for a listed venue and another research cycle here. Bitget has done it twice,
on 2024-04-19 and 2026-08-18, and nothing built from the old shapes would have shown it - a
generated key under a retired shape answers 403, which at this venue is indistinguishable from
"no file today".


## This seed is an instrument, not a record

**It is built to be replaced by what it measures.** Nothing has fetched a key of this archive from
inside the service, so the bounds here are the download index's word and a deliberate margin under
it. The pass that runs against this seed is what turns that into measurement:

| | what this seed says | what the pass establishes |
|---|---|---|
| `floor` | one **common** floor per dataset, grain and era - never per series | irrelevant afterwards - `first` is the series' own measured start |
| `first` | not a column. A seed may not state one | written by the first file that answers, and lowered by any earlier one |
| `last` | the newest date the index offered for that series | the newest file actually seen |

A floor set that low is the point rather than a looseness to be tidied: a run that finds files near
a floor has proved the floor wrong, which is the one way a floor can be wrong in the expensive
direction. **Too high loses files in silence, because a tip only ever moves forward.**

**One floor per dataset and grain — never per series, and never per era.** A per-series floor derived
from what the index offered inherits the index's blind spots: where it under-reported a series'
start, the floor lands above the real one and nothing ever asks below it. An era floor does the same
thing to a whole naming at once. A floor shared by the dataset cannot, because nothing about an
instrument or a shape narrows it.

| | daily | monthly |
|---|---|---|
| klines, trades | `20180501` | `201801` |
| quotes | `20240501` | `202401` |
| books | `20250501` | `202501` |

Each sits below the earliest file its dataset is known to hold — klines and trades open 2018-07-25,
quotes 2024-07-09, books 2025-08-01 — and deliberately so, because those dates are the index's word
for where each tree begins and that is exactly the claim the run exists to test. A floor at the
observed start can only ever confirm it.

So this seed asks about each dataset's whole calendar rather than each instrument's own life, and the
next one will not. Extracted again after a completed pass, `floor` becomes each series' measured
start and `last` its measured end, and the venue's calendar stops being asked about at all.

**The temporary code in the adapter belongs to this stage.** `ruleOnSuccess` drops **every** queued
key of a series the moment one answers. Generation emits a series ascending, so the first key that
answers is its first file — and this pass wants nothing else. It measures, per series, where the
archive starts and which series answer nothing at all; the ends are a later pass's job, from floors
these firsts will have proved.

It cut at the seeded `last` in an earlier form, so that one probe confirmed the end as well. That is
worth having only while `last` is believed, and `last` is the download index's word on a venue whose
index under-reports — so this pass declines to use it.

**The seeded horizon is withheld for the same reason.** `SEEDED_AT` has bitget's entry commented out,
so `updatePage` builds no skip window. With it, the run jumps from each series' `last` to a fortnight
before the seed's own date, on the seed's authority — which is the index's authority — and so cannot
contradict the thing it exists to check. It comes back when the floors are measurements rather than
declarations.
The multi-part trades chain is commented out beside it for the same reason — what this pass wants is
where each series begins and ends, and asking for a hundred parts of every day buys nothing towards
that. Both come back when the floors are real.

**Prospector is being used as the instrument, not described by it.** Generating keys inside declared
ranges, probing them, pacing the venue and resuming where it stopped is exactly the crawl this
research needs, and a standalone script would be re-implementing all of it. Nothing in the service
knows this seed is a draft — see [seeds/README.md](../../services/prospector/src/database/migrations/seeds/README.md)
for what separates a research seed from a permanent one.


## What this seed asserts

**Every instrument the venue lists, on every shape its market publishes.** The cross product, not the
subset the download index happened to mention: four datasets at two grains, times each naming era the
shape has had, for every name in the dropdown crawl. A combination the index was silent about is
declared like any other, because whether it holds files is the question the run is being run to
answer — see [seeds/README.md](../../services/prospector/src/database/migrations/seeds/README.md) on
what separates a research seed from a permanent one.

What the index did say is kept beside each row in `archivesFirst` and `archivesLast`, which `seed.ts`
ignores. After the run they are what the floors get judged against: a series whose files begin below
its `archivesFirst` is proof the index under-reported that tree.

**Three markets, and everything else is refused.** Bitget lists a large family of tokenised equities,
ETFs, metals and currency pairs beside its crypto — `rTSLA/USDT` on the spot line, `AAPLUSDT` as a
perpetual on the futures one — and none of them is catalogued. They carry this venue's naming
pathology at its worst and nothing downstream wants them, so `bitgetInstruments` refuses them at
discovery and no series exists for one. The rule and the measurement behind it are in
[BITGET.md](BITGET.md#what-this-catalog-refuses-bitgets-non-crypto-listings).

The same pass removed the `unknown` market, which held depth streams that surfaced only when the
index was asked with a name from the other line and whose provenance nothing established.

Every market maps to exactly one of the archive's two lines, which is why the adapter needs no
`categoryOf`: there is no market whose shapes span both.

### The names

An instrument has several names at bitget and none of them is authoritative over the others. Three
matter here.

**`displaySymbol`** is the search term the archives download form accepts, and the only string
`getPublicDataV2` answers for. Spot spells it with a slash (`BTC/USDT`), futures without
(`BTCUSDT`), and it often differs from the name the v2 and v3 APIs use. It is what the sweep asks
with, and nothing more than that.

**`url_symbol`** is the string the files themselves are spelled with. It is not derivable from
`displaySymbol` in general - `$REKT/USDT` and `REKT/USDT` are two instruments - and it is what the
catalog substitutes into a pattern's `{SYMBOL}`.

**`symbol`** is the canonical name: the one the API uses, or a deterministic transform of it, so an
instrument can be recognised across the archives, v2, v3 and the search endpoint. It is what
`preamble` compares a listing against, so a canonical that disagrees with the venue's own name is
the one failure that is silent and total - it creates a duplicate series and retires the real one.

Either of the three, and the pattern, may change during one instrument's life. Each change is a
second series, since `series_key` is `(pattern_id, COALESCE(url_symbol, symbol))` and one row cannot
generate both halves.

Two columns are research rather than table: `displaySymbol` records what to search for to get that
series' files, and `listed` marks the hidden streams the venue does not offer. `archivesMarket` on
a pattern records the side `halfOf` derives anyway. `seed.ts` ignores columns it does not read, and
it is deliberate that it does - a seed may carry whatever its own research found worth keeping.

### What a pattern cannot spell, and `transform.csv` can

A pattern substitutes one symbol into every slot it has. Where a key needs two different strings, or
a string that changes on a date, the shape says `{TRANSFORM:kind:default}` and the transform table
answers it per instrument, per dataset, over a span of dates. Absent a row the default stands and
generation cannot tell the two paths apart.

| kind | default | what it answers |
|---|---|---|
| `marginToken` | `UMCBL` | which margin line a futures **trades** key is filed under: `CMCBL` for USDC-margined, `DMCBL` for coin-margined. Nothing in the path or the symbol reveals it |
| `archiveDir` | `{SYMBOL}` | the directory, where it is not the name the filename uses |

`archiveDir` is the answer to bitget filing one instrument's day inside another's directory. It has
two populations: one row bounded to a single day - `kline/TRXUSDT/RUNEUSDT_UMCBL_1min_20221117.zip`,
the only copy of that day and the only such key in five million paths - and the depth directories
that stopped agreeing with their filenames from 2026-09-03, which are open-ended because nothing
has yet ended them.

### How the archive spells an instrument

Each group is a rule; `other` is the residue no rule explains, and shrinking it is the point - every
instrument that leaves it is one fewer the seed must be told about individually.

| market | dataset | group |
|---|---|---|
| any | any | `url_symbol` = `clean(displaySymbol)` - the rule |
| any | any | ticker re-used - one side qualified |
| any | klines, quotes, books | renamed mid-life - two series |
| futures | any | USDC margin spelled `PERP` |
| futures | klines, quotes, books | coin-margined: `USD_CM` spelled `USDCM` or `CM` |
| any | quotes, books | key shared with another instrument |
| futures | quotes, books | multiplier prefix dropped |
| futures | klines | dated contract, expiry recoded |

- **`clean(displaySymbol)`** drops the slash and upper-cases. Dropping the slash is the only removal
  that always holds: no url_symbol carries one and none is lower-case, but `$` and `_` survive into
  some (`$ALTUSDT`, `BTCCM_D2`), so stripping punctuation generally would be wrong.
- **ticker re-used** - the venue re-issues a ticker and qualifies one of the two by prefix, infix or
  suffix, with an open vocabulary: `AIN/USDT` -> `AINBSCUSDT`, `AINOLD/USDT` -> `AINUSDT`,
  `ALT/USDT` -> `$ALTUSDT`, `APPUSDT` -> `APPSTOCKUSDT`.
- **renamed mid-life** - two series: `IPPERP` -> `DATAPERP`, `TONUSDT` -> `GRAMUSDT`.
- **coin-margined** - `AAVEUSD_CM` files as `AAVEUSDCM` under one dataset and `AAVECM` under another,
  which is why `url_symbol` is a field of the series and not of the instrument.
- **key shared** - one archive name, a succession of holders. One series covers the whole span,
  since one key cannot be two series.
- **multiplier prefix dropped** - `1000CATUSDT` files under `CATUSDT`.
- **dated contract** - the form's `MMYY` becomes the futures month letter: `BTCUSD0327` -> `BTCUSDH26`.

The rules a *live* instrument needs are in `symbols.ts` and are asked of the venue rather than
listed here: `pathSymbolOf` derives what derives, and `archiveNamesOf` asks the trading-platform
search for the rest, per instrument, at the moment the catalog first meets it.

### What the archive does, that the seed is shaped around

**The eras cut on 2024-04-19 and 2026-08-18, but not for every dataset.** Trades and depth change
cleanly. Klines do not: a few hundred era-2 candlestick keys carry dates from 2019 to 2023 — targeted
backfills written under the newer naming — so those instruments have overlapping series rather than
adjacent ones.

**Depth is two datasets.** `deptType: 1` is the quote stream under `depth/`; `2` is a 500-level book
under `depth_500/`. Books begin 2025-08-01, on the naming convention the other datasets only adopted
at the 2026-08-18 boundary.

**Each daily dataset has a monthly rendering**, under `kline_month/`, `trades_month/`, `depth_month/`
and `depth_500_month/`, all beginning in 2025. They are separate patterns of a separate grain, not a
second spelling of the daily ones, and the catalog holds both because which to use is the consumer's
call.

**A futures instrument's depth is served on both business lines** - `depth/BTCUSD/1/…` and
`depth/BTCUSD/2/…` both exist.

**The index goes quiet about recent days long before the archive does.** A sweep that returns nothing
above a date is reporting on the index, not on the bucket: days the index withheld for over a week
were published all along and appeared later, at full strength and under the shapes already in this
seed. So the newest date a sweep returns is a lower bound on what exists and never a frontier, which
is why no `last` is seeded and why `SEEDED_AT` is withheld - see `seed.ts`.


## Rebuilding it

The seed is data, not a pipeline, and none of this runs in the service. It is written down so a
future seed - a newer one, or one for another venue shaped like this - does not start from nothing.
The scripts live in `@claude.tmp/bitget-index/`, one folder per stage, each with its own README.

**1 - The universe.** `getSymbolList`, the endpoint behind the form's dropdown, matches a substring
anywhere in a display symbol and caps its reply at 200 with no pagination. So it is crawled: ask a
substring, and a reply of 200 means it is hiding an unknown number more and must be refined, while
anything less is complete for that substring. A query given up on is a subtree never explored and
looks exactly like a complete crawl, so being turned away may never be mistaken for an answer.

**2 - The sweep.** `getPublicDataV2` takes a *list* of display names and a date range, so it is one
request per (line, type, 8-day window) rather than per instrument. Asked for every name of both
lines, 2018 to today, all three business types and both `deptType`s. Only `code: "200"` is an
answer; 403, 429, 5xx and a challenge page all mean ask again, and a window that never answers is
recorded as failed rather than as empty.

Send both markets' names to both lines. A name from the wrong market was assumed to match nothing;
it does not - futures names answer real depth files on the spot line - and asking wider is the only
way that surfaces.

**3 - The reading.** Each reply names the `displaySymbol` it answers for, so attribution is mostly
free; where a bulk reply is ambiguous, asking about one symbol alone is categorical. The symbol's
position in a path is not fixed - second segment in `kline/BTCUSDT/…`, third in
`trades/SPBL/BTCUSDT/…`, and neither in `depth/BTCUSD/1/20240821.zip` - so the shape is found by
support instead: every token of a path is tried as the symbol, and the reading kept is whichever
produces a template the most other instruments also produce. A pattern is by definition a shape a
market shares; a token unique to one instrument templates nothing.

**4 - The seed.** Every instrument against every shape its market can carry, split wherever the
pattern or the spelling changed - not the combinations the index happened to return, which are a
subset of what exists and would inherit the index's blind spots for good, since nothing walks this
venue and a key absent from the seed is never probed.

**The index is evidence, not truth.** It omits files that are served and lists files that are not.
Nothing in it is a measurement until something has fetched the key.


<!-- ─────────────────────────────────────────────────────────────────────────
     TRANSIENT — everything below this line describes the run that is building
     the permanent seed, and is deleted once that seed ships. Nothing above it
     depends on any of it.
     ───────────────────────────────────────────────────────────────────────── -->

# Building the permanent seed — transient

The experimental seed is in the catalog and a full pass is generating and probing against it. What
follows is what that run has to be checked against before its results become the permanent seed, and
the facts a check needs in order to be written.

**Delete this whole section when the permanent seed ships.**

## Where the evidence is

Stated so a check can be written without re-deriving any of it. All of it is on disk today.

| | |
|---|---|
| the research folder | `/data/tradebot/@claude.tmp/bitget-index/` — its `README.md` describes each stage, `REBUILD.md` is the scratch |
| **the universe** | `symbol-list/instruments.csv` — a `market,symbol` list from an exhaustive substring crawl of `getSymbolList`, tradfi and the Reality tokens already struck out. Nothing downstream may ask about a name absent from it, and a name is asked only of the line that offers it |
| **the URL sweep** | `sweeps/records.<tag>.jsonl`, asked with exactly those names — see the grid below |
| the per-series reduction | `series/series-from-sweep.csv` — one row per (shape, spelling), carrying the sweep's `first`, `last` and its file count |
| the shipped seed | `seeds/bitget/{pattern,series,transform}.csv`, written by `series/full-seed.cjs` from the universe and the row above |
| the seed's own audit | `checks/audit.cjs` — rules over the shipped CSVs and the venue's listings |
| the coverage check | `checks/coverage.cjs` — every swept URL against every key the seed can generate |
| the catalog under test | `/storage/tradebot/catalog/catalog.db` |

### The sweep is one grid, in six files

**The file names are nicknames and two of them are actively misleading.** What the sweep actually
covers is the download index's own request parameters:

| parameter | values |
|---|---|
| `businessLine` | 1 spot, 2 futures — the archive's two halves, and all it has |
| `businessType` | 1 klines, 2 trades, 3 depth |
| `dateType` | absent daily, 2 monthly |
| `deptType` | absent or 1 the quote stream under `depth/`, 2 the 500-level book under `depth_500/` |

That is 2 × 4 × 2 = **16 cells**, and the record files cover all of them between them. Each is named
for the cells it swept — `daily-main` is all three business types at the default `deptType`,
`daily-books` is depth at `deptType 2`, and the `monthly-` pair are the same two with `dateType 2`.

**The non-ASCII names need their own pass.** `哈基米USDT` and `龙虾USDT` exist in the REST listing, but
a substring crawl over `a-z0-9$/_` cannot construct a query that reaches them, so they are swept from
names found the other way.

**A sweep record joins the catalog exactly.** `record.fileUrl` is
`https://img.bitgetimg.com/online/` + the path, and bitget's `venue.base` is that string with an
empty `root`, so `file.path` is the URL with the base and one slash removed. No parsing, no
normalisation.

**The older sweeps are a different universe, and they are still evidence.**
`records.v2.jsonl`, `records.slashless.jsonl`, `records.books.jsonl`, `records.newnames.jsonl` and
`records.newbooks.jsonl` were asked with names from the research `instrument` table rather than from
`getSymbolList`, so the seed does not rest on them. But **a URL is a URL**: the venue said it holds
that file, so the catalog is expected to hold it too, and one that is missing has to be explained
rather than excused — either the venue's listing is wrong, or the seed was short. They are the second
reference set for check 1, reported separately from the first.

The `url` table inside `bitget.db` was loaded from `records.v2.jsonl` alone by
`sweeps/import-urls.cjs`. It is that one old sweep and not the sum of anything, so it is not a
shortcut to either reference set, whatever its 5.6M rows suggest.

## The five checks

Each says what must hold, what makes it fail, and what a failure means. None of them is written yet.
They belong in `checks/`, read-only, one question each, as the house rules there require.

### 1 — every swept URL was generated, and the catalog should hold more

**Must hold:** every `fileUrl` in the six current-universe sweeps has a row in `file` for the bitget
venue.

**Expected in the other direction:** `file` holding URLs the sweep never mentioned. That is the
intended outcome, not a discrepancy — measured against 1.46M files held locally, the download index
is complete for candlesticks and misses 0.27% of trades and 1.30% of depth, every one of which the
CDN serves.

**Every miss is probed directly.** `HEAD` the URL the sweep gave, unchanged. That is the only thing
that settles it, and it costs one request:

| the probe says | what it means |
|---|---|
| `200` | **a real failure.** The venue serves the file and the run never asked for it — either no series of the right (pattern, spelling) exists, or its floor sits above the date, or the date is above a retired shape's ceiling |
| `403` | the index advertised a key the CDN does not serve. Nothing is owed |

**Whether the index lists keys that have no file is an open question**, not an established fact. It
has been asserted and never demonstrated, so nothing here should assume either answer — the probe is
what decides, per key.

### 2 — the preamble reused seeded series rather than duplicating them

**Must hold:** no instrument has both a seeded series and a preamble-created one for the same shape.

The preamble matches an instrument to what the catalog holds on **canonical symbol and canonical
market** together, so this is a check on whether the seed's canonical agrees with what
`v3/market/instruments` returns today. Where it does not, the symptom is exact and silent: a new
series created beside the seeded one, and the seeded one marked `delisted` on the same pass.

**How to tell a created series from a seeded one:** by `series.id`. The seed is inserted by its
migration in one go, so bitget's seeded rows are the first contiguous block of ids the venue has and
anything above it was added during the run. Read the boundary off the database rather than carrying
it here — it moves with every re-seed.

**A failure names the mismatch directly** — the seeded canonical beside the API's, for that market.

### 3 — no newly found instrument has a deep backfill

**Must hold:** every preamble-created series has `first` within **10 days** of the tip it was created
with. An instrument listed since the seed was swept has published nothing before it was listed, so
its backfill is one request that finds nothing below the floor.

**A deeper walk means one of three things**, and which it is has to be established rather than
assumed:

- the download form never exposed that instrument, so the sweep could not have seen it — the
  interesting case, and the one that says the form's enumeration is short;
- the matching in check 2 failed, so an instrument the seed *does* hold was created again under a
  different canonical, and its "backfill" is really its seeded history being rediscovered;
- the seed was missing it for some other reason.

### 4 — a shape change keeps one history under one canonical symbol

**Must hold:** an instrument whose spelling or pattern changed mid-life has its whole history
reachable under one canonical `symbol`, spread over the several series that generate each half.

Bitget does this constantly — two venue-wide naming eras, plus per-instrument directory renames — and
each change is a separate series by construction, since `series_key` is
`(pattern_id, COALESCE(url_symbol, symbol))` and one row cannot generate both halves.

**The failure to look for is a hole at a boundary**: a symbol with files under one era's shape and
nothing under the adjacent era's, where the sweep said both exist. That is a `url_symbol` that is
right on one side of a rename and wrong on the other.

Comparing against `series-from-sweep.csv` is what makes this answerable — it holds the sweep's own
`first` and `last` per shape and spelling, so "the era the archive has and the catalog does not" is a
join rather than a judgement.

### 5 — no file landed near its experimental floor

**Must hold:** for every series, `first` is at least **15 days** above the `floor` the seed stated.

The floors are deliberately loose — one common value per dataset and grain, set below the earliest
date that dataset is known to hold — so a file found near one is not a near miss. **It is the assumption behind that floor being
disproved**, and it means the real start is earlier than anything asked about. Since generation never
looks below a tip and nothing walks this venue, whatever is under there is unreachable until a seed
says otherwise.

**A hit is a finding, not a failure**: it names a (dataset, era) whose floor has to move down and be
re-probed before the permanent seed is written from these results.

## What the permanent seed takes from the run

Once the five checks pass, the seed is re-extracted from the catalog rather than from the sweep:

| column | becomes |
|---|---|
| `floor` | that series' own measured `first`, in place of the per-dataset guess |
| `last` | the newest file actually seen, in place of what the index claimed |
| the series set | only the series the archive answered for; reconciliation has already deleted the rest |
| `symbol` | unchanged — the canonical, which check 2 is what validates |

And the temporary code goes: `ruleOnSuccess` reverts to following the multi-part trades chain, its
test is unskipped, and `SEEDED_AT` gets bitget's entry back — by then the horizon is a measurement
the seed has earned rather than one it borrowed.
