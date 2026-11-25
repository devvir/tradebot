# Catalog

The catalog service is the public API over what prospector has catalogued. It answers three kinds of
question: what each venue publishes (contents), which files there are (one S3-style bucket, every
venue under its own prefix), and which part of it a consumer wants (lenses). Every endpoint is in
[CATALOG-API.md](CATALOG-API.md); lenses are in
[shared/lenses/README.md](../../shared/lenses/README.md). This page is how it is built.

## One database, one writer

**The database is prospector's, and prospector is the only thing that writes it.** It creates
`catalog.db`, migrates it, and writes every row of every table, lenses included (see
[PROSPECTOR-STORAGE.md](PROSPECTOR-STORAGE.md#one-file-one-writer)). The catalog opens the same file from the same host directory
**read-only**: a statement that tries to write is refused by SQLite itself, so the rule holds whatever
the code does. A lock met for a moment, while prospector recovers or checkpoints the log, is waited on
for up to two seconds.

**Whatever the catalog is sent to be stored, it forwards to prospector's private API**, at
`http://prospector:8080`: a lens being made, replaced or removed, and a report of what was downloaded.
What it keeps for itself is everything that only reads: checking a lens's definition, sizing it,
saying what it selects.

**A lens is checked here and stored there.** A write's slug, name and note are checked, and its
definition as [shared/lenses/README.md](../../shared/lenses/README.md#what-is-refused) says; what is wrong is
answered, and only a write that holds is handed over. Prospector's answer is relayed as it is, status
and body; an answer that is not JSON is logged and answered with an error of the same status, or `502`
where prospector failed.

**A report of what was downloaded is settled there too.** A file's state is prospector's, and only
prospector holds the adapters to ask a venue about a file reported failed or wrong. Keys and lenses
are the catalog's, and prospector names a file by its id. So the catalog resolves each key to its file
(building the keys of the series' files of that date and keeping the one that matches, never parsing a
name), checks it against the lens, and forwards the ids to prospector's private reports API. Keys it
cannot resolve, or the lens refuses, are answered in a `207` and never reach prospector. A report
prospector does not settle changes nothing: its files stay pending and are listed again.

**A call to prospector is made up to three attempts in all**, waiting half a second and then a second
between them: prospector closes idle keep-alive connections, so a request now and then lands on one as
it goes.

- **A dropped connection is retried** (refused, reset or closed before an answer) where sending twice
  does what sending once does: a report, which settles idempotently, and a lens replaced or removed.
  A lens being created is retried only where the connection was refused, which it never reached
  prospector over.
- **An answer is never retried**, whatever its status: it is prospector's verdict. Neither is a call
  that timed out (15 s for a lens write, 5 minutes for a report), which prospector may still be
  carrying out.

So a `502` means prospector gave no answer, in time or at all, or failed. On a report, prospector's
`4xx` is a `400 ReportRefused` and its `5xx` a `502 CollectorError`; no answer is
`502 ServiceUnavailable`. On a lens write, no answer is a `502`, and does not say that nothing was
stored: a write that timed out may still land.

**SQLite in WAL mode lets the two processes share the file**, through shared memory, which is why they
must run on the same host and never over a network filesystem. One rule follows from sharing:
**reads stay short.** An open read transaction stops prospector's checkpoints, and the write-ahead log
grows for as long as it lasts. So every view pages, or answers from patterns, series and partitions,
never from a walk of `file` in one statement.

**It creates nothing.** Until the file exists it says so and looks again every ten seconds, so on a
fresh deployment it comes up after prospector has built the database.

**Nothing of the catalog's queries is shared in code with prospector.** What a lens is comes from
`@tradebot/lenses`, which both import (see [Lenses](#lenses)). The queries are this service's own,
written against the same tables; its tests build a scratch database from prospector's own schema. The
grains are stated in both services, and each series' listing prefix is prospector's while the rest of
the key is built here. The table shapes are the contract between the two services.

## Contents

**A venue's markets, shapes and instruments are folds over one read of its series**, joined to their
patterns and slices: thousands of rows where files are hundreds of millions. They are projections of
the same rows, so no two levels can disagree about whether a retired pattern counts. The venue list is
sums over each venue's partitions, which carry their own counts, and one count of series per venue.

**Under a lens, a venue's files, bytes, pending and first and last month are one query**: the lens's
`lens_member` rows joined to their partitions and grouped by venue, so nothing evaluates a rule. Its
series are counted by their dates against the months the lens lets through for their slice, without
reading a file. A venue's markets, shapes and instruments under a lens keep only the series with a file
inside the lens's months, each dated by the oldest and newest file it holds there: two indexed reads of
`file` for a series the lens cuts (more where a span it reaches holds none of its files), none for one
the lens holds whole. Which figures are the lens's is in
[CATALOG-API.md](CATALOG-API.md#reading-through-a-lens).

**A venue's partitions are their own view**: each slice once, with its months inside it. Through a lens
it is the partitions joined to the lens's `lens_member` rows, and no others. It is a read of a few
thousand rows, so it is not paged.

**Settled is worked out when it is asked about, and only then**; what it means is in
[CATALOG-API.md](CATALOG-API.md#partitions). It takes two facts that are not on the
partition: today's date, against which a month must have ended more than 15 days ago (`SETTLE_DAYS`),
and the start of the venue's open run. A run is the venue's, whichever hosts it reaches, and the `run`
table holds it as several unfinished rows, one per host and part of the tree; its start is the
earliest `started` among them, read by venue name and never by host. `settled-before` adds a second
limit on the version, and the two are one comparison, against whichever is earlier. The open run is
read once per request, and not at all for a caller that asks for neither.

## Listings

**One bucket, every venue's files, keyed by what each file is**; the key is in
[CATALOG-API.md](CATALOG-API.md#the-key). It leads with the series' prefix
(`venue/market/dataset[,variant]/F/symbol/`, or `venue/market/dataset[,variant]/@/` for the
market-bundle file), then the month, then a name ending in the date and any part. So keys sort by
prefix, then date, then part, and that is exactly how the rows are indexed.

**A page is one query.** Each series carries its prefix (`series.prefix`, written by prospector as the
series is created) and the column is indexed. A page walks that index from where the cursor or `prefix`
starts, reads each series' files through `(series_id, date)`, and stops as soon as it has one more key
than it hands out. Nothing behind the cursor, past the prefix, or outside the lens is read, and nothing
is held between pages: S3's marker is the whole cursor, read back into a series prefix and a date.

**The only sort is within one prefix**, where several series meet: a monthly and a daily rendering of
one instrument, or two eras of it. Their files are one stream by date, and SQLite sorts them one prefix
at a time as the walk passes, so a page costs about the files left in the prefixes it reaches.

**Through a lens**, the slices the lens holds a partition of are worked out once per page, and only
their series are walked. For each, the partitions of its slice that are in `lens_member` say which
months to read, and its files are read one month at a time. A series of any other slice costs one
lookup. One partition named on a listing is read the same way, as a lens of one.

**A walk of what is owed reads only what owes.** A partition counts its own pending files, so the walk
first takes the slices with a partition still owing one, and within them only those partitions, read
through the index of files not yet downloaded.

**A part is read through the pattern.** Where a venue splits a period, the pattern says `{PART}`, and
the part is what the path holds there: an hour of gate's books, a numbered piece of a bitget day.
Without it every piece of a day would carry one key.

**Two files with one key is a catalog bug**, not something to settle here: prospector's `accepts` and
transforms exist so that one version of a file is offered. Should one get through, it is logged and
listed once, so paging still ends; a report naming that key settles the first.

## Lenses

**A lens is read as what it lets through**: rows of `lens_member`, one per partition (see
[shared/lenses/README.md](../../shared/lenses/README.md#resolving-one)). The listing, the contents, the size and
a report's check all read those rows, so they agree and none of them evaluates a rule. Only a
definition being edited, which has no rows yet, is resolved as it stands.

What a lens is (its rules, how they are evaluated, how a definition is checked and sized, how a lens
and its rows are stored) is the `@tradebot/lenses` package (`shared/lenses`). The catalog calls its
reads: listing lenses, the options a rule is written against, checking a definition, sizing it, saying
what it selects. The code here is only how the catalog reads *through* a lens: `lenses/figures.ts` (a
saved lens's figures), `lenses/scope.ts` (the rows as the contents read them), `lenses/requested.ts`
(which lens a request names) and `prospector.ts` (handing a write over).

## What is held between requests

Most of what the catalog answers is read when it is asked. Three things are held:

- **A venue's series, for a minute** (`SERIES_MS` in `queries.ts`). Every contents view folds them, and
  a venue can have a hundred thousand. So a venue's markets, shapes and instruments, and a venue's
  series count under a lens, can be up to a minute behind prospector.
- **The lens options, for five minutes**, held by `@tradebot/lenses` (see
  [shared/lenses/README.md](../../shared/lenses/README.md#the-definition)).
- **A lens's scope**, its slices and the months of each as read off `lens_member`, until the lens is
  saved again or its `partitions_through` moves. Each request reads the lens's `updated_at` and
  `partitions_through` and reads the scope again where either differs from what was held.

Everything else is read per request: the lens a request names, venue totals and series counts,
partitions, a lens's figures, the open run, every listing page and every report's keys.

## Requests nobody waits for

**One request runs at a time**, so a slow one queues the rest, and a client that has moved on may
cancel what it no longer wants. Before any request's work starts, the catalog yields once and drops it
if its connection has closed meanwhile. The check is on the connection the catalog itself sees: a
client behind a proxy has gone when the proxy closes its connection. A request already running cannot
be stopped: its work is synchronous.

## Configuration

See the [service README](../../services/catalog/README.md).
