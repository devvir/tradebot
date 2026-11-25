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

## The bitget seed

bitget's is the one seed with a `transform.csv`, whose kinds are `archiveDir`, `eraName` and
`marginToken`, and with research columns beside its rows. Venue facts are in
[BITGET.md](../../../../../../docs/venues/BITGET.md#archives).

## Quoting

A field is quoted only where it contains a comma or a quote, as multi-part variants such as
`"incremental,400"` do. Inside a quoted field a doubled quote is one literal quote. Empty is empty:
there is no distinction between an empty string and a null. A field spans one line, and a row must
have as many fields as the header.
