# Seeds

What a venue publishes, for the venues nothing can discover.

A listing venue is walked: its shapes and instruments are read out of the archive, and the first
walk establishes everything a seed could have said. okx and bitget publish no listing at any
layer — no `ListObjects`, no index, nothing that answers about more than one key — so what they
contain cannot be found by looking. It has to be brought.

That is all these files are. `seed.ts` reads them; nothing else does.

## Layout

```
seeds/
  seed.ts          the only code, shared by every venue
  README.md        this
  okx/
    pattern.csv
    series.csv
  bitget/
    pattern.csv
    series.csv
    transform.csv  optional — most venues have none
```

A directory per venue, named as the `venue` table names it. Adding a venue is a directory and a
one-line migration that calls `seed(db, '<venue>')` — no new code.

## The files are the tables

Both files are the catalog's own tables written out, column for column, minus the ids the
database assigns. Nothing is translated on the way in: a `pattern` is the pattern string that
generates a URL, and `market`, `dataset` and `variant` are already canonical.

**pattern.csv**

```
virtual_id,market,dataset,variant,pattern,grain,retired_at
34,spot,trades,,trades/SPBL/{SYMBOL}/{SYMBOL}_{YYYY}{MM}{DD}_001.zip,daily,
```

**transform.csv** — what one instrument puts where its pattern says `{TRANSFORM:kind:default}`,
over a span of dates. Absent for a venue whose URLs follow their patterns.

```
market,symbol,dataset,kind,transform,date_from,date_to
perp,AAVEPERP,,marginToken,CMCBL,20250208,
```

**series.csv**

```
pattern_id,symbol,url_symbol,last,floor
1,$AIUSDT,,,,20180502
```

**A column nobody reads is ignored**, so a seed may carry whatever its own research found worth
keeping beside a row — bitget records the `displaySymbol` its download form answers for, so a later
reader can search for a series' files without re-deriving anything. Only the table's own columns and
`floor` are read.

`pattern_id` is a `virtual_id` from the file above. A series has no `venue_id` of its own — it
reaches its venue through its pattern — so the patterns are written first and their real ids
mapped as they go.

### virtual_id

**A line's identity inside the seed, and nothing else.** The real id belongs to the database and
is not knowable until the row is written, so the two files need a name for a pattern that both
can agree on beforehand.

It is not a line number and it is not an ordering. Renumber it however you like, so long as every
`pattern_id` in `series.csv` still points at the row you meant — change one without the other and
tens of thousands of series quietly attach to the wrong shape. `seed.ts` refuses a `pattern_id`
with no matching `virtual_id`, which catches a deletion but cannot catch a renumbering.

### What is deliberately not here

- **A `first`.** Not a column here at all, and the reason is narrower than "a seed should not
  guess". **Nothing ever raises a `first`** — `sawFile` lowers it and only lowers it — so a seeded
  start is uncorrectable the moment it is too low, and it becomes too low as soon as the venue
  withdraws its earliest file. That is a lie in a column everything downstream trusts, with nothing
  in the system able to notice it.

  A `floor` costs the first pass a few requests and arrives at whatever is true today: right where
  a stated `first` would have been right, and right where it would not.
- **A `last` nothing measured.** The column carries what the research actually saw, and is empty
  where it saw nothing.
- **Series `state`.** It defaults to `active`. What the venue listed on the day the seed was
  built says nothing about today.
- **Empty series, in a *permanent* seed.** A series the archive answers nothing for is not worth
  shipping: reconciliation deletes it after the first completed pass, so it is work in both
  directions. A **research** seed is the opposite case and deliberately declares them — that a
  combination is empty is one of the things the pass is being run to establish.

### What is here and matters

- **`floor`** — the **first period worth asking about**, and the one this file states directly.

  The table holds a `tip` instead, which is a different claim: everything at or below a tip is
  settled, and generation starts at the period *after* it. Nothing has walked a seeded venue yet,
  so there is no settled history for a seed to claim — what a seed knows is where to start. Written
  as a tip, every floor in the file sat one day or one month before the thing it described and a
  reader had to carry the off-by-one to see the number meant.

  So the file says `floor`, and `seed.ts` writes `tip = floor − 1` in the series' own grain. The
  table is unchanged; only the language here is.

  A floor too high loses files silently, because a tip only ever moves forward. One too low only
  costs requests.

  **Before anything has measured the venue, a floor is a claim about a whole dataset.** It is set
  deliberately far below where that dataset is thought to begin — per market and dataset, books
  additionally by era, since okx's `pro/L2/` trees start where the old ones stop. At that stage a
  floor is not an estimate of where data starts; it is the instrument that measures it. A hit
  landing near one means it is too high and wants reviewing before it costs something; a hit below
  where the archive was assumed to begin is the assumption being disproved, which is the whole point
  of asking down there. One series' start is no evidence about the dataset, which is why they are
  shared at this stage.

  **Once a pass has measured every series, a floor is that series' own measured start.** The claim it
  makes has changed: the venue-wide guess has done its work and been replaced by what was found.
  This is what a re-extracted seed carries, and it is the difference between asking about a venue's
  whole calendar and asking about each instrument's own life — for okx, 18.6M keys against 7.2M.
- **`last`, where something measured it.** Empty otherwise.

  A `last` needs only a file: seeing one proves the archive reaches at least that far. It is
  "the newest file seen", never a claim the archive stopped there.

  **A stated `last` is never a claim that the series ended**, so there is no need to withhold one
  for an instrument the venue still lists. It is read in two places and neither treats it as a
  ceiling: `open` uses it to decide whether a quiet series on a **retired** shape is still worth
  asking about, and `updatePage` uses it with `SEEDED_AT` to skip the span the seeding pass already
  looked at and found empty. Generation runs to the frontier either way — see `under` in
  `update.ts`, which says outright that `last` must not become a bound.

  **`SEEDED_AT` in `seed.ts` dates the seed**, and is updated with the CSVs it describes.

- **Pattern `retired_at`** — the last date a shape was written to, empty while it is still live.
  It is an inclusive ceiling: generation runs up to it and stops, so the archive under a dead
  naming goes on being read while nothing is asked for beyond the day it died. No *new* series is
  made on a retired shape either. bitget's superseded namings and okx's pre-`pro/L2/` book trees
  are retired here.

## Research seeds and permanent ones

The files read the same and mean different things, and mistaking one for the other is how a
throwaway becomes canon.

A **permanent** seed is the output of a finished investigation: one floor per series at its measured
start, `last` where the archive was seen to reach, and only the series the venue turned out to serve.
okx ships one. A venue holding it finds its whole history as surely as a listed venue walks to its
own.

A **research** seed is the instrument that produces one. Floors sit far below where any file of that
dataset can be, series are declared for combinations nobody expects to exist, and the pass is allowed
to ask about all of it — because a run that finds files near a floor has proved that floor wrong,
which is the only cheap way to be wrong. When it has run, the `file` table says what is real and the
permanent seed is written from that.

**Prospector is being used as the tool, not being described by it.** A standalone script could do
the same crawl; it would be re-implementing generation, probing, pacing and resumability to do it.
Nothing in the service knows which kind of seed it is holding, and nothing needs to.

## Quoting

A field is quoted only where it contains a comma or a quote — today that is okx's
`"400,incremental"` and `"5000,incremental"` variants and nothing else. A doubled quote inside a
quoted field is one literal quote. Empty is empty; there is no distinction between an empty
string and a null, and none is needed.
