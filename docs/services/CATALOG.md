# Catalog

The catalog service is how everything outside the [archives module](../modules/ARCHIVES.md) reads what
prospector has found. It answers three kinds of question: what each venue publishes (contents), which
files there are (one S3-style bucket, every venue under its own prefix), and which part of it a consumer wants (lenses). Every
endpoint is in [CATALOG-API.md](../modules/CATALOG-API.md); lenses are in
[CATALOG-LENSES.md](../modules/CATALOG-LENSES.md). This page is how it is built.

## One database, one writer

**The database is prospector's, and prospector is the only thing that writes it.** It creates
`catalog.db`, migrates it, and writes every row of every table. The catalog opens the same file from
the same host directory **read-only**: a statement that tries to write is refused by SQLite itself,
so the rule holds whatever the code does. Two writers on one file wait on each other's locks, and the
one that waits longest fails.

**Whatever the catalog is sent to be stored, it forwards to prospector's private API**: a lens being
made, replaced or removed, and a report of what was downloaded. What it keeps for itself is everything
that only reads — checking a lens's definition, sizing it, saying what it selects.

**A lens is checked here and stored there.** A write is validated against what the venues publish,
answered with what is wrong where it cannot be stored, and only then handed over; prospector's answer
is relayed as it is. Where prospector does not answer, the write is a `502` and nothing was stored.

**A report of what was downloaded is settled there too.** A file's state is
prospector's: settling a report means asking the venue about any file the downloader says failed or came
wrong, and only prospector holds the adapters to ask with. A downloader reports by Key, and through a
lens; Keys and lenses are the catalog's, and prospector names a file by its id. So the catalog resolves
each key to its file — building the keys of the series' files of that date and keeping the one that
matches, never parsing a name — checks it against the lens, and forwards the ids to prospector's private
reports API. Keys it cannot resolve, or the lens refuses, are answered in a `207` and never reach
prospector. A connection prospector drops is tried again, three times: it closes idle keep-alive
connections, so a request now and then lands on one as it goes, and settling twice is harmless. Where
prospector still does not answer, the report is a `502`; the downloader loses nothing, since
the files are listed again and reported on the next walk.

**SQLite in WAL mode lets the two processes share the file**, through shared memory, which is why they
must run on the same host and never over a network filesystem. One rule follows from sharing:
**reads stay short.** An open read transaction stops prospector's checkpoints, and the write-ahead log
grows for as long as it lasts. So every view pages, or answers from patterns, series and partitions,
never from a walk of `file` in one statement.

**It creates nothing.** Until the file exists it waits and says so, so on a fresh deployment it simply
comes up after prospector has built the database.

**Nothing is shared in code with prospector.** The queries are this service's own, written against the
same tables, and its tests build their own copy of the schema. Some vocabulary is therefore stated in
both places: the variant levels, the grains, the canonical key. The table shapes are the contract
between the two services.

## Contents

Every contents answer is a fold over one read of a venue's patterns and series, which are thousands of
rows where files are hundreds of millions. Markets, shapes and instruments are projections of the same
rows, so no two levels can disagree about whether a retired pattern counts. Venue totals are sums
over the venue's partitions, each of which carries its own counts.

**Under a lens, a venue's figures are the lens's**: its size and its first and last month are one
query, the lens's `lens_member` rows joined to their partitions and grouped by venue, so nothing
evaluates a rule. Its series are those dated inside the months the lens lets through for their
slice, counted off the series' own first and last file.

**A venue's partitions are their own view**: each slice once, with its months inside it, each month
with its counts, its version and when that last moved. Through a lens it is the lens's partitions
and no others. It is a read of a few thousand rows, so it is not paged.

**Settled is worked out when it is asked about, and only then.** A caller can narrow the view to
settled partitions, and the answer takes two facts that are not on the partition: today's date and
the venue's open runs. A partition is settled when both hold:

- **Its month ended more than 15 days ago.** A venue goes on publishing a period's files for days
  after the period closes. The same 15 days decide, in prospector, when a file that has not appeared
  stops being waited for, so a month is taken as closed here when nothing is being waited for in it.
- **Its version last moved before the venue's open run started.** A run that has changed a
  partition may not be done with it, and during a backfill it usually is not. A run that stopped
  half way counts the same as one at work: what it would have found next is still unfound. A
  partition the open run has not changed holds all that an earlier, completed run found, so it was
  whole at least once.

A run is the venue's, whichever hosts it reaches, and a venue has one open or none. The `run` table
holds that one run as several rows — one per host and per part of the tree — so the run's start is
read as the earliest start among the venue's unfinished rows, by venue name and never by host.

Settled is the strongest thing that can be said, and it is not a promise. A walk can find a change
anywhere in a venue's history, and a republish, a withdrawal or a very late file moves the version
of a partition long settled. Those are rare, and whoever acted on the old version sees the new one.

`settled-before` adds quiet to it: settled, and unchanged since an instant the caller names. The two
limits on the version are one comparison, against whichever is earlier. The open run is a single
read of `run` through its index of unfinished rows, made once per request and not at all for a
caller that asks for neither.

## Listings

**One bucket, every venue's files, keyed by what each file is** — see the key in
[CATALOG-API.md](../modules/CATALOG-API.md#listings). The key leads with the series' prefix
(`venue/market/dataset[,variant]/F/symbol/`, or `…/@/` for the venue-wide file), then the month,
then a name ending in the date and any part. So keys sort by prefix, then date, then part, and that is
exactly how the rows are indexed.

**A page is one query.** Each series carries its prefix (`series.prefix`, written by prospector as the
series is created) and the column is indexed. A page walks that index from where the cursor or `prefix`
starts, reads each series' files through `(series_id, date)`, and stops as soon as it has one more key
than it hands out. Nothing behind the cursor, past the prefix, or outside the lens is read, and nothing
is held between pages: S3's marker is the whole cursor, read back into a series prefix and a date.

**The only sort is within one prefix**, where several series meet: a monthly and a daily rendering of
one instrument, or two eras of it. Their files are one stream by date, and SQLite sorts them one prefix
at a time as the walk passes, so a page never waits for more than that.

**Through a lens**, the slices the lens holds a partition of are worked out once per page, and only
their series are walked. For each, the partitions of its slice that are in `lens_member` say which
months to read, and its files are read one month at a time. A series of any other slice costs one
lookup. Measured on 2026-10-04 against the full catalog, a page of a
thousand keys through a lens took about 110 ms.

**A walk of what is owed reads only what owes.** A partition counts its own pending files, so the
walk first takes the slices with a partition still owing one, and within them only those partitions.
An empty answer for a venue of a hundred thousand series took 0.2 s on the same day.

**A part is read through the pattern.** Where a venue splits a period, the pattern says `{PART}`, and
the part is what the path holds there: an hour of gate's books, a numbered piece of a bitget day. A
part must be read: without it every piece of a day would carry one key.

**Two files with one key is a catalog bug**, not something to settle here: prospector's `accepts` and
transforms exist so that one version of a file is offered. Should one get through, it is logged and
listed once, so paging still ends.

## Lenses

**A lens is read as what it lets through**: rows of `lens_member`, one per partition (see
[CATALOG-LENSES.md](../modules/CATALOG-LENSES.md#resolving-one)). The listing, the contents, the size and
a report's check all read those rows, so they agree and none of them evaluates a rule. Only a
definition being edited, which has no rows yet, is resolved as it stands.

What a lens is — its rules, how they are evaluated, how a definition is checked and sized, how a lens
and its rows are stored — is the `@tradebot/lenses` package (`shared/lenses`). The catalog calls its
reads: listing lenses, checking a definition, sizing it, saying what it selects. The code here is
only how the catalog reads *through* a lens: `lenses/figures.ts` (a saved lens's figures),
`lenses/scope.ts` (the rows as the contents read them), `lenses/requested.ts` (which lens a request
names) and `prospector.ts` (handing a write over). `partitions.ts` reads slices and partitions for all of them.

## Requests nobody waits for

**One request runs at a time**, so a slow one queues the rest — and an editor that has moved on
cancels what it no longer wants. Before any request's work starts, the catalog yields once and drops
it if its connection has closed meanwhile. A request already running cannot be stopped: its work is
synchronous.

## Configuration

See the [service README](../../services/catalog/README.md).
