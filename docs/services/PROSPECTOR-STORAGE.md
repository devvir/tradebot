# Prospector: storage

The catalog database prospector creates, migrates and writes: its engine settings, its one writer,
its tables, how it is cut into slices and partitions, and how it is migrated. What the rows *mean* is
in the articles on each subject — series, patterns and instruments in
[PROSPECTOR-SERIES.md](PROSPECTOR-SERIES.md), run rows and `wip` in
[PROSPECTOR-PASSES.md](PROSPECTOR-PASSES.md), files, withdrawals, exclusions and `unreadable` in
[PROSPECTOR-WALK.md](PROSPECTOR-WALK.md). What prospector is, is [PROSPECTOR.md](PROSPECTOR.md).

## One file, one writer

The database is `catalog.db` in `/data/catalog` inside the container. SQLite, in WAL mode, with
`STRICT` tables — SQLite is otherwise dynamically typed, and a declared `INTEGER` column will happily
hold a string, which surfaces later as a query that silently matches nothing.

The schema lives in `src/database/schema.ts`, with the migrations beside it in
`src/database/migrations/`; the queries are in `src/catalog/`. **Prospector creates and migrates the
file, and is the only thing that writes it — every row of every table, lenses included.** Two writers
on one SQLite file wait on each other's locks, and the one that waits longest fails; with one writer,
the survey's writes take their turn in one queue, the serial write queue (`slice()` in
`catalog/serial.ts`), and nothing waits on a lock at all. The API's own writes — lenses, reports — are
synchronous from `BEGIN` to `COMMIT` and are written where the request is handled, outside that queue.

WAL gives many concurrent readers alongside one writer; readers never block the writer and the
writer never blocks readers. A WAL *reader* still writes the `-shm` sidecar, so mounting the catalog
read-only does not make it safe to share — it makes even a `SELECT` fail. Who writes is a code
boundary, and cannot be delegated to the filesystem.

Startup therefore **proves it can write** before a survey begins, by setting `user_version` to the
value it already holds: a write transaction that changes nothing. Nothing cheaper answers the
question — opening a read-only file succeeds, and so does asking for WAL on a database already in
it — and finding out hours into a walk instead is the alternative.

One setting cannot be fixed retroactively — `auto_vacuum = INCREMENTAL` is applied **at creation**,
and enabling it later requires a full rebuild of the file.

## The tables

Sixteen tables. `venue`, `file`, `wip` and `revision` are what a venue serves and what became of
it, `revision` holding each file's previous versions; `instrument` is what it trades; `slice` and
`partition` are what it publishes, cut the way it is handled; `pattern`, `series` and `transform` are
where it publishes it, and how it spells an instrument the pattern cannot; `run` is how far each pass
has read and `survey` whether this deployment reads it at all; `exclusion` and `unreadable` are the
two lists of things ruled out and not yet read; and `lens` and `lens_member` are the lenses stored
through the private API, and what each lets through.

Beside the database, `withdrawals.log` records every file withdrawn or returned — a record, not
state: nothing reads it back ([withdrawals](PROSPECTOR-WALK.md#withdrawals)).

### Slices and partitions

**A slice is one lengthwise cut of a venue's data, and a partition is one month of it.** A slice is
a dataset of a market narrowed by its variant, its grain and its bundle, under the venue's *name* —
whichever of its servers publishes it. **A pattern belongs to a slice**: its market, dataset, variant
and grain are the slice's, not columns of its own, and one URL shape publishing into two slices — a
venue-wide file and a file per instrument, say — is two patterns. The one statement `SLICE_OF` in
`schema.ts` finds a pattern's slice or creates it, for a survey and a seed alike.

**Every file belongs to one partition**, its series' slice at the month of its date, and says so in
`file.partition_id`, which is indexed: every file of a partition is one range read. A partition's
row exists once a file does.

**A partition carries its own counts and its version**, moved in the same transaction as the file
rows they describe — `catalog/cache/partitions.ts`. The counts are files, bytes, what is still to
download and what the venue has withdrawn, so a venue's totals and a lens's size are sums over a few
thousand rows and never a scan of `file`. **The version is a sum too**: each confirmed file is a
64-bit number hashed from its ETag, and the version is their sum, wrapped at 64 bits
and written as sixteen hex digits. A file arriving adds its number, one withdrawn subtracts it, one
that changed does both — so no file is read to state it, the order files arrived in does not matter,
and the same files give the same version in a catalog rebuilt from nothing. **A file's path is no
part of its number**: the version says what a partition holds, not where the venue keeps it, so a
venue that moves or renames files without changing their bytes leaves every version where it was. The
sum is done in this service, since SQLite turns an overflowing integer sum into a float. `updated_at`
moves when the version does and at no other time: a download changes what is pending and nothing
else.

A partition is taken into the lenses it belongs to in the transaction that creates it, so a lens
never meets a partition it has not looked at ([lenses](PROSPECTOR.md#lenses)).

### Instruments and series

**An instrument is a row of its own**, `(venue, market, symbol)`, the venue being its *name*; a
series holds its instrument rather than a symbol, and is created through the one statement
`INSTRUMENT_OF` in `schema.ts`, which creates the instrument where it is new. A market bundle (`@`)
series has none. What an instrument, a chain and a series are, and what makes two series one (the
`series_key` index and the registry's `identity()`), is
[PROSPECTOR-SERIES.md](PROSPECTOR-SERIES.md#instruments).

**A series carries its place in the catalog's listing**, `series.prefix`
(`venue/market/dataset[,variant]/F/symbol/`, or `…/@/` for the venue-wide file), indexed, which is
what lets a page of the listing be one query in key order. It is written by a trigger as the series is
created, so no writer — a survey or a seed — has to know the listing's layout, and the expression is
the one `PREFIX_OF` in `schema.ts`. A symbol that cannot be a folder name, empty or holding a `/`, has
none.

## Migrations

**Migrations run automatically, once, on open — on every database, including a fresh one.**
Versioning uses SQLite's own `user_version`, so a database that has never heard of migrations reports
0 and needs no bookkeeping table. Each migration runs in its own transaction with its version bump,
so a failure leaves the file where it was rather than half-migrated, and a catalog from a *newer*
build is refused rather than written to by an older one.

The chain is six steps: the schema with the venue rows and the shipped exclusions (gate's two
zero-byte upload tests, 85 of the spot files gate serves at futures URLs for 2021-07, bybit's one
misfiled `DOTUSDT` day), then htx's retirement dates, then okx's series, then bitget's, then the
shapes gate filed under a month they do not belong to, retired at the one day each holds, then the
shapes binance stopped writing. What each venue's seed holds, and why, is in
[PROSPECTOR-VENUES.md](PROSPECTOR-VENUES.md#venue-by-venue) and the
[seeds README](../../services/prospector/src/database/migrations/seeds/README.md).

**A seed is a migration and not a startup hook**, because a fresh catalog is exactly the database
that would otherwise pay for rediscovering it. A caller that wants the shape without the findings — a
test fixture, mostly — declines them with `seedData: false`, which still advances the version so
nothing is retried behind its back.

**One file per migration**, in `database/migrations/`, named for the version it produces and listed in
order by that directory's `index.ts`. **The chain describes the catalog as it is, not how it got
there**; how a change to it is made is in the `index.ts` docblock.

That is the only thing startup does to an existing file: no repair, no rebuild, no inference about
what it ought to contain.

## The schema for tests

The package serves the schema as the `@tradebot/prospector/testing` subpath: `CATALOG_SCHEMA`,
`AT_CREATION`, `ON_OPEN` and `SCHEMA_VERSION` as the service itself uses them, and `emptyCatalog()`,
which builds a catalog from the real migration chain with no shipped rows — not even the venues and
exclusions — opened with the pragmas every catalog is opened with. In memory where no path is given;
a path that already holds a catalog is opened as the service opens it.
