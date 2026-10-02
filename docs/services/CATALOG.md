# Catalog

The catalog service is how everything outside the [archives module](../modules/ARCHIVES.md) reads what
prospector has found. It answers three kinds of question: what each venue publishes (contents), which
files there are (an S3-style listing per venue), and which slice of it a consumer wants (lenses). Every
endpoint is in [CATALOG-API.md](../modules/CATALOG-API.md); lenses are in
[CATALOG-LENSES.md](../modules/CATALOG-LENSES.md). This page is how it is built.

## One database, one writer per table

**The database is prospector's.** Prospector creates `catalog.db`, migrates it, and writes every file,
series, survey and rollup row. The catalog opens the same file from the same host directory, and writes
one table: `lens`.

**Lenses are written here because a lens is a consumer's choice**, not something collection knows or
acts on. Prospector never reads one. Keeping them beside the API that reads through them means nothing
about collection changes when a consumer changes its mind.

**A report of what was downloaded is not a lens, so it is not written here.** A file's state is
prospector's: settling a report means asking the venue about any file the downloader says failed or came
wrong, and only prospector holds the adapters to ask with. So `POST /listings/:venue/report` is forwarded
to prospector's private reports API as sent, with the token, and prospector's answer is returned as is.
Where prospector does not answer, the report is a `502`; the downloader loses nothing, since the files are
listed again and reported on the next walk.

**SQLite in WAL mode lets the two processes share the file**, through shared memory, which is why they
must run on the same host and never over a network filesystem. Two rules follow from sharing:

- **Reads stay short.** An open read transaction stops prospector's checkpoints, and the write-ahead log
  grows for as long as it lasts. So every view pages, or answers from patterns, series and the rollups,
  never from a walk of `file` in one statement.
- **A lens write waits rather than fails.** `busy_timeout` is five seconds, so a lens saved while
  prospector is mid-transaction waits its turn.

**It creates nothing.** Until the file exists it waits and says so, so on a fresh deployment it simply
comes up after prospector has built the database.

**Nothing is shared in code with prospector.** The queries are this service's own, written against the
same tables, and its tests build their own copy of the schema. Some vocabulary is therefore stated in
both places: the variant levels, the grains, the canonical key. The table shapes are the contract
between the two services.

## Contents

Every contents answer is a fold over one read of a venue's patterns and series, which are thousands of
rows where files are hundreds of millions. Markets, shapes and instruments are projections of the same
rows, so no two levels can disagree about whether a retired pattern counts. Venue totals come from
`rollup_venue`.

**Under a lens, a venue's figures are the lens's**, off `rollup_series` over every series the lens
selects: size, first and last month, and how many series hold a file inside it. They come from the
lens's held scope and one pass over the rollup, one statement per distinct span with the series handed
to SQLite as a group — never a round trip per series, and never a second read of the series registry.
On the full catalog that is a few seconds while the scope is resolved and about one while it is held.

## Listings

**A venue's files as one bucket, keyed by what each file is**, in byte order, so the last key of a page
is the whole cursor. The order is built rather than sorted: shelves (`market/dataset[,variant]/`), then
months, then symbol folders, each compared with its trailing `/` (`klines,1m/` sorts before `klines/`
because `,` is below `/`). Only the files of one symbol in one month are sorted, a handful at a time. A
prefix wholly before the cursor is skipped without reading anything under it.

**The shape of a venue is held for a minute**: its shelves and symbol folders are derived from the
series registry, which every page would otherwise fold again.

**A lens narrows the walk, not the result.** Its scope says which series it lets through and over which
months, so a series or month outside it is never read.

**Two files with one key is a catalog bug**, not something to settle here: prospector's `accepts` and
transforms exist so that one version of a file is offered. Should one get through, it is logged and
listed once, so paging still ends.

## Lenses

A lens is resolved once into its **scope** (for each venue, the series it lets through and the date
spans of each) and held for a minute, dropped the moment the lens is edited. Everything that reads
through a lens reads that scope, so a listing, a count and a size all agree. The code is `lenses/lens.ts`
(definitions, checking, resolving, sizing), `lenses/spans.ts` (the date arithmetic) and
`lenses/scope.ts` (the held scope, and series seen through it).

## Configuration

See the [service README](../../services/catalog/README.md).
