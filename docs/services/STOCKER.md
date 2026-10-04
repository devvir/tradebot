# Stocker

Stocker owns the vault and is its only writer. The vault is the output of the whole collection
system: every venue and every source, normalised into one format per dataset, so a consumer never
has to care which venue or source a row came from, or what shape it arrived in. It all looks the
same, predictable and simple.

**Stocker is not an archives service.** Collection has three standard sources — archives, REST
and WS — and only archives is under development today. REST and WS files are raw too: their
format is ours, but they may be saved exactly as they arrive, so nothing about them is assumed
normalised. To stocker they are more formats, transformed the same way as an archive's. Further
sources may join — a third-party provider, say, distributing Parquet or another digested format
rather than raw files — and the job is the same: stocker turns all of it into the one format of
its dataset, or of a variant where the variant changes the shape, as whether a book is snapshots
or deltas does.

Sources are availability choices about *how* something was obtained, not different kinds of
data — a trade is a trade. That is why one service handles all of them. **Raw is never modified,
moved or deleted.**

## Scope

**Does:**

- Decode every container and format the sources use
- Map each format onto a **canonical table** with one schema across all venues
- Impose one path convention, one timestamp unit, one identity per instrument
- Write Parquet partitioned so a query engine can prune
- Restock a partition whenever anything it was built from changes

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
<vault>/venue=…/market=…/dataset=…[/interval=…][/kind=…]/@/<YYYYMM>.<revision>.parquet
<vault>/venue=…/market=…/dataset=…[/interval=…][/kind=…]/<symbol>/<YYYYMM>.<revision>.parquet
```

**A month is stored one of two ways, decided by its size.** A small one is a single file holding
every instrument, under `@`. One whose archive files weigh more than `STOCKER_SPLIT_GB` is a file
per instrument, each under its symbol. Venue first makes a venue one folder, and a dataset one
subtree of it.

**Why two.** The number of files is what makes a tree slow to count, move or delete, and most
months are small: a file per instrument would be thousands of tiny files each. But the largest
months weigh hundreds of gigabytes, and fetching one of those whole from cold storage to read one
instrument is most of a day. So small months stay one file, and large ones are cut where it is
useful to cut them. The size is the archive files' as the catalog counts them, which is close
enough to the stocked size to decide by. Measured against the catalog on 2026-10-04, a threshold
of 1 GB stores 13,209 of 15,084 months whole and 1,875 per instrument, about 1.5 million files in
all, and the most one instrument's whole history in a slice drags along in whole months is 41 GB.

**The symbol is a column of every file**, in both forms, so the two read as one table and a
slice whose months are stored both ways needs no special handling: one instrument's history is
its own folder and `@`, filtered by symbol. **A whole month is ordered by symbol, then time** —
one instrument's rows together, which is how it is read. Measured on a month of gate's spot
trades (852 instruments, 24 million rows), one file in that order answered a single instrument's
month in 196 ms against 186 ms for a file per instrument, and was 5% larger.

**`@`, the symbol folders and the file names are bare**, not `key=value`. They are devices for
handling the files rather than facts about the data, so a query engine ignores them and nothing
can filter on them.

**`dataset=` rather than `table=`**, because `table` is a SQL reserved word — a column named that
must be quoted in every query mentioning it.

**Hive `key=value` directories.** The venue, market, dataset and variant are not stored in the
files — `parquet_schema` on a file shows only the data columns — yet queries return them as columns
read from the directory names, and filtering prunes files without the caller building a path.
Storing them as real columns would cost about 0.8 % (measured on a 200k-row sample: Parquet
dictionary-encodes a constant column to one entry and zstd flattens the rest), so this buys
ergonomics rather than space. **A filter on a plain column does not prune files** — only path keys
do.

**The symbol is the one key that lives in the file.** A month stored whole has no folder to say
it, and a query engine refuses a tree where some files carry a key in their path and others do
not — so the symbol is a column everywhere and its folder is bare. Reading one instrument is
naming the two folders it can be in, `@` and its own:

```sql
SELECT * FROM read_parquet([
  '<vault>/venue=okx/market=perp/dataset=trades/@/*.parquet',
  '<vault>/venue=okx/market=perp/dataset=trades/BTC-USDT/*.parquet'
], hive_partitioning=true)
WHERE symbol = 'BTC-USDT'
```

**`market=` is the catalog's market** — `spot` · `perp` · `future` · `option` · `tradfi` — and
carries contract shape only. Margining is not part of it: linear and inverse perpetuals are both
`perp`, and which one an instrument is travels as the `margin` column (see
[Canonical tables](#canonical-tables)).

**Interval and kind are levels below `dataset=`**, taken from the catalog's variant. `klines`,
`markPrice`, `indexPrice` and `premiumIndex` carry `interval=` wherever the variant is a bar length
— a tick stream (`ticks`) has none; `funding` always carries `kind=`. Which levels a dataset
carries is a property of the table, never of the venue: path depth that varied by venue inside one
table would make every query and writer branch on which venue it was looking at.

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

A sweep asks the catalog what every partition holds, and stocks what the vault does not hold at
its current revision. Nothing is remembered between sweeps; nothing is written but the vault.

1. **Ask for what can be acted on.** One request per venue, through the configured lens, for the
   datasets stocker reads: the partitions with nothing left to download that the catalog has not
   seen change for `STOCKER_COOL_HOURS`. A partition a run is still adding to can be complete on
   disk at every moment and still be a fraction of itself, and nothing but time says which — so
   one that changed recently is simply not in the answer, and comes up in a later sweep. Each one
   comes with how many files it has, their total size, and the catalog's version of it.
2. **With its neighbour?** A partition that reads the edge of a neighbouring month needs that
   month in the answer too (see [buckets](#venues-whose-buckets-do-not-cut-at-utc-midnight)).
3. **Current?** The partition's revision — below — is computed from what the catalog answered. If
   the vault holds that revision whole, the partition is current and nothing is read.
4. **On disk?** The partition's files are gathered from the archives and compared with what the
   catalog says, by count and by total size — no file is opened. Where several renderings are
   ready, the preferred one that is on disk is taken (see below); one the catalog calls
   downloaded but the disk does not hold is skipped and reported.
5. **Stock** into a staging directory under `<vault>/.stocker-tmp`, one file per instrument.
6. **Publish**, and remove every other revision of the month. A small month's instrument files
   are appended into one, in symbol order, and that file is renamed into `@` — one rename, so a
   reader sees it whole or not at all. A large month's files are renamed one by one under their
   symbols, between a marker written into `@` before the first and removed after the last; a
   revision whose marker is still there was interrupted and does not count as stocked.

**Nothing is checked again after a build.** A partition that changed while it was being stocked
has a new version in the catalog, so the next sweep computes a revision the vault does not hold
and stocks it again.

**What the vault holds is read once per slice per sweep.** A slice stored per instrument is a
folder per symbol, so asking it about one month means listing every one of them; reading the
slice once answers every month of it.

**Several renderings of one month land in one partition of the vault.** A venue can publish the
same data monthly and daily, or per instrument and in one market-wide file, and the catalog
holds each as a partition of its own. They stock into the same vault partition, and whichever of
them the vault already holds is current. Otherwise one is chosen: per-instrument files before a
market bundle, then the coarsest grain — the fewest files for the same rows.

**The running month is never stocked**, whatever the bounds say: its files are still arriving.

### The revision

A stocked partition's revision is the first twelve hex digits of a SHA-256 over:

- a number for the build itself, bumped by hand when what it writes changes for every partition;
- the canonical table's column list;
- every series that can read the dataset;
- the catalog's version of the partition, which changes whenever a file of it does;
- the catalog's version of any neighbouring month it reads the edge of;
- the symbol filter, so a partly stocked partition never passes for a whole one.

So **anything that would change the output changes the revision**: a file added, replaced or
withdrawn in the catalog, a series edited, a column added. Nothing else needs to be known about a
partition, and nothing else is kept.

**An empty partition is still published** — one file under `@` with the table's columns and no
rows, whatever the month weighed — so a month whose every file the venue published empty reads as
stocked rather than being rebuilt every sweep.

## Architecture

| Concern | Where | |
|---|---|---|
| What exists | `src/catalog.ts` | the catalog's partitions of a venue |
| What a key says | `src/keys.ts` | venue, market, dataset, variant, bundle, grain, month, off a name |
| What is on disk | `src/disk.ts` | a partition's files in the archives, and whether they match |
| How bytes are wrapped | `src/containers/` | `native` or `unpack()` to a scratch dir |
| How rows are read | `src/formats/` | `relation()` returns a SQL expression |
| What a format means | `src/schema/series.ts` | declarative, one entry per format |
| Which instruments are inverse | `src/schema/margin.ts` | one rule per venue |
| What a table is | `src/schema/tables.ts` | declarative, the canonical column list |
| Where it lands | `src/vault.ts` | the layout, the revision, what the vault holds, publishing |
| The sweep | `src/scan.ts` | the decisions above, in order |

Containers, formats, series and tables are extension points: a file or an entry you add rather
than a switch you edit. Nothing outside `schema/` names a venue.

### One series per format

A series is keyed by what the catalog says a file is — venue, market, dataset, variant — and
never by where the venue keeps it. Where one dataset holds more than one format, an entry says
which files it reads:

- **by margining** (`margin`), asked of each file's own instrument — binance's coin-margined and
  USDⓈ-margined trades share a partition and a fourth column that means opposite things;
- **by era** (`from`/`until`, months) — htx's export changed shape on 2026-02-01.

More than one entry claiming a file is a mistake in the map and throws; none claiming it means
stocker does not read that dataset, and it is never listed.

**A venue that repeats whole rows says so** (`repeatsRows`), and exact repeats — every column
equal — are written once. It is declared per format rather than applied everywhere, because a
repeated row is only an artifact where the venue is known to write them; elsewhere two equal rows
could be two real events. okx's candlesticks are the case.

Each file is read by the series that claims it, so one build can union two formats into one
canonical relation.

### Instruments, and files that hold several

The vault holds one file per instrument. A file usually holds one instrument — the catalog's
symbol. Where a file's rows name their own instrument and can hold several — a market-wide bundle,
a futures chain — the series names that column (`instrument`) and the rows are split by it: the
file is read once into a temporary table, then written one instrument at a time.

### Builds run concurrently under one memory budget

A partition's instruments are built `STOCKER_CONCURRENCY` at a time, one DuckDB connection each.
Partitions go one after another, so a partition's staging directory is whole before the next
starts.

**Small instruments are read together.** The fixed cost of a read — opening files, setting up the
reader, a width check of its own — dwarfs the work on a small file: a month of daily candles is a
few dozen rows, and reading it alone cost ~86 ms where its share of a batched read costs ~20 ms
(gate's `1d` klines, 2026-10-04). So an instrument under 32 MB of input joins a batch, read in one
query into a temporary table that carries each row's instrument, and only the write is per
instrument; a batch closes at 64 MB or 256 instruments. A bigger instrument is read on its own,
straight into its file. Both write the same file, which a test holds them to.

**Positional files are read with their columns declared and detection off.** Over a list of files a
sniffed read takes the column count from what it sniffs and silently drops a declared column
beyond it — the one that catches a wider file. Declared, every file reads as declared: a short row
is padded, a row one column wider fills the overflow column, and a row wider still fails the read,
naming the file. Every positional format is comma-separated, which is all detection was finding.

Every connection comes from **one DuckDB instance**, which is the load-bearing part:
`memory_limit` and `threads` are instance-wide, so concurrent builds divide the configured budget
rather than multiplying it. Raising concurrency never raises what the service may take from the
box. The budget is `STOCKER_MEMORY_GB` and `STOCKER_THREADS`; past the first the engine spills to
disk rather than taking more.

**A month is joined by appending, never by sorting.** Each instrument's file is already in time
order, so reading them in symbol order and writing what is read gives the whole month in symbol
and time order while holding almost none of it. Measured on 24 million rows, appending peaked at
0.27 GB where sorting the same rows by time took everything it was allowed.

**No partition starts below `STOCKER_MIN_FREE_GB`** of free space on the vault's volume. The sweep
stops there and says so, rather than filling the volume mid-build — and checks before asking about
each venue too, so a full volume costs the catalog nothing.

Venue and table filters are matched case-insensitively against what the series map declares, and
an unknown token **fails startup** — those vocabularies are closed, so a token outside them can
never match, and accepting one would turn a typo into an eternally clean run of nothing. Symbols
stay substring tokens: theirs is an open set.

### Containers are unpacked only when they must be

DuckDB reads gzip natively, so `.csv.gz` is handed over untouched — which covers Bybit and Gate
entirely, and is the difference between copying a 23 GB order-book month to scratch and not.
Only `.zip` and `.tar.gz` are extracted.

Extraction lands in `<vault>/.stocker-tmp`, **never the system temp directory**: these archives
run to hundreds of MB, and in a container `os.tmpdir()` is the overlay filesystem, where filling
up presents as a corrupt build rather than the full disk it is. Everything transient — the
extraction, the staging partition, the engine's spill — lives in that one directory, so clearing it
after a hard kill is a single delete rather than a walk over the vault.

### Files a venue published empty

A venue publishes archives for days it had nothing to report. Bybit wrote one for every symbol
that delisted on 2022-12-12 — a valid 42-byte gzip whose payload is nothing — and Gate leaves a
file of no bytes at all for a symbol that listed and never traded.

Left in the file set they break a header-mapped series two ways: alone, the reader finds no
header and invents a single `column0`, so every projected column fails to bind; mixed into a
month, the sniffer takes that invented schema as the file set's and rejects the real files
against it. So empty inputs are dropped before the reader sees them, and an instrument with
nothing but empty inputs **has no file** — the venue published nothing for it.

Emptiness is decided by **decoding**, not by reading the gzip trailer. A gzip records its
uncompressed size in its last four bytes, and for a concatenated gzip that describes only the
final member — so data followed by an empty member would read as empty and a whole month would
vanish. A zero-length file is empty whatever its extension claims, and is checked first, since
Gate's are not valid gzips at all. A file that *has* bytes and will not inflate is the opposite
case — something is there and cannot be read — and still fails the build.

### Files a venue published malformed

The neighbouring failure, and it fails the same way for a different reason. A CSV whose rows are
**narrower than its own header** has no delimiter that gives every line the same field count, so
the sniffer rejects each candidate in turn and falls back to reading whole lines — one column,
named for the entire header. Every projected column then fails to bind, on a file where the
column is plainly visible.

KuCoin's futures `1d` klines are the case: `time,open,high,low,close,volume` declared and five
fields written, on every row of every file of every symbol, confirmed byte-identical to what
KuCoin serves. The error was `Referenced column "time" not found in FROM clause! Candidate
bindings: "time", …` — DuckDB suggesting, as the correction, the single giant column whose *name*
contains the one being looked for.

So a failed build is diagnosed before it is reported: the inputs are sniffed, and any that parse
to a single column are named as malformed. One column is the whole signal and it needs no
knowledge of the delimiter — every series maps a timestamp and at least one value, so a usable
file never parses as one column.

**It runs only after a build has already failed**, which is the difference from the width check.
A file *wider* than a positional series reads successfully and means something other than what the
map says, so it is caught before anything is written. A file that will not parse produces no data
rather than wrong data, so the build stops on its own and this exists only to say why in terms of
the file. The happy path never pays for it.

Formats differ in how many files one relation may span. `read_csv` takes the whole list, which
is what keeps a month of CSV to a single reader. `read_xlsx` takes one path: it rejects a list,
and given a **glob it reads one match and silently drops the rest** — two sheets of 4,663 and
8,893 rows glob to 8,893. So a month of spreadsheets is unioned **by name**, path by path. By
name rather than by position because the sheets carry headers, and a positional union would
transpose columns without complaint if a venue ever reordered them.

## Canonical tables

Every series projects into the table's full column list, in the table's order, with NULL where
a venue publishes nothing. That is what makes a table one dataset rather than a pile of
venue-shaped files: a reader gets identical columns whether the rows came from Binance or Gate,
and Parquet gets one stable schema to append to.

**Values convert with `TRY_CAST`, so a cell that will not parse becomes NULL rather than killing
the month.** A venue's own tooling leaks into its archives: OKX candlesticks carry the literal
string `None` — Python's, serialised — in `vol_ccy`/`vol_quote` for the eras it did not populate
them, on every row of the file. Under a strict cast that is a partition that can never build,
and 4,678 of them failed on one sweep for exactly this. NULL is also the honest reading: the
venue published no number, which is what NULL already means here. Sentinels are never
enumerated — `None`, an empty string and a stray header all fail the same cast.

The cost is that a wrongly *mapped* column yields NULLs instead of an error. `mapping.test.ts`
covers that: it drives every series against a real file from the venue and asserts the projected
values, catching a bad mapping where it can be read and fixed.

`trades` · `quotes` · `orderBook` · `depthBands` · `klines` · `markPrice` · `indexPrice` ·
`premiumIndex` · `funding` · `borrowing` · `openInterest` · `liquidations` · `settlement`

Notes on the ones whose boundaries are not obvious:

- **`klines` bins a traded tape.** `markPrice`, `indexPrice` and `premiumIndex` are real OHLC
  bins too, but of a *reference series* — a virtual price with no market behind it, the same
  idea as BitMEX's referential ticks. A Binance mark row reads `volume=0, count=60` under the
  identical 12-column kline header. Same file shape, different data, different table.
- **`depthBands` is not a book.** Binance's `bookDepth` is notional within ±% bands of the mid —
  a summary. `quotes` is level 1 only; Bitget's "depth" belongs there despite its name.
- **`orderBook` is an event log**, not reconstructed books: one row per level change, with
  `action` ∈ snapshot/set/delta. Rebuilding a book at an instant is the consumer's job, since the
  depth it needs is its decision. No venue's books are mapped yet.
- **`funding` carries a `kind`** of `realised` or `predicted`. Gate publishes both; conflating
  them would invent a series.
- **`aggTrades` is not a table.** Binance's aggregated form was verified exactly reconstructible
  from `trades` — 52,231 spot and 113,501 futures aggregates rebuilt from their published id
  ranges with zero mismatches — and `trades` covers the same symbols and starts earlier.

**`margin` says what a contract settles in** — `linear` (its USD-like quote) or `inverse` (the
coin) — and is NULL on spot and options. It is carried by every table whose numbers mean something
different on the two: `trades`, `klines`, `quotes`, `orderBook`, `depthBands`, `openInterest` and
`liquidations`. A coin-margined trade's size is a contract count and its other leg is the coin; a
linear one's is base and quote. It is a constant per file, filled as each instrument is written,
from one rule per venue over the venue's own symbol (`schema/margin.ts`) — a stopgap until
instrument metadata says it.

## Time

One canonical unit: **int64 microseconds since epoch, UTC**, in a column named `ts`, and the
sort key of every file.

**The unit is read from the value by default.** Over 2015–2035 the plausible ranges sit
three orders of magnitude apart — seconds near 1.4e9, millis 1.4e12, micros 1.4e15, nanos
1.4e18 — so which one a value belongs to follows from the value itself, with the thresholds
falling in empty space between them. Text forms are handled too: ISO, and the dotted
`2024.11.01 00:00` of Bybit's MT4 klines.

Declaring the unit per series cannot be the default, because the archives do not permit it. Binance
spot trades are milliseconds through 2024-12 and microseconds from 2025-01, inside a single
dataset a consumer reads as one series, so any fixed declaration is wrong for one side of that
line. Bybit stamps fractional seconds on perpetuals and integer milliseconds on spot, under a
header saying `timestamp` for both. Inference costs one `CASE` per row and removes a whole class
of silent 1000× error.

**Generic by default, specific where it is justified.** Inference assumes the Unix epoch and a
value in one of those four units. A format that breaks either — another epoch, a unit the ranges
cannot separate — or one where detection costs more than a stated rule is better served by the
series saying so. That is a trade between generality, readability, complexity and speed, decided
per case. The one such statement today is a **zone**: a venue writing local datetimes declares
`utcOffsetHours`, and bybit's MT4 klines are UTC+3.

The parse is computed **once per row**, in inner projections the CASE then reads, with a
`BIGINT` fast path ahead of everything else — most files publish integral epochs. Inlining the
parse into every CASE branch instead evaluates it five times per row.

The fast path takes only **integral text** — DuckDB's VARCHAR→BIGINT cast *rounds* fractional
text rather than failing, so ungated it would silently strip the sub-second part of Bybit's
`1784937600.0683`. **A fractional epoch is split at its dot into two integers** — the whole part
and nine fractional digits — and combined at the unit the whole part names, rounded half-up to the
microsecond. Never `DOUBLE`: an epoch in microseconds is a 16-digit integer, at the edge of exact
DOUBLE range, where a multiply would silently round the last digit. Never `DECIMAL(38,9)` either:
it is exact, and it was the parse here, at 5.5 s for one day of bybit perpetual trades against
0.23 s for the split, with identical results on every row (measured 2026-10-04).

Anything that resolves to nothing lands as NULL and **the row is dropped**. That is what carries
a dataset across a format change: nine Binance futures datasets grew a header between 2021-01
and 2022-07, and read positionally the header line is simply a row whose timestamp is the text
`open_time`. No boundary date is written down anywhere.

**Every file is written `ORDER BY ts`, and the sort stays.** Many arrive sorted already, so
skipping it where inputs are provably ordered looked like the big win; measured on 2026-08-02,
removing it entirely was worth ~9% of build time. What the sort does set is the memory ceiling — it
is why a big month needs the spill directory — and that is not worth extra machinery while spilling
works.

**A file whose timestamps fall outside 2015–2035 is rejected rather than published.** Inference
removes the wrong-unit mistake the guard was written for, but not the one it still catches: a `ts`
naming the wrong column, where values parse cleanly and mean nothing.

### Venues whose buckets do not cut at UTC midnight

Not every venue's day is a UTC day. Bitget, okx and htx cut at **16:00 UTC** — midnight UTC+8 — so the
file named `20250101` opens at 2024-12-31 16:00 UTC and its head belongs to December. Bybit's MT4 files
are UTC+3 months, so each opens with the previous UTC month's last three hours.

Nothing about the *rows* is wrong once their zone is applied; only which file holds a row is
shifted. Left alone, that would make a month a shifted window — hours of the previous month
present, the last hours of its own month missing — which is invisible to anyone filtering on `ts`
and wrong for anyone reading a partition as a calendar month.

This is declared, never coded per venue. A series states where its buckets can spill:

| `spill` | meaning | to complete period P, also read |
|---|---|---|
| _(unset)_ | buckets match UTC cuts | — |
| `back` | a bucket holds rows from before its label | the next month's **first** bucket |
| `forward` | a bucket holds rows from after its label | the previous month's **last** bucket |
| `both` | either way | both |

Three things follow, and all are mechanical:

- **The neighbour's edge is read too.** Each instrument's files are joined by that instrument's
  files in the neighbouring month's edge bucket — every part of it, since a split day's tail is
  spread across them. For a monthly grain the edge is the neighbour's whole file.
- **The build clips to the month.** Pulling in a neighbour without bounding the output would
  write its rows into two partitions. Clipping applies **only** to spilling series: elsewhere it
  could only ever delete, since a stray out-of-period row has no neighbour supplying it.
- **The partition waits for its neighbour.** It is ready only once the neighbouring month is
  downloaded and settled too, and the neighbour's version is part of its revision — so the
  neighbour changing restocks it. The newest month a lens holds therefore waits for the lens to
  reach the month after it.

The trait assumes the offset is smaller than one bucket, so one neighbour in each direction is
enough.

Verified on real bitget data across the 2024-12/2025-01 boundary: the December partition ends at
`23:59:59` UTC and January's starts at `00:00:00`, no `tradeId` appears in both, and the two
together hold exactly the number of rows the raw files hold over the same span.

## Coverage

Every entry was written from a decoded file — one probed at each end of the dataset's history —
and the semantics a file cannot state were settled by arithmetic over real rows, not by reading
documentation.

Every format, venue by venue — what each file holds, how it maps, and what is not mapped yet — is
in [STOCKER-PARTITIONS.md](STOCKER-PARTITIONS.md).

The map is exercised against fixtures cut from real archive files, so a renamed column, a swapped
pair or a misread unit fails a test rather than producing plausible-looking data.

## Running it

Long-lived rather than a batch job, so files that land unattended are picked up on their own.
That makes **"caught up" a signal worth acting on**: everything in scope that is downloaded is
stocked.

So every sweep ends by saying what it means, rather than leaving it to be inferred from an
absence of work:

| Outcome | Reported as |
|---|---|
| stocked something | `Stocked N partitions — rescanning in M minutes` |
| nothing to do, some still downloading or not on disk | `Caught up — N partitions still downloading, M not on disk as catalogued` |
| nothing to do at all | `Caught up — every partition in scope is stocked` |
| anything failed | a warning naming the count, never "caught up" |
| stopped for want of space | a warning, never "caught up" |

Sweeps cannot overlap; a tick landing mid-sweep is skipped and logged.

`STOCKER_LENS`, `STOCKER_VENUES`, `STOCKER_TABLES` and `STOCKER_START_MONTH`/`STOCKER_END_MONTH`
scope a sweep. None of them is a commitment — nothing about them is recorded, so widening one
later makes more partitions eligible without restocking what is already done.

Configuration and the storage contract are in the
[service README](../../services/stocker/README.md).
