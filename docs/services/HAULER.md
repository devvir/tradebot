# Hauler

Hauler brings catalogued venue files to disk under canonical names. Prospector
establishes what every venue publishes; hauler walks each venue's listing over
the [catalog API](../modules/CATALOG-API.md), fetches what it lists, verifies it,
and reports what became of it.

Everything it does follows from one division: **prospector owns what exists, and
hauler owns what is on disk.** Neither writes the other's conclusions, and where
they disagree the disagreement stays visible rather than being resolved by
whichever wrote last.

## What it is not

- **It does not discover.** The catalog knows what exists. Hauler reads a
  listing and fetches it.
- **It does not know how a venue structures its archive**, nor what a venue
  calls anything. Each object's key is the canonical path it is written at, and
  adding a venue to prospector adds nothing to hauler.
- **It does not decide what to fetch.** A catalog lens does, named in
  `HAULER_LENS`; with none, everything the catalog holds.
- **It keeps no state.** What is on disk and what the catalog says is still owed
  are the whole of it, so a restart simply walks again.

## The layout on disk

```
<archives>/<key>
<key> = venue/market/dataset[,variant]/FL/symbol/YYYYMM/venue|market|dataset[,variant]|symbol|date[.partNN].ext
      | venue/market/dataset[,variant]/@/YYYYMM/venue|market|dataset[,variant]|@|date[.partNN].ext
```

**The key is the catalog's, not hauler's.** The catalog serves every venue as
one bucket keyed by this canonical path, so hauler writes each object at
`<archives>/<key>` and names nothing itself. What follows describes the layout
those keys make on disk.

**The full identity is in the filename.** That is what lets a reader ignore the
directory structure entirely — list files, parse names, never learn where they
live. Which raises the honest question of why there is a hierarchy at all, since
everything could go flat and nothing in the pipeline would care. Two reasons: a
flat archive cannot be *looked at*, and every targeted listing becomes a scan of
the whole thing rather than a descent into the part you meant. The path is for
people and for narrowing; the filename is for programs.

**Positional, not `key=value`.** The vault is read by a query engine that
harvests `key=value` from any path position; the archives are read by code that
knows the shape. So a level means what its position says, and the depth never
varies.

| part | | |
|---|---|---|
| `venue` | `bitget` | |
| `market` | `perp` | canonical; a venue with one market still names it |
| `dataset` | `klines,1m` | canonical, **with its variants** — `books,500,incremental`; no comma where a dataset has none |
| `FL` | `B` | the symbol's first letter, `_` for anything that is not a Latin letter |
| `symbol` | `BTCUSDT` | the venue's own name for the instrument |
| `@` | `@` | in place of `FL/symbol`, where one file carries every instrument |
| `YYYYMM` | `202506` | the month |
| `date` | `20250601` | the date covered, **at the grain it covers** |
| `.partNN` | `.part101` | **only** where a period is split across files |

**The date's own length carries its grain** — `202506` monthly, `20250601`
daily — so nothing else has to say it. A part is where a venue splits a period:
bitget cuts a day of trades every 100,000 rows and numbers the pieces, and gate
files its books by the hour. It sits before the extension, as a downloaded
piece's name would carry it.

**`FL` is a filesystem device, not a fact about the data**, which is why it is a
bare segment rather than a labelled one: a few dozen directories per letter
instead of thousands side by side.

**Separators are `|` between fields and `,` inside the dataset descriptor.**
Measured across every symbol in the catalog — bitget `$0-9A-Z`, okx
`-_0-9A-Za-z` — neither character occurs, which is the property that matters.
Bitget symbols do contain `$`, so these names need shell quoting whatever
separator is chosen.

### What a canonical name discards, and why it does not matter

A canonical name throws away the venue's own filename, which was the only thing
on disk tying a file to the URL it came from.

**The catalog holds that link.** `(venue, market, dataset, symbol, period)`
identifies the series, and the series and the date identify the pattern, which
rebuilds the URL. So provenance is preserved where provenance belongs, and the
filesystem is free to be canonical.

### The instrument comes before the month

**The order on disk is the order of the catalog's listing**: series prefix, then
date. That is what lets a page of the listing be one indexed query, so the layout
follows it.

**An instrument's history is one directory** (`…/FL/symbol/`), with its months
beneath it. **A month of a dataset is not**: it is the `YYYYMM` directory under
every symbol, and under the bucket, found with two globs and moved one directory
at a time:

```
venue/market/dataset/*/*/YYYYMM/     every instrument
venue/market/dataset/@/YYYYMM/       the venue-wide file
```

**The bucket is a level shallower, on purpose.** `@` is only ever the venue-wide
file, so it needs no letter folder, and it sorts below every letter, so it sits
first in its dataset rather than lost among thousands of instruments. The cost is
the second glob, which anything gathering a month must not forget.

The cost is directories: a month of one symbol's daily files is about thirty, so
roughly 2.3M leaf directories across a catalog of ~70M files — about 1% of the
volume's inodes.

## Walking a listing

For each venue — every one the catalog holds files for, or `HAULER_VENUES` — hauler pages
through `GET /listings?prefix=<venue>/&pending=true`, 1,000 keys at a time, resuming after
the last key of each page. `pending=true` asks only for files not yet
downloaded, and `HAULER_LENS` travels as `x-catalog-lens`, so the catalog leaves
everything else out of the listing and nothing here filters. Each object's
`Url` is the whole address of the file, and a key outside the venue asked for
is refused rather than written.

**The venue list is asked for without the lens.** Only the names are wanted, a
venue the lens lets nothing through from simply lists nothing, and the lensed
venue list sizes the lens for every venue, which costs the catalog seconds.

**The next page is asked for while this one is fetched**, so listing is never
what anything waits on. Within a page, `HAULER_CONCURRENCY` files are fetched at
once; venues walk independently and never wait on each other.

**A file added behind the cursor is found by the next walk**, as on any bucket.

**Nothing is fetched below `HAULER_MIN_FREE_GB`** of free space on the archives' volume. The
volume is looked at before each file, at most once a second; once it is low no new file is taken,
the ones in flight finish and are reported, and the walk ends saying so. The venue is tried again
after the long wait, so freeing space is all it takes to resume.

**A walk says what it is doing.** Each walk says when it asks the catalog what is owed, when the catalog has answered, and
what each page came to — so a quiet log means nothing is happening, not that something is
unlogged.

### When it walks again

Each venue walks on its own loop. After a walk that brought any file to disk —
fetched, or found there already — the next one starts **5 minutes** later: a
backfill in progress keeps cataloguing more. After a walk that found nothing to
do, **30 minutes**: new files may be landing outside the lens, and asking often
would only list nothing.

## Verifying what was fetched

The listing carries each file's size and ETag, and every file is checked
against both before it is called done:

| the file | matches | |
|---|---|---|
| already on disk | yes | **touched**, and reported as downloaded |
| already on disk | no | **moved aside** as `.bak`, then fetched again |
| just fetched | yes | downloaded |
| just fetched | no | **reported as a mismatch**, nothing kept |

**Nothing appears at its final path until it has been checked.** A download
lands in `.hauler-tmp` at the archives' root, under a name that is a digest of
its destination, and is renamed into place only once it agrees with the listing;
verifying after the rename would leave a truncated file at the real path, where
every later pass would see it present and skip it.

### Adopting an archive that already exists

The first row is what adopts files already on disk with no seeding step: a file
present and correct is reported as downloaded whatever the catalog believed.

**Touching is deliberate.** The file's modification time becomes the pass's
date, so after a pass every file the catalog accounts for carries that date. A
file still showing an older one is a file nothing listed — misfiled, withdrawn,
or junk — and finds itself by its date alone.

**A file that disagrees is kept, never deleted.** It is renamed beside itself to
`<name>.bak`, or `.bak.2`, `.bak.3` where that is taken, and fetched again. Real
updates to a published archive are rare; whichever this turns out to be, it is
there to read.

## Reporting

After each page, hauler posts what became of it to `POST /listings/report`, by
each object's Key and through its lens: `downloaded` (fetched, or present and
correct), `failed` (the venue answered `404` or `410`, or `403` on every attempt), and `mismatched`
(with the size actually received).

**A `207` names keys the catalog would not settle** — one naming no file, or one
the lens does not let through. Each is logged as an error and not sent again:
neither mends itself by asking twice, and both mean the catalog and hauler
disagree about what was listed.

**Only the venue's own answer makes a file `failed`.** A `404` or a `410` does
at once. A `403` is how a venue turns *us* away as often as how a bucket hides a
file it lacks, so it is tried again like any other failure, and reported as
failed only where it answers every attempt — the catalog knows which a venue
means, and rules. A connection that never opens, a DNS lookup that fails, a
`5xx` or a `429` say nothing about the file, only about the way to it. Those are
tried three times, with waits drawn up to 5 and then 10 seconds, and if they
persist the file is left out of the report entirely: it stays owed and is listed again on the next walk. A
walk's log line counts them as `unreached`. Reporting them as failures had
prospector asking the venue about hundreds of files it was serving perfectly
well, during a burst of connect timeouts on this machine's side.

**A refusal stands the whole venue down.** A `403` or a `429` is aimed at the
address as often as at the file, and every request sent through a refusing
address is refused too — some venues keep refusing for minutes after the burst
that tripped them. So the venue's fetches all wait: for as long as its
`Retry-After` says, on any answer that carries one, and two minutes otherwise.
Other venues carry on. The rule is the same for every venue, and is logged once
per stand-down as `Turned away — standing the venue down`. Hauler sets no rate
of its own; a venue that keeps refusing is a sign to lower
`HAULER_CONCURRENCY`.

**The caller reports problems; prospector rules on them.** The catalog forwards
each report to prospector, which owns a file's state. A failed file is checked
against the venue and either stays owed or is ruled absent; a mismatch
is confirmed the same way, and what the venue says is what gets recorded.

**Reporting is not transactional with the download, on purpose.** A file
fetched but never reported is listed again on the next walk, found on disk, and
reported then.

**A connection that fails is tried again**, three times with a short wait
between: the catalog closes idle keep-alive connections, and is gone for a few
seconds while it restarts. An answer is never retried — a `4xx` or `5xx` is the
catalog's verdict. Both requests are safe to repeat: a listing is a read, and a
file reported twice is recorded once.

## Stopping

**A stop takes no new file and abandons none.** The files already downloading
finish, the page reports what it got through, and only then does the process
exit. The largest files take minutes on a slow link, which is why the compose
file gives a stop fifteen minutes rather than docker's ten seconds.

**A start removes every unfinished download** before it fetches anything, which
is deleting one directory: every partial is in `.hauler-tmp`, on the archives'
own volume so that the rename into place stays one step.
A partial only becomes a file by being verified and renamed, so one left over is
a download that never finished — a stop that outlived its grace period, a crash,
a pulled plug — and the next walk fetches that file again. `.bak` files are left
alone: they are whole files that disagreed, kept for a person to read.

## Configuration

See the service README for the environment. `HAULER_LENS` names a lens by its
slug; an unknown one is refused by the catalog, so the walk fails loudly rather
than quietly hauling everything.
