# Hauler

Hauler brings catalogued venue files to disk under canonical names. Prospector
establishes what every venue publishes; hauler walks each venue as a bucket the
catalog serves, fetches what it lists, verifies it, and reports what became of
it.

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
<archives>/venue/<key>
<key> = market/dataset[,variant]/YYYYMM/FL/symbol/venue|market|dataset[,variant]|symbol|period[|part].ext
```

**The key is the catalog's, not hauler's.** The catalog serves each venue as a
bucket keyed by this canonical path, so hauler writes each object at
`<archives>/<venue>/<key>` and names nothing itself. What follows describes the
layout those keys make on disk.

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
| `YYYYMM` | `202506` | the month, which makes a partition one directory |
| `FL` | `B` | the symbol's first letter, `_` for anything that is not one |
| `symbol` | `BTCUSDT` | `@` where one file carries every instrument |
| `period` | `20250601` | the date covered, **at the grain it covers** |
| `part` | `101` | **only** where a period is split across files |

**The period's own length carries its grain** — `202506` monthly, `20250601`
daily, `2025060113` hourly — so nothing else has to say it. `part` is rare: one
venue uses it for one dataset, since bitget cuts a day of trades every 100,000
rows and reaches `_101`.

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

### The month is a level, so a partition is a directory

The unit downstream is `venue + market + dataset + month`: stocker imports one,
cold storage evicts and restores one. With the month as a
level **that partition is exactly one directory** — matched without a walk, moved
with one rename, restored the same way.

The alternative, `year`, spreads a partition across every symbol directory of
that year, so locating one becomes a filtered walk and evicting one becomes a
`find` and many renames.

The cost is directories, and it is smaller than it looks: a month of one symbol's
daily files is about thirty, so roughly 2.3M leaf directories across a catalog of
~70M files — about 1% of the volume's inodes.

## Walking a bucket

For each venue — every one the catalog knows, or `HAULER_VENUES` — hauler pages
through `GET /buckets/:venue?pending=true`, 1,000 keys at a time, resuming after
the last key of each page. `pending=true` asks only for files not yet
downloaded, and `HAULER_LENS` travels as `x-catalog-lens`, so the catalog leaves
everything else out of the listing and nothing here filters. Each object's
address is the page's `BaseUrl` joined to its `Url`.

**The next page is asked for while this one is fetched**, so listing is never
what anything waits on. Within a page, `HAULER_CONCURRENCY` files are fetched at
once; venues walk independently and never wait on each other.

**A file added behind the cursor is found by the next walk**, as on any bucket.

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
lands as `<name>.part` and is renamed only once it agrees with the listing;
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

After each page, hauler posts what became of it to
`POST /buckets/:venue/report`, by each object's `FileId`: `downloaded` (fetched, or present and
correct), `failed` (would not download after three attempts), and `mismatched`
(with the size actually received).

**The caller reports problems; the catalog rules on them.** A failed file is
checked against the venue and either stays owed or is ruled absent; a mismatch
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

**A start removes every `.part` under the archive** before it fetches anything.
A partial only becomes a file by being verified and renamed, so one left over is
a download that never finished — a stop that outlived its grace period, a crash,
a pulled plug — and the next walk fetches that file again. `.bak` files are left
alone: they are whole files that disagreed, kept for a person to read.

## Configuration

See the service README for the environment. `HAULER_LENS` names a lens by its
slug; an unknown one is refused by the catalog, so the walk fails loudly rather
than quietly hauling everything.
