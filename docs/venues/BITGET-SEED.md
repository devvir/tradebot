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


## Its floors are measured

**Every series' floor is its own first file**, as a full pass found it by asking — except that no
era-2 series starts before its era does, on 2024-04-19 (see *What the archive does* below). Nothing here is the
download index's word: that pass began each dataset from a floor deliberately below anything the index
had shown, asked every combination of instrument and shape the venue could publish under, and kept
only what answered.

| | what the seed holds |
|---|---|
| `floor` | the series' first file, measured |
| the series set | only the series that published at least one file; every other combination was asked and answered nothing |
| `last` | empty — see below |
| `archivesFirst`, `archivesLast` | what the download index claimed, kept for comparison and read by nothing |

**The floors the pass started from held.** Measured on the run that completed 2026-09-22: the earliest
first of every dataset sat at least 69 days above the floor it was asked from, and no series found its
first within a month of one.

| dataset | earliest first found | margin above the floor asked from |
|---|---|---|
| klines, trades (daily) | 2018-07-25 | 85 days |
| quotes (daily) | 2024-07-09 | 69 days |
| books (daily) | 2025-08-01 | 92 days |
| every monthly tree | 2025-08 (books 2025-09) | 8 months or more |

Each earliest first is also the date the index gave for where that tree begins, so at the level of a
whole dataset the index was right. **Per series it was not**: on the same run 1,424 series had files
earlier than the index's first for them — by as much as 680 days — and 41 had files the index never
listed at all. That is why the floor comes from the pass rather than from the sweep.

**The index also lists keys that do not exist.** Two spot kline series, `BLZ/USDT` and `WAVES/USDT`
on the naming retired 2024-04-18, had 1,113 files offered by the download form and none served: every
one answers `403` from the origin while the same origin serves those symbols' other shapes with `200`.
At this bucket a `403` for a missing key is how absence is spelled, so a key the index offers is a
claim to be probed, never a file.

**`last` is empty because the pass that measured the floors never looked for it.** While it ran,
`ruleOnSuccess` dropped every queued key of a series the moment one answered — that pass wanted each
series' start and nothing else — so no series was followed to its end. The pass that measures the
ends is what fills it.

**That rule is gone; two pieces of the measuring configuration remain.** The multi-part trades chain
stays commented out, because a pass looking for the date a series stops at has its answer from the
first part and following the chain would spend a request per part to learn nothing it is asking —
so its test stays skipped with it. And `SEEDED_AT` still withholds bitget's entry, because the
horizon it would state keys off a `last` this seed does not have yet. Both come back when the catalog
is expected to hold whole days of trades.


## What this seed asserts

**Every series that has published a file, from the first one it published.** The set is not a
guess at what the venue holds: it is what answered when every name in the dropdown crawl was asked
about under every shape its market has had.

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
| `eraName` | era 1's own filename | an era-1 kline day bitget only ever published under era 2's name: `UMCBL/{YYYY}{MM}{DD}` on the futures line, `SP/{YYYY}{MM}{DD}` on spot, one row per day |

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

**The eras cut on 2024-04-19 and 2026-08-18, and the seed cuts with them.** Bitget did not: 440
era-2 kline keys carry dates from 2019 to 2023, and every instrument's trades of 2024-04-18 are
served under both names. **No era-2 series is seeded below 2024-04-19**, so none of that is ever
generated. Where era 1 also holds the day — 417 of the kline days and every trades file — the
content is the same and era 1's copy is the one catalogued. Twenty kline days exist only under era
2's name inside otherwise continuous era-1 series, and those are `eraName` transforms of the era-1
series; the three left over are isolated files with no series around them, and are not catalogued.
The measurements are in [BITGET.md](BITGET.md#the-three-naming-eras).

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
