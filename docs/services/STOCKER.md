# Stocker

Stocker normalises every collector's raw output into one partitioned Parquet vault, so
consumers never learn where a dataset came from or what shape it arrived in.

Trucker fetches archives, and the REST and websocket collectors will add whatever no archive
covers. Each drops data exactly as its source published it: different paths, containers, column
names, timestamp units and symbol conventions. Stocker reads all of them and writes one
uniform, queryable tree beside them. **Raw is never modified, moved or deleted.**

Archives, REST and websocket are availability choices about *how* something was obtained, not
different kinds of data — a trade is a trade. That is why one service handles all of them.

## Scope

**Does:**

- Decode every container and format the origins use
- Map each source series onto a **canonical table** with one schema across all venues
- Impose one path convention, one timestamp unit, one identity per instrument
- Write Parquet partitioned so a query engine can prune
- Rebuild any partition from raw, incrementally, as more lands

**Does not:**

- Modify anything under a raw tree — the mount is read-only, so the code is not trusted with it
- Invent data. A field a source does not publish stays NULL; it is never derived and presented
  as sourced
- Merge venues into one series. Cross-venue is a query, not a stored artifact
- Resample, fill gaps or clean outliers — those are opinions and belong downstream

The line: **normalise structure, never semantics.** Renaming `depth` → `orderBook` and
converting seconds to microseconds is mechanical and reversible. Deciding a 50-level book and a
5000-level book are interchangeable is a judgement, and once stored as fact it is invisible.

## Path convention

```
<vault>/venue=…/market=…/{FL}/symbol=…/dataset=…[/interval=…][/variant=…][/kind=…]/
    {table}.{venue}.{market}.{symbol}[.{interval|variant|kind}].{YYYYMM}.parquet
```

**The order is chosen for handling, not for querying.** A query engine harvests `key=value` from
any position and prunes identically whichever way the levels are stacked, so what the order
actually decides is what a *single directory* can be moved, backed up or evicted as. Venue first
makes a venue one folder — which is the unit work is scheduled in: a few venues get built and
pushed to cold storage while the rest wait, and a venue already done can be brought back from cold
without touching anything else. Cross-venue queries are rare; cross-dataset queries for one venue
are not, and those are one subtree here.

**`{FL}` is the symbol's first letter** — uppercased, `_` for anything that is not a letter, which
catches digit-leading symbols like `1INCHUSDT` and the handful of CJK names. It exists so a market
holds a few dozen entries per letter instead of thousands of symbol directories side by side, and
it is deliberately a **bare segment rather than `key=value`**: it is a filesystem device, not a
fact about the data, so nothing should be able to filter on it.

**`dataset=` rather than `table=`**, because `table` is a SQL reserved word — a column named that
must be quoted in every query mentioning it. Stocker's `PartitionKey` still calls the field
`table`; the path is what a person types.

**Hive `key=value` directories.** The keys are not stored in the files — `parquet_schema` on a
partition shows only the data columns — yet queries return them as columns read from the
directory names, and filtering prunes files without the caller building a path. Storing them as
real columns would cost about 0.8 % (measured on a 200k-row sample: Parquet dictionary-encodes
a constant column to one entry and zstd flattens the rest), so this buys ergonomics rather than
space. Two corollaries matter. **A filter on a plain column does not prune files** — only path keys
do. And because a partition encodes nothing about where it lives, **moving one is lossless by
construction**: the layout can be rearranged with `rename(2)` and no rebuild. The same fact is why
dropping a level is not a free trade against a slower filter — removing the `market=` directory
would not demote that column, it would delete it.

**A symbol literally named `null` exists in the vault.** A venue is unlikely to publish that name,
so it most likely comes from a symbol that failed to parse upstream and was stringified. Unresolved,
and worth tracing to whichever stage produced it; nothing depends on fixing it first.

**`market=` carries contract shape only** — `spot` · `perp` · `future` · `option` · `index`.
Margining is deliberately excluded: Binance splits futures into `um`/`cm`, Gate into
`futures_usdt`/`futures_btc`, Bybit into linear/inverse, three vocabularies for one idea. With
shape in the path, `market=perp` means the same thing everywhere.

**Interval, variant and kind are levels below `dataset=`**, present on the tables that need
them. `klines` always carries `interval=`; `orderBook` always carries `variant=`; `funding`
always carries `kind=`.

**Which levels a dataset carries is a property of the dataset, never of the venue.** Once an
attribute is in the path it is in the path for every venue — including one that publishes a
single value, which then simply has one directory. Path depth that varied by venue inside one
table would make every query and writer branch on which venue it was looking at, and a missing
level would read as a different partition.

`kind` separates funding that was **charged** from the running **estimate** of the next
interval. Gate publishes both — 3 rows a day against 1,440 — and they are different things: a
forecast is not a fact, and their timestamps coincide, so interleaving them in one file gives
duplicate timestamps distinguished only by a column. It was a projected column until both
series computed the same partition id and overwrote each other on every sweep, leaving all 757
gate funding partitions holding half their rows. A column could not have worked: partition
identity is what keeps two series apart, and a filter on a plain column prunes no files —
reading realised funding would have scanned 480x the rows it needs.

**An attribute lives in the file or in the path, never both.** `interval` is a path attribute: no
klines partition of any venue stores it as a column, and `ts` plus the path's interval is what
defines a bar's period as `ts` to `ts + interval`. A series that captures no interval from the raw
path must therefore declare one — okx and bitget both name none at any level, and both declare
`1m` with the measurement written down beside it (bars a uniform 60 seconds apart, `open_time`
stepping by exactly 60000 across the file).

**And it belongs to klines alone.** Everything else in the vault is a point value with a
timestamp — a mark price of 100 at an instant is complete on its own, and how often a venue emits
one is a property of their pipeline, not of the datum. So `markPrice`, `indexPrice`,
`premiumIndex`, `funding`, `trades` and `quotes` correctly carry no interval. It is kept as its own
attribute rather than folded into the dataset name (`klines1m`) because it is an almost-free
string, venues differ wildly — fifteen intervals at one, exotic ones like `10s` elsewhere — and
"which intervals does this symbol offer" is far easier to ask when dataset and interval are
separate.

**The month is the partition, and it is one file.** It is named for the month rather than
filed under a `date=` directory, because nothing queries by month — a reader wants a symbol, and
a symbol holds one file per month it traded. Adding the level would prune nothing and deepen
every path.

**File names are descriptive** rather than `data.parquet`, because a file that leaves the tree
travels alone — an upload queue or transfer log shows the name, not the path.

## Architecture

Four extension points, each a file you add rather than a switch you edit. Nothing outside
`sources/` and `schema/` names a venue.

| Concern | Directory | Contract |
|---|---|---|
| Where raw comes from | `src/sources/` | `walk()` yields `Candidate`s; knows its tree's layout |
| How bytes are wrapped | `src/containers/` | `native` or `unpack()` to a scratch dir |
| How rows are read | `src/formats/` | `relation()` returns a SQL expression |
| What a series means | `src/schema/series.ts` | declarative, one entry per series |
| What a table is | `src/schema/tables.ts` | declarative, the canonical column list |

Everything else — discovery, grouping, staleness, writing — is generic.

### Discovery is cheap by construction

`walk()` yields a `Candidate` **without stat-ing it**. Config filters run first, and only the
survivors are stat-ed for the size their manifest needs. Walking a tree of millions of files
must not cost a syscall per file for a value most of them will never need — a scoped run cost
one syscall per *kept* file instead of one per file in the tree, which was the difference
between a ten-minute scan and a two-second one.

### Grouping is streamed, and one venue cannot be

A partition is assembled **as the walk passes it**: the walk is depth-first and sorted, so a
partition's files arrive consecutively and it is complete the moment a different one begins.
Nothing is held in memory, and every venue satisfies this by construction — a partition lives in
one directory.

Bitget does not. It published klines under two names and still serves both, so one month arrives
as `kline/BTCUSDT/BTCUSDT_UMCBL_1min_20200819.zip` *and* as `kline/BTCUSDT/UMCBL/20200824.zip` —
and in name order every flat file of every month precedes the first nested one. The halves are
separated by thousands of files belonging to other partitions.

A series says so with **`scattered`**, and is then gathered across the whole symbol and closed when
the walk leaves it. That costs one symbol's files in memory, a few thousand at worst, which is why
it is opt-in rather than the rule. The walk must be symbol-major for such a series — it is, for the
only venue that needs it.

**The invariant is now enforced rather than assumed.** A partition assembled twice in one walk
throws, naming the series and the fix. Before that check, a scattered series that did not declare
itself produced its two halves as two partitions, the second silently overwrote the first, and every
sweep afterwards saw the missing half as newly added and rebuilt for ever — with no new data
anywhere. It cost 52 partitions half their rows and looked like a ledger bug.

### Builds run concurrently under one memory budget

Complete partitions go to a bounded pool — `STOCKER_CONCURRENCY` of them in flight, one DuckDB
connection each — so one partition's extraction overlaps another's sort. The walk stays
sequential and backpressured: when every connection is busy, discovery waits, so it can never
pile up work unboundedly ahead of the builders.

Every connection comes from **one DuckDB instance**, which is the load-bearing part:
`memory_limit` and `threads` are instance-wide, so concurrent builds divide the configured
budget rather than multiplying it. Raising concurrency never raises what the service may take
from the box.

Config filters run at discovery. Venue and table tokens are matched case-insensitively against
what the series map declares, and an unknown token **fails startup** — those vocabularies are
closed, so a token outside them can never match, and accepting one would turn a typo into an
eternally clean run of zero partitions. Symbols stay substring tokens: theirs is an open set,
where matching nothing today and something after the next trucker sweep is normal.

### Containers are unpacked only when they must be

DuckDB reads gzip natively, so `.csv.gz` is handed over untouched — which covers Bybit and Gate
entirely, and is the difference between copying a 23 GB order-book month to scratch and not.
Only `.zip` and `.tar.gz` are extracted.

Extraction lands in `<vault>/.stocker-tmp`, **never the system temp directory**: these archives
run to hundreds of MB, and in a container `os.tmpdir()` is the overlay filesystem, where filling
up presents as a corrupt build rather than the full disk it is. Everything transient — the
extraction, the part-written Parquet, the engine's spill — lives in that one directory, so
clearing it after a hard kill is a single delete rather than a walk over the vault.

### Files a venue published empty

A venue publishes archives for days it had nothing to report. Bybit wrote one for every symbol
that delisted on 2022-12-12 — a valid 42-byte gzip whose payload is nothing — and Gate leaves a
file of no bytes at all for a symbol that listed and never traded.

Left in the file set they break a header-mapped series two ways: alone, the reader finds no
header and invents a single `column0`, so every projected column fails to bind; mixed into a
month, the sniffer takes that invented schema as the file set's and rejects the real files
against it. So empty inputs are dropped before the reader sees them, and a month with nothing
but empty inputs is **not built at all** — the venue published nothing for it, and a partition
that does not exist says exactly that. It is counted as `empty` in the sweep summary rather than
passing in silence.

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

**It runs only after a build has already failed**, which is the difference from the width check
above. A file *wider* than the series reads successfully and means something other than what the
map says, so it must be caught before anything is written. A file that will not parse produces no
data rather than wrong data, so the build stops on its own and this exists only to say why in
terms of the file. The happy path never pays for it.

A positional read cannot land here: it declares its own column names and pads short rows
deliberately, so it parses whatever it is given.

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
  `action` ∈ snapshot/set/delta. That is the shape OKX, HTX and Gate already publish and the
  degenerate case of KuCoin's periodic snapshots. Rebuilding a book at an instant is the
  consumer's job, since the depth it needs is its decision.
- **`funding` carries a `kind`** of `realised` or `predicted`. Gate publishes both
  (`funding_applies` and `funding_updates`); conflating them would invent a series.
- **`aggTrades` is not a table.** Binance's aggregated form was verified exactly reconstructible
  from `trades` — 52,231 spot and 113,501 futures aggregates rebuilt from their published id
  ranges with zero mismatches — and `trades` covers the same symbols and starts earlier.
  Trucker no longer downloads it.

## Time

One canonical unit: **int64 microseconds since epoch, UTC**, in a column named `ts`, and the
sort key of every partition.

**The unit is read from the value, never declared.** Over 2015–2035 the plausible ranges sit
three orders of magnitude apart — seconds near 1.4e9, millis 1.4e12, micros 1.4e15, nanos
1.4e18 — so which one a value belongs to follows from the value itself, with the thresholds
falling in empty space between them. Text forms are handled too: ISO, and the dotted
`2024.11.01 00:00` of Bybit's MT4 klines.

Declaring the unit per series was the alternative, and the archive does not permit it. Binance
spot trades are milliseconds through 2024-12 and microseconds from 2025-01, inside a single
dataset a consumer reads as one series, so any fixed declaration is wrong for one side of that
line. Bybit stamps fractional seconds on perpetuals and integer milliseconds on spot, under a
header saying `timestamp` for both. Inference costs one `CASE` per row and removes a whole class
of silent 1000× error.

The parse is computed **once per row**, in inner projections the CASE then reads, with a
`BIGINT` fast path ahead of the general parse — essentially every file publishes integral
epochs. Both halves of that sentence are load-bearing: inlining the parse into every CASE
branch evaluates it five times per row, and routing every value through DECIMAL costs ~20× the
integer parse; together they made builds ~100× slower than this (96.7 s → 1.0 s for 500k rows
of Binance trades, byte-identical output).

The fast path takes only **integral text** — DuckDB's VARCHAR→BIGINT cast *rounds* fractional
text rather than failing, so ungated it would silently strip the sub-second part of Bybit's
`1784937600.0683`. Fractional values convert through `DECIMAL(38,9)`, never `DOUBLE`: an epoch
in microseconds is a 16-digit integer, at the edge of exact DOUBLE range, where a multiply
would silently round the last digit.

Anything that resolves to nothing lands as NULL and **the row is dropped**. That is what carries
a dataset across a format change: nine Binance futures datasets grew a header between 2021-01
and 2022-07, and read positionally the header line is simply a row whose timestamp is the text
`open_time`. No boundary date is written down anywhere.

**A partition whose timestamps fall outside 2015–2035 is rejected rather than published.**
Inference removes the wrong-unit mistake the guard was written for, but not the one it still
catches: a `ts` naming the wrong column, where values parse cleanly and mean nothing. It reads
min/max from the row-group statistics, so it costs nothing.

### Venues whose buckets do not cut at UTC midnight

Not every venue's day is a UTC day. Bitget cuts at **16:00 UTC** — midnight UTC+8 — so the file
named `20250101` opens at 2024-12-31 16:00 UTC and its head belongs to December.

Nothing about the *rows* is wrong: the timestamps are plain epoch milliseconds UTC, correct as
published. Only which file holds a row is shifted. Left alone, that would make a month partition
a shifted window — eight hours of the previous month present, the last eight hours of its own
month missing — which is invisible to anyone filtering on `ts` and wrong for anyone reading a
partition as a calendar month.

This is declared, never coded per venue, because a second venue with the same boundary must not
mean a second implementation. A series states where its buckets can spill:

| `spill` | meaning | to complete period P, also read |
|---|---|---|
| _(unset)_ | buckets match UTC cuts | — |
| `back` | a bucket holds rows from before its label | the bucket **after** P |
| `forward` | a bucket holds rows from after its label | the bucket **before** P |
| `both` | either way | both |

Three things follow, and all three are mechanical:

- **The walk donates edge buckets.** A file in the first or last bucket of its month is handed to
  the neighbouring partition as well as its own. A multi-part day donates every part, since a
  day's tail is split across them.
- **The build clips to the month.** Pulling in a neighbour without bounding the output would
  write its rows into two partitions. Clipping applies **only** to spilling series: elsewhere it
  could only ever delete, since a stray out-of-period row has no neighbour supplying it.
- **The readiness gate waits one bucket longer.** A back-spilling month is complete only once the
  next bucket has landed, so it asks for `endOfMonth(M) + 1 day` rather than `endOfMonth(M)`.
  That covers both granularities: for a daily-bucket venue it is the file dated the 1st of the
  next month, and a monthly-bucket venue's milestone only reaches that date when the whole next
  month lands — which is exactly the file needed.

The trait assumes the offset is smaller than one bucket, so one neighbour in each direction is
enough. A venue shifted further would be messy enough not to collect from archives at all.

**A venue that spills backwards everywhere is permanently one month behind its collector**, and it
says so. The newest closed month needs a day the collector has not reached, so it yields no
partition at all and the vault's month count sits one below the archives' — for as long as that
month is the tip. Counting alone cannot tell that from a backlog, so stocker records a `spills`
fact against the venue and whoever is comparing reads it. It is stated only where **every** series
of the venue spills that way: with a mix, the month still builds from the series that do not, and
there is no shortfall to explain.

Verified on real bitget data across the 2024-12/2025-01 boundary: the December partition ends at
`23:59:59` UTC and January's starts at `00:00:00`, no `tradeId` appears in both, and the two
together hold exactly the number of rows the raw files hold over the same span.

## Rebuilding

Parquet is immutable: you append by writing files and "edit" by rewriting a partition. That
makes the vault a read-only database whose data directory is also its dump.

The unit of work is one partition, rebuilt whole and never appended to, written to scratch and
renamed into place — so a crash mid-build leaves the previous partition intact.

**A partition is stale only when raw appears that is not in its record — never when recorded
raw has gone missing.** Raw is expected to be backed up to cold storage and deleted locally
once processed, so absence must read as "already done, leave alone". Any other rule would turn
reclaiming disk into a silent rebuild of everything.

The record lives in the shared facts store as `topic=vault, fact=built`, one fact per
partition, and deliberately **not** beside the data. The steady state is a vault whose
partitions have been backed up and evicted while their raw may still be local; a record kept
next to a partition would leave with it, and stocker could no longer tell "never built" from
"built and evicted". Keeping it separate means reclaiming space is deleting `.parquet` files by
any means — by file, by directory, or by whole subtree — with the knowledge of the work intact.
A rebuild re-states the same fact, so the key collapses what an append-only file needed a
"later line wins" rule for.

**The members are a topic of their own**, `vault:details`, one fact per input with the raw path
as the fact and its size as the value. That list is twenty times the volume of the partitions
themselves and is wanted only by the one thing that asks which raw file became which partition,
so it is a separate topic and therefore a separate database — the common question never pays
for the rare one's rows.

**A rebuild replaces its members rather than adding to them.** The inputs a rebuild records are
the whole truth about that partition, and accumulating instead would leave a raw file a rebuild
dropped still vouching for a partition it no longer feeds. bitget's klines were rebuilt from one
of two published layouts at a time, and thirty-five months read as fully normalised and were
offered for eviction, taking with them the raw the repair needed.

Whether the partition is still on local disk is not consulted, and a rebuild never reads the
previous Parquet — only raw. Raw is reclaimed a **whole month at a time**, so finding any raw
for a partition means none of that month has been reclaimed, and the files in hand are always a
superset of the ones the last build recorded. A rebuild can therefore only ever be more complete
than what it replaces, evicted or not. When a month's raw is gone the walk yields no candidates
for it and nothing is considered at all.

### When a settled month changes — `logs:vault`, `fact=drifted`

The record holds each input's **path and size**, so a month that gains a raw file after it was
built comes back as changed and is rebuilt without anyone asking. That is the mechanism working,
but it is also an event worth knowing about: a partition is only built once its collector
publishes the month as finished, and finished is a promise the month will not change. By the
time it does, the same month may already be tarred into cold storage or mirrored offsite.

So the rebuild is announced twice — a `WARN` in the log for whoever is watching, and a fact
under `logs:vault` for whoever is not, carrying how many inputs appeared, the first of them and
when the partition had been built.

**It accumulates rather than replaces**, which is what the `logs:` layer is for. Every other
fact stocker states describes how something *is*; drift is something that *happened*, can happen
again, and a partition that has drifted three times is saying something one that drifted once is
not. `seq` carries the moment, which both separates the occurrences and orders them.

Container logs do not survive the container, which is the whole reason this is a fact rather
than only a log line: something that goes wrong months from now is diagnosed from what was
recorded when it happened, and by then the log is long gone. Nothing acts on these; they exist
so a person can decide whether a tarball needs rebuilding.

Additions are what this catches. A file **removed** leaves the remaining inputs matching what was
recorded and passes unnoticed — deliberately, since nothing deletes raw archives, and detecting
it would mean re-`stat`ing every input of every settled partition on every sweep.

## Coverage

Every entry was written from a decoded file — one probed at each end of the dataset's history —
and the semantics a file cannot state were settled by arithmetic over real rows, not by reading
documentation.

**Every dataset trucker collects is mapped except the order books**, which are not modelled yet
and are the next piece of work rather than a permanent exclusion.

That claim is worth checking rather than trusting, and checking it is mechanical: run every path
in the raw tree against the matchers and see what falls through. It costs a walk and answers
exactly, which is how both of the gaps below were found — neither was visible by reading the list
of entries.

- **Gate publishes spot candlesticks**, and only the futures ones were mapped. It was the whole
  reason gate's archive months could not be evicted.
- **Bitget publishes klines under two names** and serves both, and only the newer one was mapped.
  The venue's own two shapes were already written down in [BITGET.md](../venues/BITGET.md); the
  series simply did not carry both.

Neither is a count worth keeping here. How many files a venue has published is a fact about the
tree on a given day, not about this service, and a doc that states one is stale as soon as the
next bucket lands.

Two cases needed the interval established rather than read:

- **OKX candlesticks** name it nowhere, at any level. The bars step by a uniform 60000 ms across
  the file, so the series records `1m` directly.
- **Bybit's MT4 klines** name it as a bare count of minutes in the filename
  (`BTCUSDT_15_2024-02-01_2024-02-29`). Anything numeric is converted to the vocabulary every
  other venue already uses, so `15` becomes `15m` and `1440` becomes `1d` rather than sitting in
  the same table under a different spelling. The filename carries a date *range*, but the range
  is always exactly one calendar month, so the period is not in doubt.

### What the survey found

Shapes were checked at both ends of every dataset's history, then bisected where the ends
disagreed. Twenty-one datasets change shape partway through, and the mapping absorbs all of them
without a boundary date:

- **binance spot trades and klines** switch milliseconds → microseconds (2024-12 → 2025-01)
- **nine binance futures datasets** gain a header (2021-01 → 2022-07, each on its own date)
- **bybit perpetual and spot trades** gain a column (`RPI`, 2025-04), absorbed by name mapping

Three findings were invisible in the files themselves and were settled by arithmetic:

- **gate spot** encodes side as `1`/`2` — price impact over 7.5M trades says `1` is a buy
- **gate futures** carry no side at all; the sign of the size is the side
- **gate candlesticks** are `close, high, low, open` — open and close reversed from the obvious
  reading, proved by four intervals of one symbol sharing a bar start and an open

And one sentinel that would have poisoned every spread on the venue: **bitget publishes a missing
quote as `-999999`**, which is mapped to NULL.

The map is exercised against 71 fixtures cut from real archive files, so a renamed column, a
swapped pair or a misread unit fails a test rather than producing plausible-looking data.

## Running it

Long-lived rather than a batch job, so raw that lands unattended is picked up on its own. That
makes **"nothing to do" a signal worth acting on**: every raw file visible has been normalised,
and once backed up it is safe to delete locally.

So every sweep ends by saying what it means, rather than leaving it to be inferred from an
absence of work. A log that only reports partitions built looks the same when it is finished as
when it is wedged — the last line is a build from minutes ago and nothing since — and telling
those apart is exactly what someone watching needs:

| Outcome | Reported as |
|---|---|
| built something | `Built N partitions — rescanning in M minutes` |
| built nothing, nothing waiting | `Caught up — every partition available is built` |
| built nothing, some waiting | `Caught up — N partitions waiting on months the collectors have not closed yet` |
| anything failed | a warning naming the count, never "caught up" |

The last two are deliberately separate. Both mean this sweep did no work, but one is finished
and the other is blocked upstream, and they have different fixes.

Sweeps cannot overlap; a tick landing mid-sweep is skipped and logged.

### A month is built only once the collector says it is finished

A directory of files says which periods arrived; it never says whether more are coming. Only the
collector knows, and trucker publishes it as **one fact per venue** — the month it is collected
through, in the shared facts store as `topic=archives, fact=complete`:

```
201802	2026-08-03T14:22:10.004Z
```

Stocker reads it once per sweep and builds a partition only when its month is at or below that
tip. Trucker walks month-major, so the tip is a statement about every dataset and every symbol of
the venue at once.

**The tip is the unbroken run of closed months, not the highest one in the file.** A month left
open by a failed collection pass is stepped over by the months that close after it, so reading
the maximum vouches for a hole underneath it. bybit's file said 202501 while 202402 and 202405
were never finished, and stocker built 2,091 partitions from the two of them. Stopping at the
break means the closed months above a hole read as `pending` until it is filled — which is the
right answer, and the one that resolves itself when the collector goes back.

Four conditions, all of which must hold:

1. every file of the month that has been collected is on disk;
2. trucker's tip for the venue reaches the month's last day — one day further for a series whose
   buckets spill backwards, whose tail lives in the next one, which in practice means waiting for
   the following month to close;
3. the partition is not already built from exactly these inputs;
4. the month is inside `STOCKER_START_MONTH`/`STOCKER_END_MONTH`, and is not the running month.

A partition that fails only the second is counted as **`pending`** in the sweep summary — sitting
on disk, complete as far as it goes, waiting for the collector to finish the month.

**A venue that has published no tip is skipped entirely.** That is deliberate: a venue excluded
from `TRUCKER_VENUES` while attention is elsewhere is not being collected, so nothing it has on
disk can be called complete. Removing a venue from collection therefore also stops it being
normalised, with no second switch to remember.

**Stocker reads that one file and nothing else of trucker's.** The other ledgers beside it —
per-symbol cursors, coverage, listing ranges — answer "where is this symbol up to", whose answer
changes for ever, because an active symbol always has more coming. Consuming them meant mapping
every raw path back to trucker's own vocabulary for a collection effort (`um-trades`,
`futures_usdt-candlesticks_1m`), asking per symbol, and knowing which symbols had delisted — a
whole module of per-venue path rules reconstructing a fact the collector can simply state.

### Working an era at a time

`STOCKER_START_MONTH` and `STOCKER_END_MONTH` bound a run to inclusive `YYYY-MM` months, applied at discovery
so anything outside is never even grouped into a partition. The running month is excluded
regardless, since its raw is still arriving.

Neither bound is a commitment. Nothing about them is written down — the ledger is keyed by
partition — so widening one later makes more months eligible without rebuilding or re-scanning
what is already done, and either end can be pinned independently to work the oldest data or the
newest.

These bound *which* months a run considers; the tip above decides whether a month it considers is
ready. They are independent, and the bounds are the coarser tool: pin `STOCKER_END_MONTH`
to work an era at a time in step with whatever is being moved to cold storage, without waiting
for the walk to cross months you are not interested in yet.

Configuration and the storage contract are in the
[service README](../../services/stocker/README.md).
