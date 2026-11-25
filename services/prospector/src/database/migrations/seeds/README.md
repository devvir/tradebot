# Seeds

A seed is catalog rows that ship with prospector, for what reading a venue's archive cannot
establish. A migration plants them once, through `seed.ts`; nothing else reads these files.

There are two kinds:

- **Series seeds** (`okx`, `bitget`). These venues answer no bucket listing (`ListObjects` is denied
  at every layer), so there is nothing to walk: every key is generated from a series the catalog
  already holds. The seed carries the venue's patterns, a series for every instrument that occupies
  them, each series' floor, and, for bitget, the transforms its URLs need. okx's download portal has
  an index of files, which prospector does not walk; see [OKX.md](../../../../../../docs/venues/OKX.md#archives).
- **Retirement-only seeds** (`htx`, `gate`, `binance`). These venues are walked, and a walk finds their
  shapes and instruments itself. What it cannot find is that a shape has ended: a missing file and a
  tree the venue stopped writing give the same answer. The seed is `pattern.csv` alone, one row per
  ended shape with its `retired_at`, and the walk fills in everything else.

## Layout

```
seeds/
  README.md
  seed.ts          the reader, shared by every venue
  binance/
    pattern.csv
  bitget/
    pattern.csv
    series.csv
    transform.csv
  gate/
    pattern.csv
  htx/
    pattern.csv
  okx/
    pattern.csv
    series.csv
```

A directory per venue, named as the `venue` table names it. A missing file reads as no rows. The build
copies the directories to `dist/` beside the compiled `seed.ts`.

## Adding a seed

1. Create `seeds/<venue>/` with the files the seed needs. The venue's row must already exist in
   `VENUES` (`migrations/001-core.ts`) with an empty `host`; `seed.ts` plants into that row and
   refuses a venue that has none.
2. Append a migration to `MIGRATIONS` in `migrations/index.ts`, marked `seedData: true`, whose `run`
   is `seed(db, '<venue>')`.
3. For a series seed, add the venue to `SEEDED_AT` in `seed.ts` (see [`last`](#last)).

A seed is read when a catalog runs its migration, and never again. Editing the CSVs changes what a new
catalog starts from; how an existing catalog is brought to match is the migration policy in
`migrations/index.ts`.

## The files are the tables

Each file is one of the catalog's tables (`pattern`, `series`, `transform` in `database/schema.ts`)
written out column for column, minus the ids the database assigns. Nothing is translated on the way
in: a `pattern` is the URL template itself, and `market`, `dataset` and `variant` are already
canonical. Columns are read by name, and **a column `seed.ts` does not read is ignored**, so a seed may
keep whatever its research found useful beside a row (bitget's `archivesMarket`, `displaySymbol`,
`listed`, `archivesFirst` and `archivesLast`).

### pattern.csv

```
virtual_id,market,dataset,variant,pattern,grain,retired_at,holds
1,future,books,"incremental,400",okx/match/orderbook/L2/400lv/daily/{YYYY}{MM}{DD}/{SYMBOL}-futureschain-L2orderbook-400lv-{YYYY}-{MM}-{DD}.tar.gz,daily,20260804,chain
2,future,books,"incremental,400",okx/match/orderbook/pro/L2/400lv/daily/{YYYY}{MM}{DD}/{SYMBOL}-futureschain-L2orderbook-400lv-{YYYY}-{MM}-{DD}.tar.gz,daily,,chain
```

- `virtual_id`: the row's identity inside the seed, which `series.csv` refers to. See
  [virtual_id](#virtual_id).
- `market`, `dataset`, `variant`: the slice the pattern publishes into, found or created as the row
  is read.
- `pattern`: the URL template, with [slots](#slots) where the varying parts go.
- `grain`: checked, not taken. A pattern's grain is read off its slots, and a row stating another is
  refused. Empty is accepted.
- `retired_at`: the last date the shape was written, inclusive (`yyyymm` or `yyyymmdd`); empty while
  it is live. Generation for a retired shape runs up to that date and no further, and a newly listed
  instrument gets no series on it.
- `holds` (optional): `chain` where one file of the shape carries every expiry of a family under the
  family's name, as okx's `…-futureschain-…` files do. Empty or absent is `instrument`.
- `bundle` (optional): `instrument` or `market`. Empty or absent, a pattern with a `{SYMBOL}` slot
  holds one instrument per file and one without holds a whole market.

In a retirement-only seed, a row must name the slice and spell the pattern exactly as the venue's
adapter reports them. The walk then meets the row already in place and takes its `retired_at`; a row
that differs is a separate shape, and the walk creates the live one beside it. The shapes these seeds
carry are of two kinds: trees the venue stopped writing, and shapes whose directory is a fixed month
that holds a single day:

```
virtual_id,market,dataset,variant,pattern,grain,retired_at
1,perp,indexPrice,15m,data/index-klines/linear-swap/daily/{SYMBOL}/15min/{SYMBOL}-15min-{YYYY}-{MM}-{DD}.zip,daily,20260804
```

```
virtual_id,market,dataset,variant,pattern,grain,retired_at
4,spot,klines,1m,spot/candlesticks_1m/202407/{SYMBOL}-{YYYY}{MM}{DD}.csv.gz,daily,20240630
```

The first is from `htx/pattern.csv`, the second from `gate/pattern.csv`. Which shapes ended when is
venue fact, in each venue's doc under `docs/venues/`.

### series.csv

```
pattern_id,symbol,url_symbol,last,floor
1,AAOI-USD_UM_XPERP,,20260804,20260709
34,@,,20260904,20210901
```

- `pattern_id`: a `virtual_id` from `pattern.csv`. A series has no venue of its own and reaches it
  through its pattern, so the patterns are planted first.
- `symbol`: the instrument, which is found or created (as a chain where the pattern `holds` chains).
  `@` is the market bundle, and goes only under a pattern whose files hold a whole market; `@` under a
  per-instrument pattern, or an instrument under a market pattern, is refused.
- `url_symbol`: how the archive spells the instrument where that differs from `symbol`; empty
  otherwise.
- `last`: the newest file seen. Empty means not measured. See [`last`](#last).
- `floor`: the first period worth asking about. See [`floor`](#floor).

`floor` and `last` must be stamps of the pattern's grain (`yyyymm` for monthly, `yyyymmdd` for daily).
Two rows of one pattern with the same key spelling (`url_symbol`, or `symbol` where that is empty) are
one series: an exact repeat is skipped, and one that differs in anything else is refused.

### transform.csv

What one instrument puts where its pattern says `{TRANSFORM:kind:default}`, over a span of dates.
Absent for a venue whose URLs follow their patterns.

```
market,symbol,dataset,kind,transform,date_from,date_to
future,BTCCMZ26,,archiveDir,BTCCM_D2,20260903,
```

`dataset` empty applies to every dataset whose pattern asks for that `kind`; a named dataset limits
the row to that one. `date_from` is required and `date_to` empty is open-ended, both inclusive stamps. Where no row
applies, the default written in the slot stands.

### Slots

A pattern is literal except for its slots:

| slot | filled with |
|---|---|
| `{SYMBOL}` | the series' `url_symbol`, or its `symbol` |
| `{YYYY}` `{MM}` `{DD}` `{HH}` `{MI}` | the period's year, month, day, hour and minute |
| `{PART}` | one part of a period the venue publishes as several files; which parts exist is the adapter's `expandParts` answer |
| `{TRANSFORM:kind:default}` | the `transform.csv` row for the instrument, kind and date, else `default`, which may itself be a slot (`{TRANSFORM:archiveDir:{SYMBOL}}`) |

An adapter may fill further slots of its own through `slotsFor`, such as `{MONTH_LAST_DAY}`; the full
list is the `pattern` column's comment in `database/schema.ts`. The grain comes from the finest
calendar slot: a slot ending in `MI}` is minutely, `HH}` hourly, `DD}` daily, and none is monthly.
`{PART}` declares no grain.

### virtual_id

The database assigns a pattern's real id as the row is written, so the two files need a name for a
pattern that both agree on beforehand. That is all a `virtual_id` is: not a line number and not an
order. Renumber freely, so long as every `pattern_id` still points at the row you meant. `seed.ts`
refuses a `pattern_id` with no matching `virtual_id`, which catches a deletion but not a renumbering.

## The bounds a seed states

### floor

The file states a `floor`, the first period worth asking about. The table holds a `tip` instead: the
claim that everything at or below it is settled, with generation starting at the period after it. So
`seed.ts` stores `tip` as the period before the floor, in the series' grain.

A floor too high loses files without a trace, because a tip only moves forward and nothing asks below
it. A floor too low costs requests. A row with no floor plants a series with no tip, which generation
skips.

A seed carries no `first`. The catalog's `first` and `last` are what its `file` table holds: a sighting
only lowers `first` and only raises `last`, and the reconciliation that ends every finished pass resets
both to the earliest and newest file on record. Any seeded `first` would be replaced by the first
finished pass.

### last

`last` is the newest file the pass that built the seed saw: proof the archive reaches that far, never a
claim that it stops there, and never a ceiling on generation.

It also lets the first pass skip what the seed already measured. `SEEDED_AT` in `seed.ts` records the
day each series seed was built; the pass that built it asked every series above its `last` up to that
day and found nothing. So on a venue with no listing, until a pass over it has finished, generation
skips each series from the period after `last` to `OVERDUE_DAYS` before the seed's date. `SEEDED_AT` is
edited together with the CSVs it dates.

## Research seeds and permanent ones

The files read the same either way, and nothing in the service knows which kind it holds.

A **permanent** seed is the output of a finished investigation: a floor per series at its measured
start, `last` where the archive was seen to reach, and only the series the venue turned out to serve.
The shipped series seeds are permanent. A series that holds no file is deleted by the first finished
pass, so a permanent seed does not ship one.

A **research** seed is the instrument that produces one, run through prospector because a finished
pass is a measurement. Floors sit far below where any file of a dataset can be, and series are declared
for combinations nobody expects to exist. When the pass has finished, the `file` table says which
series are real and where each begins and ends, and the permanent seed is written from that. A file
found near a research floor means that floor was too high.

## Quoting

A field is quoted only where it contains a comma or a quote, as multi-part variants such as
`"incremental,400"` do. Inside a quoted field a doubled quote is one literal quote. Empty is empty:
there is no distinction between an empty string and a null. A field spans one line, and a row must
have as many fields as the header.

## The bitget seed

bitget's archive answers no listing, and its download index both omits files that are served and
offers keys that are not, so a key is a file only once it has been fetched. The seed is the catalog's
whole starting knowledge of bitget: every pattern, every series, and the transforms its keys need.
The venue itself, its naming eras, line tokens, endpoints and download index, is described in
[BITGET.md](../../../../../../docs/venues/BITGET.md#archives).

### What it holds

- **Only the series that answered.** The pass that built the seed asked every instrument against
  every shape its market has had, and kept the combinations that published at least one file.
  Instruments the venue no longer lists are in it, since no listing would ever create them.
- **A measured `floor` on every series**: the series' first file as that pass found it. No series on
  an era-2 pattern (the bare-date shapes retired on `20260817`) has a floor before `20240419`; see
  [The eras](#the-eras).
- **A measured `last` on every series**: the newest period that answered. `SEEDED_AT` in `seed.ts`
  holds bitget's entry, `20260922`, the day that pass ran.
- **Research columns**, which `seed.ts` does not read: `displaySymbol`, the name the download form is
  asked with; `listed`, `no` for the few streams the form does not offer; `archivesFirst` and
  `archivesLast`, what the download index claimed for the series, kept for comparison; and
  `archivesMarket` on a pattern, the archive line it belongs to.

Each daily dataset also has a monthly tree (`kline_month/`, `trades_month/`, `depth_month/`,
`depth_500_month/`). Those are patterns of their own, monthly grain, with series of their own.

### The floors held

The pass began each dataset well below anything the index had shown. On the run that finished
2026-09-22, the earliest first of every dataset sat at least 69 days above the floor it was asked
from:

| dataset | earliest first found | margin above the floor asked from |
|---|---|---|
| klines, trades (daily) | 2018-07-25 | 85 days |
| quotes (daily) | 2024-07-09 | 69 days |
| books (daily) | 2025-08-01 | 92 days |
| every monthly tree | 2025-08 (books 2025-09) | 8 months or more |

Per series the index is not a floor. In the shipped rows, 350 series have a `floor` earlier than
their `archivesFirst`, by up to 642 days, and 48 have no `archivesFirst` at all.

### The eras

The patterns follow bitget's three naming eras: era-1 shapes are retired on `20240418`, era-2 shapes
on `20260817`, and era-3 shapes are live. The books patterns have one daily shape, live throughout.

Where a day is served under both an era-1 and an era-2 name, the era-1 key is the one generated: no
era-2 series has a floor before `20240419`, so era-2 keys dated earlier are never asked. The two
copies usually hold the same candles, but not always: some era-1 kline files are 22-byte empty
archives whose era-2 key holds the full day. What that costs the catalog is in
[BUGS.md](../../../../../../docs/planning/BUGS.md#bitget-the-catalog-holds-the-poorer-of-two-copies-of-some-days).

Some days of a continuous era-1 kline series exist only under the era-2 name. The era-1 kline
patterns name their file through `{TRANSFORM:eraName:…}`, whose default is era 1's own spelling, and
each such day has one `eraName` row that spells era 2's instead (`UMCBL/{YYYY}{MM}{DD}` on perp,
`SP/{YYYY}{MM}{DD}` on spot), so the series reads that day from where bitget put it and stays one
series. There are 20 rows, on 2020-02-29, 2023-01-05 and 2023-02-21.

### The transforms

| kind | default in the pattern | what a row says |
|---|---|---|
| `marginToken` | `UMCBL` | the margin line a futures instrument's trades are filed under: `CMCBL` (USDC-margined) or `DMCBL` (coin-margined). Nothing in the symbol shows it |
| `archiveDir` | `{SYMBOL}` | the directory, where it is not the name the filename carries |
| `eraName` | era 1's filename | the era-2 filename for one era-1 kline day, as above |

The `archiveDir` rows are of two kinds. Open-ended rows, nearly all from `20260903`, cover depth
directories that stopped matching their filenames. One row bounded to `20221117` puts perp
`RUNEUSDT`'s kline day under `TRXUSDT/`, where its only copy is.

A futures instrument discovered after seeding gets its `marginToken` row from discovery, not from this
file (`marginOf` in `adapters/bitget/instruments.ts`).

### Spellings

`url_symbol` belongs to the series, not the instrument: an instrument's datasets, and its shapes over
time, can each be spelled differently, and each spelling under each pattern is its own series.

Ten spot instruments have their era-2 depth (`quotes`) filed under the canonical symbol while their
klines and trades use another spelling. Their era-2 depth series carry no `url_symbol`, their klines
and trades series carry the other spelling, and none of the ten has an era-2 depth series under the
other spelling:

| `symbol` | `url_symbol` of its klines and trades |
|---|---|
| `LIQUIDIUMUSDT` | `LIQUIDIUMTOKENUSDT` |
| `MRSOONUSDT` | `SOONUSDT` |
| `VELOUSDC` | `VELO1USDC` |
| `KAONUSDT` | `AKROUSDT` |
| `TXUSDT` | `COREUMUSDT` |
| `CATEUSDT` | `CATENEWUSDT` |
| `RBTCUSDT` | `RBTCNEWUSDT` |
| `RUNESXUSDT` | `RUNESXBITCOINUSDT` |
| `SOPHUSDC` | `SOPHNEWUSDC` |
| `SPACEUSD1` | `SPACENEWUSD1` |

Two instruments of one market may share an archive spelling (41 spellings across 298 series in the
shipped rows), because bitget re-issues tickers and moves streams between names. That is not an
error so long as they sit on different patterns or cover different dates. **What must never happen
is two series generating the same key for the same date**: `file` holds one row per venue and path,
the series that settles the key first keeps it, and the other reads as a hole. `seed.ts` refuses two
rows of one pattern with the same spelling; beyond that, comparing spellings proves nothing, and the
check is the generated keys.

### Trades in parts

A day of trades is one or more numbered files (`{PART}`). The adapter's `expandParts` asks `001`
first, asks the next number after each part found, and ends the day at the first miss, so a day is
followed to its last part.

### After seeding

Updates find instruments listed later through bitget's v3 instruments endpoint, for the `SPOT`,
`USDT-FUTURES`, `COIN-FUTURES` and `USDC-FUTURES` categories, and give each new one a series under
every live shape of its market. Instruments the v3 listing does not name are reached only through
the seed. How the service handles bitget is in
[PROSPECTOR.md](../../../../../../docs/services/PROSPECTOR.md#bitget).

### Rebuilding it

None of this runs in the service. The endpoints are described in
[BITGET.md](../../../../../../docs/venues/BITGET.md#archives).

1. **The instruments.** Crawl `getSymbolList`, the download form's dropdown. It matches a substring
   anywhere in a name and caps a reply at 200 with no paging, so a reply of 200 is refined with a
   longer substring and a reply under 200 is complete for its substring. A query given up on is an
   unexplored subtree that looks like a complete one, so a refusal is asked again, never taken as an
   empty answer. Add the REST listings, which hold names the crawl cannot construct.
2. **The files.** Sweep `getPublicDataV2` for each line, business type and `deptType`, asking with
   every name offered on that line at once, in consecutive 8-day windows from 2018-01-01. Only
   `code: "200"` is an answer; anything else is asked again, and a window that never answers is
   recorded as failed, not as empty. Match every returned URL against the known shapes, which gives
   its pattern and the string in its `{SYMBOL}`.
3. **The search space.** Every instrument against every shape its market can carry, futures trades
   only under its own margin token, split wherever the pattern or the spelling changes. Not the
   combinations the index returned: the index omits files that are served and offers keys that are
   not, and since nothing walks bitget, a key the seed does not name is never probed. Floors go below
   anything the dataset can hold. This is a research seed (see
   [Research seeds and permanent ones](#research-seeds-and-permanent-ones)).
4. **The measurement.** Run a full pass over the research seed, then write the permanent seed from the
   `file` table: the series that hold a file, each one's first file as its `floor` and newest as its
   `last`. Set bitget's `SEEDED_AT` to the day the pass ran.
