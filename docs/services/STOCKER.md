# Stocker

Stocker turns raw files into the vault: every venue's data normalised into one Parquet format per
canonical table, so a consumer never has to care which venue or source a row came from, or what
shape it arrived in.

**Stocker owns the vault.** It alone stocks it, writing its Parquet files and its ledger. A copy of
the vault kept elsewhere may take files out of it and put them back, and records itself in
`backedup.csv` beside the ledger (see [The ledger](#the-ledger)).

**A series is about a format, never about a source.** Stocker reads the archives, partition by
partition as the catalog lists them ([Providers](#providers)). A source is an availability choice
about *how* something was obtained, not a different kind of data — a trade is a trade — so what
stocker knows of a file is its format, mapped onto the canonical table of its dataset, or of a
variant where the variant changes the shape, as whether a book is snapshots or deltas does.
**Raw is never modified, moved or deleted.**

## Scope

**Does:**

- Decode every container and format the series map declares
- Map each format onto a **canonical table** with one schema across all venues
- Impose one path convention, one timestamp unit, one identity per instrument
- Write Parquet partitioned so a query engine can prune
- Stock a partition again whenever anything it was built from changes

**Does not:**

- Modify anything under the archives — the mount is read-only, so the code is not trusted with it
- Invent data. A field a source does not publish stays NULL; it is never derived and presented
  as sourced
- Merge venues into one series. Cross-venue is a query, not a stored artifact
- Resample, fill gaps or clean outliers — those are opinions and belong downstream
- Decide what a file is. The catalog says which venue, market, dataset and variant a file is;
  stocker reads it accordingly and never second-guesses it

The line: **normalise structure, never semantics.** Renaming `depth` → `orderBook` and
converting seconds to microseconds is mechanical and reversible. Deciding a 50-level book and a
5000-level book are interchangeable is a judgement, and once stored as fact it is invisible.

## Path convention

```
<vault>/venue=…/market=…/dataset=…[/interval=…][/kind=…][/depth=…][/aggregated=…]/@/<YYYYMM>.parquet
<vault>/venue=…/market=…/dataset=…[/interval=…][/kind=…][/depth=…][/aggregated=…]/<symbol>/<YYYYMM>.parquet
…/<@ or symbol>/<YYYYMM>.pre.parquet     the month's first hours, from the month before
…/<@ or symbol>/<YYYYMM>.post.parquet    the month's last hours, from the month after
```

**A vault slice** is the directory `venue=…/market=…/dataset=…` with the levels below it that its
table carries; a **vault partition** is one month of it. Several partitions of the archives — the
same data at another grain or in another bundle — stock into one vault partition.

| Level | Holds |
|---|---|
| `venue=` | the catalog's venue |
| `market=` | the catalog's market — `spot` · `perp` · `future` · `option` · `tradfi` |
| `dataset=` | the canonical table. The three book tables — `orderBook`, `orderBookSnapshot`, `orderBookBands` — share `orderBook`. It is not the catalog's dataset name (`books` is stocked under `orderBook`); the ledger keeps that |
| `interval=` | `klines`, `markPrice`, `indexPrice`, `premiumIndex`, `optionMarkPrice` and `optionTicker`, where the catalog's variant is a bar length. A tick stream (`ticks`) has none |
| `kind=` | `funding`: `realised` or `predicted`. The book tables: `incremental`, `snapshot` or `bands` |
| `depth=` | the book tables, below `kind=`: how far the book goes (`400`, `full`, `20`, `5pct`) |
| `aggregated=` | `trades`, always: `false` for every trade as it happened, `true` for a venue's aggregation of them |

The levels below `dataset=` come from the catalog's variant. **Which levels a vault slice carries is
a property of the table, never of the venue**: path depth that varied by venue inside one table would
make every query and writer branch on which venue it was looking at. Trades say `aggregated=false`
outright, so the level is there to filter on whether or not a venue publishes the other kind.

**A file's name says what it holds, and never which build wrote it.** A month stocked again is
written over the month that was there, so a file is found at the same path for as long as the vault
holds it. What it was built from is written in [the ledger](#the-ledger) and nowhere else.

**The hours a neighbouring month's files hold of a month are a file of their own**, beside the
month's own rows and never in them. A month has such a file only where its venue cuts its periods
away from UTC midnight — see [Time](#time).

**A month is stored one of two ways, decided by its size.** A small one is a single file holding
every instrument, under `@`. One whose archive files weigh more than 1 GB (as the catalog counts
them) is a file per instrument, each under its symbol. A month whose files decode to nothing is one
file under `@` whatever it weighed. That weight is one number for every deployment and not a
setting: how a month is stored is part of its layout, and two deployments splitting at different
weights would store the same partition two ways.

**Why two.** The number of files is what makes a tree slow to count, move or delete, and most
months are small: a file per instrument would be thousands of tiny files each. But the largest
months weigh hundreds of gigabytes, and a file is what is moved or copied whole: stored per
instrument, one instrument's share of such a month can be moved on its own. So small months stay
one file, and large ones are cut where it is useful to cut them. Measured against the catalog on 2026-10-04, a threshold of 1 GB stores 13,209
of 15,084 months whole and 1,875 per instrument, about 1.5 million files in all.

**The symbol is a column of every file**, in both forms, so the two read as one table and a vault
slice whose months are stored both ways needs no special handling: one instrument's history is its
own folder and `@`, filtered by symbol. **A whole month is ordered by symbol, then time** — one
instrument's rows together, which is how it is read. On a month of gate's spot trades (852
instruments, 24 million rows), one file in that order answers a single instrument's month in
196 ms against 186 ms for a file per instrument, and is 5% larger.

**`@`, the symbol folders and the file names are bare**, not `key=value`. They are devices for
handling the files rather than facts about the data, so a query engine ignores them and nothing
can filter on them. A query engine also refuses a tree where some files carry a key in their path
and others do not, which is why the symbol is a column everywhere and its folder is bare. Reading
one instrument is naming the two folders it can be in, `@` and its own:

```sql
SELECT * FROM read_parquet([
  '<vault>/venue=okx/market=spot/dataset=trades/aggregated=false/@/*.parquet',
  '<vault>/venue=okx/market=spot/dataset=trades/aggregated=false/BTC-USDT/*.parquet'
], hive_partitioning=true)
WHERE symbol = 'BTC-USDT'
```

**Hive `key=value` directories.** The levels are not stored in the files — `parquet_schema` on a
file shows only the data columns — yet queries return them as columns read from the directory
names, and filtering prunes files without the caller building a path. Storing them as real columns
would cost about 0.8 % (measured on a 200k-row sample: Parquet dictionary-encodes a constant column
to one entry and zstd flattens the rest), so this buys ergonomics rather than space. **A filter on a
plain column does not prune files** — only path keys do.

**`dataset=` rather than `table=`**, because `table` is a SQL reserved word — a column named that
must be quoted in every query mentioning it.

**`market=` carries contract shape only.** Margining is not part of it: linear and inverse
perpetuals are both `perp`, and which one an instrument is travels as the `margin` column (see
[Canonical tables](#canonical-tables)).

`kind` separates funding that was **charged** from the running **estimate** of the next
interval. They are different things: a forecast is not a fact, and their timestamps can coincide,
so interleaving them in one file gives duplicate timestamps distinguished only by a column. It
cannot be a column: a filter on a plain column prunes no files.

**An attribute lives in the file or in the path, never both.** `interval` is a path attribute: no
klines file stores it as a column, and `ts` plus the path's interval is what defines a bar's period
as `ts` to `ts + interval`.

**File names are descriptive** rather than `data.parquet`, because a file that leaves the tree
travels alone — an upload queue or transfer log shows the name, not the path.

## How a sweep decides

A sweep asks the catalog what every partition holds, and stocks what the vault's ledger does not
have at its current revision. Nothing is written but the vault.

1. **Ask for what can be acted on.** One request per venue in scope, for the datasets the series
   map reads of it: the partitions with nothing left to download that the catalog takes as settled
   ([Providers](#providers)). A partition a run is still adding to can be complete on disk at every
   moment and still be a fraction of itself, and only the catalog knows which — so one that is not
   settled is not in the answer, and comes up in a later sweep. Each partition comes with how many
   files it has, their total size, and the catalog's version of it. **The running month is never
   stocked**, even where the lens lets it through: its files are still arriving.
2. **With or without its neighbour.** A partition whose venue's periods spill across the month
   boundary reads the edge of a neighbouring month where that month is in the answer with files, and
   is stocked without those hours where it is not (see [Time](#time)).
3. **Current?** The partition's revision — below — is computed from what the catalog answered. If
   [the ledger](#the-ledger) has the partition at that revision, it is current and nothing is read,
   whether or not its files are there. The vault's files are never asked: a file does not say what
   it was built from, so one the ledger has no line for is nobody's word for anything. One the
   ledger has at another revision is **outdated**, and the ledger is told so before anything else
   is done about it — unless all that is new is a neighbour's hours (next step).
4. **Only its neighbour new?** A month stocked without a neighbour's hours, whose neighbour is in
   the answer now, has only those hours built — from the neighbour's files. Its own archives are
   not read, and need not be on disk any more. Its own files in the vault are: the hours are built
   beside them, so every file its ledger line counts must be there. Where some have been moved out,
   or the neighbour's files are not on disk, the month waits and says so (`Spill pending`): which of
   the two is missing, and whether a copy of its own files exists elsewhere, read from
   `backedup.csv` — the difference between bringing a file back and stocking the month again.
5. **On disk, and room to extract it?** The partition's files are gathered from the archives and
   compared with what the catalog says, by count and by total size — no file is opened — and so are
   the files of any neighbour it reads the edge of. Where several renderings are ready, the
   preferred one is tried first (see below) and the next is tried where it falls short. A rendering
   that is on disk but would not leave the vault's volume its floor once extracted is passed over
   with a warning saying what it needs and what is free; below the floor itself
   (`STOCKER_MIN_FREE_GB`) the sweep stops instead. A partition no rendering can be stocked from is
   counted: as waiting for room to extract where one was passed over for that, and otherwise as not
   on disk as catalogued.
6. **Stock** into a staging directory under `<vault>/.stocker-tmp/stage/`: the month's own rows,
   and each neighbour's hours, apart. A month stored per instrument is built a file per instrument;
   a small month is built a file per batch of instruments, joined into one in symbol order.
7. **Put in place**, one partition at a time. Nothing in the vault is touched until everything is
   built. Then, in order: the ledger is told the month is changing; whatever of the month is in the
   vault is removed; the new files are renamed in, under `@` or under their symbols; and the ledger
   is told what the month holds. A month that was neither in the vault nor in the ledger skips the
   first step — until its line is written it is not stocked, whatever of it is in place.

**Nothing is checked again after a build.** A partition that changed while it was being stocked
has a new version in the catalog, so the next sweep computes a revision the vault does not hold
and stocks it again.

**A sweep lists the vault's directories for two things**, besides putting right a partition caught
half way: to find what of a month is there to make way, as it is stocked; and, for a stocked month
whose neighbour has arrived, to see that every file its ledger line counts is there. A vault slice
stored per instrument is a folder per symbol, so asking it about one month means listing every one
of them; it is listed once per sweep, and again only after something is written to it.

**Several renderings of one month land in one vault partition.** A venue can publish the same data
monthly and daily, or per instrument and as a market bundle (`@`), and the catalog holds each as a
partition of its own. They stock into the same vault partition, and whichever of them the ledger
already holds at its current revision makes the month current. Otherwise one is chosen:
per-instrument files before a market bundle, then the coarsest grain — the fewest files for the same
rows.

### The revision

A stocked partition's revision is the first twelve hex digits of a SHA-256 over:

- the versions that say what is written — below;
- the canonical table's column list;
- the catalog partition it is stocked from — its venue, market, dataset, variant, bundle, grain and
  month — and the catalog's version of it, which changes whenever a file of it does;
- whether the month has any side at all, read or missing, since sides are stored apart from its
  own rows;
- for each neighbouring month it reads the edge of, that partition, the side, and the catalog's
  version of it — and, for a neighbour that was not there to be read, the fact that it was not.

So **a revision moves when a partition's archives do, or when what is written of them does — and
for no other reason**: a file added, replaced or withdrawn in the catalog, a neighbour arriving, a
column added, a version bumped.

**What is written is said by versions, set by hand** (`src/versions.ts`). Stocking a partition
again is expensive — its archives may have left the disk, and have to be brought back first — so
how a partition is read and built is free to change without one: a series rewritten, a reader
fixed, the build reorganised. Only a change to the output moves a version: columns, types, rows,
their order. It is said at the narrowest level that covers it:

| Level | Where | Moves |
|---|---|---|
| the vault | `EVERY` | every partition |
| a table | `TABLES` | every partition of that canonical table |
| a series | the series' own `version` | the partitions that entry of the map reads, in the months it holds for |

Each is the stocker version the change shipped in, so a value is never used twice. Only what has
changed is listed: a table that is not there and a series without a version are as first written,
and adding either without a version moves nothing.

**A test holds the hand to it.** `tests/output.test.ts` reads every fixture through its series and
compares a digest of the columns, their types and the rows with the one recorded in
`tests/fixtures/output.json` beside the versions it was made under. Output that changed under
versions that did not fails, and names what to bump; `STOCKER_RECORD_OUTPUT=1` records what is
written once a version has moved, and never over a digest whose versions did not.

**An empty partition is still published** — one file under `@` with the table's columns and no
rows — so a month whose every file the venue published empty reads as stocked rather than being
built again every sweep.

### The ledger

**The vault keeps its own account of what it holds**: `ledger.csv` at its root, a line per partition
stocked. That is what makes a partition current without its vault slice being walked — and what
keeps it current when its files are not there, so a partition can be moved out of the vault without
being stocked again.

| Column | |
|---|---|
| `partition` | the vault partition: its vault slice's directory below the vault, then its month as `YYYYMM` |
| `venue`, `market`, `dataset`, `variant`, `grain`, `bundle`, `month` | the partition of the archives it was stocked from, as the catalog names it, its month as `YYYYMM` |
| `mode` | `bundle`, one file under `@` for every instrument, or `split`, a file per instrument |
| `version` | the catalog's version of that partition when it was stocked |
| `preVersion`, `postVersion` | what the month before and the month after held of it: empty where the month has no such side, the catalog's version of that neighbour where its hours were read, `missing` where it was not there to be read |
| `revision` | the revision it was stocked at — or `updating` or `updating-sides`, while its files are being changed, or `outdated`, once they are no longer what would be stocked |
| `size`, `count` | what its files weigh, and how many there are, sides included |
| `stockedAt` | when |

The first line is the heading. Fields are separated by `|`, since the catalog's own names carry
commas; a value holding `|` or a line break is refused, never escaped. **A line is never changed.**
A partition stocked again gets another line, and the last line for a partition is the one that
counts — so the file is only ever appended to. A line is on the disk before anything goes on from
it, and counts only once it is whole: a write cut short leaves a tail that is not read, and the next
line starts on a line of its own.

**A month with a side `missing` is stocked.** It holds every row its own files have, and says
exactly what it lacks. When the neighbour arrives the side is added and the month gets another line.

**A partition whose files are being changed says so first.** Files carry no mark of which build
wrote them, so the ledger is the only thing that can tell a month whole from one caught half way.
Before the first file of a month in the vault or the ledger is touched, a line is written for it
with `updating` where its revision goes — `updating-sides` where only a neighbour's hours are being
added and its own files are left as they are; the line that says what it now holds follows the last
file. A partition whose last line says either is not stocked, to anyone reading.

**A partition that is no longer what would be stocked says so too.** Its archives changed, or
what is written of them did, and the revision it computes is not the one it was stocked at. Its
files are whole and readable, of an older making. A line is written for it with `outdated` where
its revision goes — the line before still says what its files are — and then:

- **Its archives are on disk, with room to extract them**: it is stocked again in the same sweep,
  and gets a line at its new revision.
- **They are not on disk**: it is counted and logged, and stays outdated. Every later sweep tries
  again, so it is stocked the first time its archives are back.
- **What made it outdated is taken back**: the line it had is written again, and it is current.

An outdated partition keeps its files and is read like any other; they are not what its archives
would stock today.

**A partition caught half way is put right before anything reads the vault** — as the service
starts, before each sweep, and straight after a put-in-place that stopped part way. Nothing but
stocker writes the ledger or stocks a partition, and partitions are put in place one at a time, so
a partition still saying `updating` or `updating-sides` then is one nobody is updating:

- **One that was only being given a neighbour's hours goes back to what it was.** Its own files
  were never touched, so the side files being added are removed and the line it had before is
  written again: stocked, and still without them. The two lines bear it out — the same rendering at
  the same version, with a side that was `missing` and no longer is.
- **Any other is no longer stocked.** Some of its files are of the month that was there and some of
  the one arriving, and nothing tells them apart, so all of them are removed and the next sweep
  stocks it from its archives. Its `updating` line stays the last, which is what says so.

**`backedup.csv` says which partitions have a safe copy elsewhere.** It sits beside the ledger.
Stocker reads, of each line after the heading, the first two `|`-separated fields: a partition as
the ledger names it, and the revision that was copied. It never writes the file. Its format is
[COLD-VAULT.md](../tooling/COLD-VAULT.md#backedupcsv).

**The ledger is set against the vault once, as the service starts**, after partitions caught half
way are put right. Every partition the ledger holds must have as many files in the vault as its
line gives, and a `bundle` partition's files must also weigh what it gives — **unless
`backedup.csv` has its revision**. A partition with a safe copy is not looked at: whatever of it is
in the vault, all of its files, some of them or none, nothing is lost. One without a safe copy that
is not there whole is a loss:

- it is appended to `ERROR.log` at the vault's root — `<when>|<partition>|<revision>|<what was
  found>` — once, however often it is found again;
- from then on it is taken as not stocked, so the next sweep stocks it again, and never by writing
  down whatever is in the vault in its place.

The service carries on. A file is written, and not only a log line, so that the loss is still in
front of whoever looks next: nothing removes `ERROR.log` but a person.

### Providers

**The catalog** says what exists and what is ready
([CATALOG-API.md](../modules/CATALOG-API.md#partitions)). A sweep asks it once per venue in scope —
those of `STOCKER_VENUES`, or every venue the series map declares, alphabetically:

```
GET {CATALOG_API}/venues/{venue}/partitions?downloaded=true&settled=true&datasets=<the venue's datasets the series map reads>
```

The request sends `x-catalog-token` when `CATALOG_TOKEN` is set, and `x-catalog-lens` when
`STOCKER_LENS` is set, so the answer holds only the lens's partitions. Of each slice it uses the
market, dataset, variant, grain and bundle, and of each partition its month, `files`, `bytes` and
`version`. A request whose connection fails is tried up to four times, waiting 2 s and doubling;
any HTTP answer is final, and one that is not a success fails that venue for the sweep, which goes
on with the next. A partition the answer gives no files is never stocked from; a vault partition
with nothing else to stock from is counted as waiting.

**The archives** are read where the catalog's keys put them, mounted read-only
([HAULER.md](HAULER.md#the-layout-on-disk)):

```
<archives>/<venue>/<market>/<dataset>[,<variant>]/<F>/<symbol>/<YYYYMM>/<name>
<archives>/<venue>/<market>/<dataset>[,<variant>]/@/<YYYYMM>/<name>
```

A partition of per-instrument files is gathered from the `<YYYYMM>` directory of every instrument
of its dataset; the instruments are listed once per dataset per sweep. Only names that parse as
canonical keys of the partition's grain and month count — `venue|market|dataset[,variant]|symbol|
date[.partNN].ext` — so a download in progress (`.part`), a backup (`.bak`) or anything else in the
directory is not a file of the partition.

## Architecture

| Concern | Where | |
|---|---|---|
| What exists | `src/catalog.ts` | a venue's downloaded, settled partitions, as the catalog answers them |
| What a key says | `src/keys.ts` | venue, market, dataset, variant, bundle, grain, month and container, off a file's name; whether a file is at its month's edge |
| What is on disk | `src/disk.ts` | a partition's files in the archives, and whether they match the catalog |
| The sweep | `src/scan.ts` | the decisions above, in order; a partition's tasks, the connections they share, putting it in place |
| Extracting ahead | `src/prepare.ts` | extraction started before a build asks for it, and the bound on what it holds in scratch |
| Room to extract | `src/room.ts` | whether archives fit on the vault's volume above its floor once extracted |
| How bytes are wrapped | `src/containers/` | `zip`, `tar.gz`, `gzip`, plain: extracted to scratch or read where they lie (`extract.ts`); what they inflate to (`weigh.ts`); the extraction threads (`pool.ts`); small files gathered into one (`pack.ts`) |
| How rows are read | `src/formats/` | `csv`, `xlsx`, `ndjson`, `lines`, `words`: a SQL relation over a list of files |
| What a format means | `src/schema/series.ts` | the series map, one entry per format, and the path levels a variant gives |
| How rows become the table | `src/schema/project.ts` | the projection onto the table's columns: `TRY_CAST`, the timestamp parse, the unit inferred, the zone |
| Which instruments are inverse | `src/schema/margin.ts` | one rule per venue |
| What a table is | `src/schema/tables.ts` | the canonical column lists |
| A neighbour's hours | `src/spill.ts` | which edge of which neighbouring month a spilling series reads, and the clip to the month |
| Building | `src/build.ts` | reading an instrument or a batch, writing its files, a batch as one file, joining a month, a big instrument's pieces, a side's overlap with the month, clearing scratch |
| The engine | `src/db.ts` | one DuckDB instance: its memory and thread caps, its spill directory and the cap on it, extensions |
| Where it lands | `src/vault.ts` | the layout, the revision, staging, what the vault holds, putting a month in place |
| What was stocked | `src/ledger.ts` | the ledger, `backedup.csv`, a partition caught half way or outdated, the ledger against the vault |
| Written to stay | `src/durable.ts` | a file or a line on the disk before anything goes on from it |
| What says the output changed | `src/versions.ts` | the version of what is written, for the vault, a table, a series |

Containers, formats, series and tables are extension points: each is added as a file or an entry,
with the registrations the [service README](../../services/stocker/README.md#extending-it) lists.
Nothing outside `schema/` names a venue.

### One series per format

A series is keyed by what the catalog says a file is — venue, market, dataset, variant — and
never by where the venue keeps it. Where one dataset holds more than one format, an entry says
which files it reads:

- **by margining** (`margin`), asked of each file's own instrument — binance's coin-margined and
  USDⓈ-margined trades share a partition and a fourth column that means opposite things;
- **by era** (`from`/`until`, months) — htx's files take another shape from 2026-02.

More than one entry claiming a file is a mistake in the map and throws; a partition no entry reads
is passed over.

**A venue that repeats whole rows says so** (`repeatsRows`), and exact repeats — every column
equal — are written once. It is declared per format rather than applied everywhere, because a
repeated row is only an artifact where the venue is known to write them; elsewhere two equal rows
could be two real events.

Each file is read by the series that claims it, so one build can union two formats into one
canonical relation.

**How a file is read is a format, and there are five**: `csv`, by header or by declared position;
`xlsx`, a sheet; `ndjson`, a JSON record a line, its fields and their types declared where sampling
them would be wrong (`fields`); `lines`, a line a value, for JSON a line under a header that calls
itself CSV; and `words`, values parted by runs of blanks, for files that have neither a header nor a
delimiter a CSV reader can be trusted with.

**Whether a table is text or a sheet is read off the file, never declared.** `csv` and `xlsx` are one
thing to the map — a table, whose columns and meaning the series states — and each file is read as
what it is: a sheet opens with a zip archive's signature, anything else is text. A venue that writes
a day's klines as a sheet and a month's as text, or changes from one to the other, needs no entry
changed.

**A month of sheets is unioned by name, a file at a time.** `read_csv` takes a list of files, which
keeps a month of CSV to a single reader. `read_xlsx` takes one path: it rejects a list, and given a
glob it reads one match and silently drops the rest. So each sheet is read on its own and the reads
are unioned **by name** — the sheets carry headers, and a union by position would transpose columns
without complaint if a venue reordered them.

**Where a record is not yet a row, the series says how it becomes rows** (`rows`): a book message
holds a list of levels a side, and a row is one level. It is a query over what the format read, run
before the projection.

**A row's time can be the file's name.** Where a venue names a file by the moment it holds and writes
no time inside, the catalog keeps that moment as the file's part, the last thing in its name, and the
series reads `ts` from there.

### Instruments, and files that hold several

Each vault file names its instruments in its `symbol` column. An archive file usually holds one
instrument — the catalog's symbol. Where a file's rows name their own instrument and can hold
several — a market-wide bundle, a futures chain — the series names that column (`instrument`) and
the rows are split by it: the file is read once into a temporary table, then written one instrument
at a time. A row that names no instrument, or names one that cannot be a file name (empty, `.` or
`..`, holding a path separator, or opening with `@`), fails the partition, naming its file.

### Builds share one engine

A partition is built as **tasks**: an instrument whose archives weigh 32 MB or more is a task of its
own, and smaller ones are read together in batches, a batch closing at 64 MB of archives or 256
instruments.

**`STOCKER_CONCURRENCY` connections form one pool, shared by partitions.** A partition whose archives
weigh under 64 MB takes one connection and builds its tasks on it, so as many light partitions are
built side by side as there are connections. A heavier one waits for every connection and builds its
tasks side by side on them. Each partition builds into a staging directory of its own,
`<vault>/.stocker-tmp/stage/<partition>.<revision>/`. Putting a partition in place — joining a small
month into its file, the ledger lines, the removals and the renames — is done for one partition at a
time, whatever else is being built.

**Small instruments are read together.** The fixed cost of a read — opening files, setting up the
reader, a width check of its own — dwarfs the work on a small file: a month of daily candles is a
few dozen rows, and reading it alone costs ~86 ms where its share of a batched read costs ~20 ms.
So a batch is read in one query into a temporary table that carries each row's instrument, and a big
instrument is read on its own, straight into its file. Both write the same file, which a test holds
them to.

**A batch of a small month is written as one file.** A write costs some ten milliseconds whatever
it holds, so a file per instrument of a month of a few megabytes is mostly writes: 460 instruments
of 744 rows each take 4.9 s written apart and 0.6 s more to join, against 0.25 s written once,
ordered by symbol and then by time. Where the month is stored as one file and is its own rows alone,
the batch is that one write, and the times of every instrument in it are checked on the table
beforehand. A month with a neighbour's hours beside it, or one stored per instrument, is written a
file per instrument: there the files are what says which instruments it has.

**Positional files are read with their columns declared and detection off.** Over a list of files a
sniffed read takes the column count from what it sniffs and silently drops a declared column
beyond it — the one that catches a wider file. Declared, every file reads as declared: a short row
is padded, a row one column wider fills the overflow column, and a row wider still fails the read.
A file wider than its series fails the partition, naming the file, before anything is written. Every
positional format is comma-separated, which is all detection would find.

Every connection comes from **one DuckDB instance**, which is the load-bearing part:
`memory_limit` and `threads` are instance-wide, so concurrent builds divide the configured budget
rather than multiplying it. Raising concurrency never raises what the service may take from the
box. The budget is `STOCKER_ENGINE_MEMORY_GB` and `STOCKER_THREADS`; past the first the engine
spills to disk rather than taking more. `preserve_insertion_order` is off for the instance, so a
busy instrument's month spills rather than holding its rows in order. Nothing written depends on
it: every file is written with an `ORDER BY`, or by appending with insertion order turned on for that
one statement (below).

**The engine spills into `<vault>/.stocker-tmp/engine`**, and no further than the vault's volume can
give: its free space less `STOCKER_MIN_FREE_GB`, and never under 1 GB. The cap is set as the engine
opens and again before each sweep, when nothing is spilled, so it follows the volume as the vault
fills. A build that would spill past it fails.

**A month is joined by appending wherever its files are already in order.** Each staged file is in
symbol and time order — one instrument's, or a batch of them — so reading them in symbol order and
writing what is read gives the whole month in symbol and time order while holding almost none of it.
Insertion order is turned on for that one statement on that one connection. A month built as a
single file is that file, renamed. Three steps sort instead:

- joining files whose symbols interleave: a big instrument read on its own out of the middle of a
  batch;
- joining the pieces of a big instrument (below) into its file;
- rewriting a side whose bars the month already holds ([Time](#time)).

Measured on 24 million rows, appending peaks at 0.27 GB where sorting the same rows by time takes
everything it is allowed.

**No partition starts below `STOCKER_MIN_FREE_GB`** of free space on the vault's volume. The sweep
stops there and says so, rather than filling the volume mid-build — and checks before asking about
each venue too, so a full volume costs the catalog nothing.

**Nothing is extracted without room for it.** What archives inflate to is read off them before any
is extracted — a zip states it in its directory; a container that does not state it is counted at
eight times its size — and set against the volume's free space at that moment, less
`STOCKER_MIN_FREE_GB`. It is asked twice: of every task of a partition before the partition is
started, and again by each extraction as it starts. A partition that does not fit is skipped with a
warning saying what it needs and what is free, counted as waiting for room to extract, and stocked by
a later sweep that finds the room. Archives are opened for this only where the answer could be no:
nothing inflates to more than 1032 times its size, so what fits at that ratio fits unopened.

### Containers are unpacked only when they must be

| Ending | Container | Read |
|---|---|---|
| `.zip` | `zip` | extracted; every member, not only the first |
| `.tar.gz` | `tar.gz` | extracted; only file members, each inside the archive's own directory |
| any other `.gz` | `gzip` | by the engine as it lies |
| anything else | plain | by the engine as it lies |

A file compressed any other way (`.bz2`, `.xz`, `.zst`) is not a file stocker opens. The engine reads
gzip and plain files itself, so a `.gz` or a bare file is handed to it untouched — the difference
between copying a 23 GB order-book month to scratch and not — except where small files are gathered
(below).

**A build's archives are extracted together, into one directory removed at once**, each under a tag
of its own so that two holding a member of the same name do not meet. A zip up to 32 MB whose
members state 64 MB or less between them is read whole and inflated in memory, its members checked
against the size and CRC its directory states; a larger one, or one in a form that read does not
cover, is streamed. Most archives are a few hundred bytes and a month holds tens of thousands, so
what costs is the handling per archive and not the bytes: read whole, an archive already in the page
cache is extracted about ten times faster than streamed. One that has never been read costs a disk
read either way, and that read is then most of the time.

**A big instrument whose archives inflate to more than 8 GB is built a piece at a time.** Its files
are taken a few at a time — as many as inflate to 8 GB, or one that outweighs that alone — and each
piece is extracted, written and removed before scratch is asked to hold the next. The pieces are
then joined, sorted, into the files the instrument would have been built as whole, so what reaches
the vault is the same either way. A month of one market-wide file a day, each inflating to tens of
gigabytes, is built this way and never held extracted at once.

**A piece that is built is not built again.** Such a partition takes hours, so each piece leaves a
note beside its files as it finishes, naming the files it was built from, written only once those
files are on the disk. Clearing scratch — as the service starts, and when a build fails — keeps the
pieces that carry a note and removes everything else; the next build of the partition skips those
pieces, builds the rest and joins them all. The staging directory is named for the partition's
revision, so pieces built from other archives or under other versions are never taken up, and are
removed when the partition is next built. A piece stopped half way has no note and is built again.

### Extraction runs ahead of the builds, on threads of its own

A month of small files is nearly all extraction: the engine has a few megabytes of rows to read and
tens of thousands of archives to wait for. So extraction does not wait to be asked. Two threads
extract and do nothing else, and what they work on is chosen ahead of the builds:

- the tasks of the partitions being built that no connection has reached yet, the earliest
  partition first; and then
- the tasks of the partitions after them, which the sweep decides while those are being stocked:
  up to sixteen partitions, or as many as weigh 2 GB of archives together.

A build that reaches a task finds its archives extracted, or waits only for what is left of them. A
task read where it lies passes straight through, so none of this is decided by venue or by format:
it is read off the files of each task.

**Small files of one shape are gathered into one as they are extracted.** Reading a file costs the
engine a fixed amount before it has read a byte, and a month of daily candles pays that tens of
thousands of times. So the lines of small files are written one after another into a single file,
each opening with the number of the archive it came from, and the engine reads that file once. Zip
members up to 64 KB are gathered, and so are gzip files up to 32 KB on disk, inflated in memory, and
plain files up to 64 KB. It is done only where a line is a row — a file holding a quoted cell, a
sheet, line ends of another kind, or a header unlike the first one's is left as a file — only for
series that read a `csv` or `xlsx` table with no `rows`, `fields` or `instrument` of their own, and
only for batches of small instruments: one
big instrument is read as its files are, where many files read faster than one. A gathered read that
fails is given up and the batch read again from its files as they are.

**What is extracted ahead is bounded by the disk.** No more than a fifth of the vault volume's free
space, and never more than 2 GB, is held in scratch for archives nothing has read yet, counted in
what the extractions wrote — and at eight times the compressed size for one still running. Past that
nothing more is started until a build removes what it has read. A task a build is waiting on is
never held back: the bound is on getting ahead, not on working. What was extracted for a build that
never came — the sweep stopped, the partition failed — is removed.

**Everything transient lives in `<vault>/.stocker-tmp`, never the system temp directory**: these
archives run to hundreds of MB, and in a container `os.tmpdir()` is the overlay filesystem, where
filling up presents as a corrupt build rather than the full disk it is.

| Under `<vault>/.stocker-tmp` | Holds |
|---|---|
| `unpack-…/` | a build's extracted archives and gathered files, removed once the build has read them |
| `stage/<partition>.<revision>/` | a partition being built: its own rows and each side apart, and the pieces of a big instrument |
| `engine/` | the engine's spill |

It is cleared as the service starts, before the engine opens: everything goes but the pieces of a
partition already built, which the next build takes up.

### Files a venue published empty

A venue publishes archives for days it had nothing to report: a gzip that inflates to nothing, or a
file of no bytes at all.

Left in the file set they break a header-mapped series two ways: alone, the reader finds no
header and invents a single `column0`, so every projected column fails to bind; mixed into a
month, the sniffer takes that invented schema as the file set's and rejects the real files
against it. So empty inputs are dropped before the reader sees them, and an instrument with
nothing but empty inputs **has no file** — the venue published nothing for it.

Emptiness is decided by **decoding**, not by reading the gzip trailer. A gzip records its
uncompressed size in its last four bytes, and for a concatenated gzip that describes only the
final member — so data followed by an empty member would read as empty and a whole month would
vanish. A zero-length file is empty whatever its extension claims, and is checked first, since it
is not a valid gzip at all. A file that *has* bytes and will not inflate is the opposite case —
something is there and cannot be read — and still fails the build.

### Files a venue published malformed

A CSV whose rows are **narrower than its own header** has no delimiter that gives every line the
same field count, so the sniffer rejects each candidate in turn and falls back to reading whole
lines — one column, named for the entire header. Every projected column then fails to bind, on a
file where the column is plainly visible. KuCoin's futures `1d` klines are such a file: a header of
six columns over rows of five. DuckDB's error then names the column as not found and offers, as the
candidate, the single giant column whose *name* contains it.

So a failed build of a header-mapped series is diagnosed before it is reported: its inputs are
sniffed, and any that parse to a single column are named as malformed. One column is the whole
signal and it needs no knowledge of the delimiter — every series maps a timestamp and at least one
value, so a usable file never parses as one column.

**It runs only after a build has already failed**, which is the difference from the width check.
A file *wider* than a positional series reads successfully and means something other than what the
map says, so it is caught before anything is written. A file that will not parse produces no data
rather than wrong data, so the build stops on its own and this exists only to say why in terms of
the file. A build that succeeds never pays for it.

## Canonical tables

Every series projects into the table's column list, in the table's order, with NULL where a venue
publishes nothing. The writer puts `symbol` first and, where the table carries it, `margin` last.
That is what makes a table one dataset rather than a pile of venue-shaped files: a reader gets
identical columns whether the rows came from one venue or another, and Parquet gets one stable
schema to append to.

| Table | Levels below `dataset=` | Columns |
|---|---|---|
| `trades` | `aggregated=` | `symbol, ts, tradeId, price, size, baseSize, quoteSize, side, buyerMaker, margin` |
| `klines` | `interval=` | `symbol, ts, open, high, low, close, volume, quoteVolume, trades, takerBuyVolume, takerBuyQuote, margin` |
| `quotes` | — | `symbol, ts, bidPrice, bidSize, askPrice, askSize, margin` |
| `orderBook` | `kind=incremental/depth=` | `symbol, ts, action, side, price, size, orderCount, sequence, margin` |
| `orderBookSnapshot` | `kind=snapshot/depth=` | `symbol, ts, asks, bids, sequence, margin` |
| `orderBookBands` | `kind=bands/depth=` | `symbol, ts, percentage, depth, notional, margin` |
| `markPrice` | `interval=`, none for ticks | `symbol, ts, price, open, high, low, close` |
| `indexPrice` | `interval=`, none for ticks | `symbol, ts, price, open, high, low, close` |
| `premiumIndex` | `interval=` | `symbol, ts, open, high, low, close` |
| `volatilityIndex` | — | `symbol, ts, value` |
| `optionMarkPrice` | `interval=` | `symbol, ts, option, open, high, low, close, delta, gamma, vega, theta` |
| `optionTicker` | `interval=`, none for ticks | `symbol, ts, option, open, high, low, close, volume, quoteVolume, bidPrice, bidSize, bidIv, askPrice, askSize, askIv, markPrice, markIv, delta, gamma, vega, theta, openInterest, openInterestValue` |
| `funding` | `kind=` | `symbol, ts, rate, intervalHours` |
| `borrowing` | — | `symbol, ts, currency, rate` |
| `openInterest` | — | `symbol, ts, openInterest, openInterestValue, longShortRatio, takerLongShortVol, margin` |
| `liquidations` | — | `symbol, ts, side, price, size, averagePrice, status, margin` |

The three book tables are stocked under `dataset=orderBook`. The types are in `src/schema/tables.ts`:
`ts` is a `BIGINT` ([Time](#time)), a book's sides in `orderBookSnapshot` are `DOUBLE[][]`, counts
and sequences are `BIGINT`, `tradeId` and every name or label are `VARCHAR`, `buyerMaker` is
`BOOLEAN`, and every other number is `DOUBLE`.

**Values convert with `TRY_CAST`, so a cell that will not parse becomes NULL rather than failing the
month.** A venue's own tooling leaks into its archives: OKX candlesticks carry the literal string
`None` — Python's, serialised — in `vol_ccy`/`vol_quote` for the eras it did not populate them, on
every row of the file. Under a strict cast that is a partition that can never build. NULL is also the
honest reading: the venue published no number, which is what NULL already means here. Sentinels are
never enumerated — `None`, an empty string and a stray header all fail the same cast.

The cost is that a wrongly *mapped* column yields NULLs instead of an error. `mapping.test.ts`
covers that: it reads fixtures cut from real archive files through their series and asserts the
projected values, catching a bad mapping where it can be read and fixed.

Notes on the ones whose boundaries are not obvious:

- **`klines` bins a traded tape.** `markPrice`, `indexPrice` and `premiumIndex` are real OHLC
  bins too, but of a *reference series* — a virtual price with no market behind it. A venue can
  publish them in the same file shape as its klines; they are different data, and a different table.
- `quotes` is level 1 of a book only.
- **A book is one of three kinds of data, and each has its table.** The kind and the depth are the
  catalog's variant, and levels of the path, the kind first: `kind=incremental/depth=400`,
  `kind=snapshot/depth=20`, `kind=bands/depth=5pct`.
  - **`orderBook`** — a book published as an image and the changes since. An event log, one row a
    level. `action` says what the row does to the book: `snapshot`, a level of a whole image, the
    rows sharing its time being the book; `set`, the level is now this size, and gone at size 0;
    `make` and `take`, this much was added to the level or taken from it. `side` is `bid` or `ask`.
  - **`orderBookSnapshot`** — a book published whole at each tick. One row a message, each side a
    list of `[price, size]` in the venue's own order. A tick stands alone and says nothing of what
    happened before the next, so there are no changes to log; kept whole it is what was published,
    at about the size it was published at.
  - **`orderBookBands`** — a book summed into bands either side of the mid: a row a band, the size
    (`depth`) and the `notional` resting within that many percent of the mid. Its depth level is the
    widest band. It is a summary of a book and holds none of its levels.

  None is a reconstructed book: rebuilding one at an instant is the consumer's job, since the
  depth it needs is its decision.
- **An option has three tables of its own.** `optionTicker` is an option's state at a moment or over
  a bar — what traded (OHLC and volumes, of trades), the quote, the mark, the implied volatility
  behind each, the greeks, the open interest. `optionMarkPrice` is its mark price as bars with the
  greeks beside them. `volatilityIndex` is an index of implied volatility, a level and not a price.
  In `optionTicker` and `optionMarkPrice` the instrument is the **underlying** and `option` names the
  contract: a venue lists thousands of contracts a month, each living days, and every venue's own
  files are an underlying's or a whole market's.
- **`funding` carries a `kind`** of `realised` or `predicted`, as a level of its path: what was
  charged and the running estimate of the next interval are different series.
- **Trades say whether they are aggregated**, as a level of their path: `aggregated=false` for
  every trade as it happened, `aggregated=true` for a venue's aggregation of them. The two are not
  the same data — the second can be made from the first and never the other way, as a 1h kline can
  from 1m ones — so they are two vault slices of one table, each stocked where it is downloaded, and
  neither stands in for the other. Trades the catalog gives no variant are every trade, at every
  venue. An aggregated row is the trades one order filled at one price: its id is the aggregate's,
  and the ids of the first and last trade it stands for are not kept. `side` is the taker's, `buy`
  or `sell`.
- **`borrowing` is keyed by currency**: its `symbol` is the currency borrowed.

**`margin` says what a contract settles in** — `linear` (its USD-like quote) or `inverse` (the
coin) — and is NULL outside perpetuals and futures. It is carried by every table whose numbers mean
something different on the two: `trades`, `klines`, `quotes`, `orderBook`, `orderBookSnapshot`,
`orderBookBands`, `openInterest` and `liquidations`. A coin-margined trade's size is a contract count
and its other leg is the coin; a linear one's is base and quote. It is a constant per instrument,
filled as each instrument's rows are written, from one rule per venue over the venue's own symbol
(`schema/margin.ts`); a symbol no rule calls inverse is linear. A file holding a whole month carries
each instrument's own value.

## Time

One canonical unit: **int64 microseconds since epoch, UTC**, in a column named `ts`. An instrument's
rows are in `ts` order — `ts, sequence` for `orderBook` and `orderBookSnapshot`, which carry the
venue's sequence, since several changes can share a stamp and their order is the book — and a file
holding a whole month is ordered by `symbol` first.

**The unit is read from the value.** Over 2015–2035 the plausible ranges sit three orders of
magnitude apart — seconds near 1.4e9, millis 1.4e12, micros 1.4e15, nanos 1.4e18 — so which one a
value belongs to follows from the value itself, with the thresholds falling in empty space between
them. Text forms are handled too: ISO, moved to UTC by the offset it carries, and the dotted
`2024.11.01 00:00` of Bybit's MT4 klines.

Declaring the unit per series cannot be the default, because a venue changes precision inside a
dataset a consumer reads as one series, and any fixed declaration is then wrong for one side of the
change ([Binance's spot trades](../venues/BINANCE.md#spot-timestamps-change-unit-in-2025-01)). The
unit is inferred per value, which costs one `CASE` per row and removes a whole class of silent 1000×
error.

**Generic by default, specific where it is justified.** Inference assumes the Unix epoch and a
value in one of those four units. A format that breaks either — another epoch, a unit the ranges
cannot separate — or one where detection costs more than a stated rule is better served by the
series saying so. That is a trade between generality, readability, complexity and speed, decided
per case. The one such statement is a **zone**: a venue writing local datetimes declares
`utcOffsetHours`, which applies only to text that carries no offset of its own — bybit's MT4 klines
are UTC+3.

The parse is computed **once per row**, in inner projections the CASE then reads, with a
`BIGINT` fast path ahead of everything else — most files publish integral epochs. Inlining the
parse into every CASE branch instead evaluates it five times per row.

The fast path takes only **integral text** — DuckDB's VARCHAR→BIGINT cast *rounds* fractional
text rather than failing, so ungated it would silently strip the sub-second part of
`1784937600.0683`. **A fractional epoch is split at its dot into two integers** — the whole part
and nine fractional digits — and combined at the unit the whole part names, rounded half-up to the
microsecond. Never `DOUBLE`: an epoch in microseconds is a 16-digit integer, at the edge of exact
DOUBLE range, where a multiply would silently round the last digit. Never `DECIMAL(38,9)` either:
exact, but 5.5 s against 0.23 s for the split on a day of bybit perpetual trades, with identical
results.

Anything that resolves to nothing lands as NULL and **the row is dropped**. That is what carries
a dataset across a format change: a file that grows a header partway through its history, read
positionally, has a header line that is simply a row whose timestamp is text like `open_time`. No
boundary date is written down anywhere.

**Every file is written in that order, and the sort stays** where inputs arrive ordered: removing it
saves about 9% of build time. It sets the memory ceiling, which the engine's spill covers.

**A file whose timestamps fall outside 2015–2035 is rejected rather than published.** Inference
removes the wrong-unit mistake, but not the one this catches: a `ts` naming the wrong column, where
values parse cleanly and mean nothing.

### Venues whose periods do not cut at UTC midnight

Not every venue's day is a UTC day. Bitget, htx and okx (all but okx's books) cut at **16:00 UTC** —
midnight UTC+8 — so the file named `20250101` opens at 2024-12-31 16:00 UTC and its head belongs to
December. Bybit's MT4 files are UTC+3 months, so each opens with the previous UTC month's last three
hours. Which series spill is in [STOCKER-PARTITIONS.md](STOCKER-PARTITIONS.md).

Nothing about the *rows* is wrong once their zone is applied; only which file holds a row is
shifted. Left alone, that would make a month a shifted window — hours of the previous month
present, the last hours of its own month missing — which is invisible to anyone filtering on `ts`
and wrong for anyone reading a partition as a calendar month.

This is declared, never coded per venue. A series states where its periods can spill:

| `spill` | meaning | to complete month M, also read |
|---|---|---|
| _(unset)_ | periods match UTC cuts | — |
| `back` | a period holds rows from before its label | the next month's **first** period |
| `forward` | a period holds rows from after its label | the previous month's **last** period |
| `both` | either way | both |

Five things follow, and all are mechanical:

- **The neighbour's edge is read too.** Each instrument's files in the neighbouring month's edge
  period are read — every part of them, since a split day's tail is spread across them. For a
  monthly grain the edge is the neighbour's whole file.
- **Every build clips to the month.** The month's own files are clipped, so the hours they hold of
  another month are left out; the neighbour's edge is clipped the same way, so only this month's
  hours are taken from it. Clipping applies **only** to spilling series: elsewhere it could only
  ever delete, since a stray out-of-period row has no neighbour supplying it.
- **What the neighbour holds is stored apart.** The hours from the month before are
  `<YYYYMM>.pre.parquet` and those from the month after `<YYYYMM>.post.parquet`, beside the month's
  own file — under `@`, or under each symbol the month itself has a file for. A side holds only
  instruments the month's own files name. A month is therefore the same files whether its neighbour
  was there when it was stocked or came later, and a neighbour arriving adds a small file where it
  would otherwise rewrite a large one.
- **A bar is kept once.** A month's file can carry the first bar of the next month, which the next
  month's file carries too. For klines, each instrument's side holds only the times its own rows do
  not reach — after its last bar for `post`, before its first for `pre` — read off the month's own
  files as they are in the vault, or as they were just built. The month's own files are never
  rewritten for it.
- **The partition does not wait for its neighbour.** Where the neighbouring month is not in the
  catalog's answer, or is there with no files, the month is stocked without that side and its
  ledger line says `missing`. When the neighbour is there, the side is built from the neighbour's
  edge files alone and the month's own archives are not needed. The neighbour's version is part of
  the revision, so a neighbour that changes afterwards restocks the month.

The trait assumes the offset is smaller than one period, so one neighbour in each direction is
enough.

## Coverage

Every format, venue by venue — what each file holds and how it maps — is in
[STOCKER-PARTITIONS.md](STOCKER-PARTITIONS.md). An entry is written from a decoded file of its
dataset, with the semantics a file cannot state settled by arithmetic over real rows; one written
without a decoded file is marked there as unverified.

The map is exercised against fixtures cut from real archive files (`tests/mapping.test.ts`), so a
renamed column, a swapped pair or a misread unit fails a test rather than producing
plausible-looking data, and `tests/output.test.ts` holds what is written to the versions
([The revision](#the-revision)).

## Running it

Long-lived rather than a batch job, so files that land unattended are picked up on their own.
That makes **"caught up" a signal worth acting on**: everything in scope that is downloaded is
stocked.

So every sweep ends by saying what it means, rather than leaving it to be inferred from an
absence of work:

| Outcome, the first that applies | Reported as |
|---|---|
| stopped at the volume's floor (`STOCKER_MIN_FREE_GB`) | a warning, `Stopped for want of space — rescanning in M minutes` |
| anything failed | a warning, `N partitions failed — rescanning in M minutes` |
| a partition skipped for want of room to extract | a warning, `N partitions waiting for room to extract — rescanning in M minutes` |
| stocked something | `Stocked N partitions — rescanning in M minutes` |
| nothing stocked, some without a neighbour's hours or not on disk | `Caught up — N partitions without a neighbouring month's hours, K not on disk as catalogued; rescanning in M minutes`, with `(J of them stocked and outdated)` after K where any are |
| nothing to do at all | `Caught up — every partition in scope is stocked; rescanning in M minutes` |

A sweep runs every 5 minutes, which is a constant and not a setting: one with nothing to stock costs
a request to the catalog per venue and a read of the ledger. Sweeps cannot overlap; a tick landing
mid-sweep is skipped.

`STOCKER_LENS` and `STOCKER_VENUES` scope a sweep; venues are swept alphabetically. Neither is a
commitment — nothing about them is recorded, so widening one makes more partitions eligible
without restocking what is already done. Everything else in scope is stocked: every table, every
instrument, every closed month. `STOCKER_VENUES` is matched case-insensitively against the venues
the series map declares, and an unknown venue **fails startup**: the vocabulary is closed, so a typo
would otherwise be an endlessly clean run of nothing.

Configuration and the storage contract are in the
[service README](../../services/stocker/README.md).
