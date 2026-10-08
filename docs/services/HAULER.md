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
| `dataset` | `klines,1m` | canonical, **with its variants** — `books,incremental,500`; no comma where a dataset has none |
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
everything else out of the listing and nothing here filters. Each object names
its server and its `Path` there — [which address](#which-address-a-file-is-fetched-from) it is
fetched from is decided here — and a key outside the venue asked for is refused rather than written.

**The venue list is asked for without the lens.** Only the names and the addresses are wanted, a
venue the lens lets nothing through from simply lists nothing, and the lensed
venue list sizes the lens for every venue, which costs the catalog seconds.

**Pages are listed ahead of the fetching and held ready** — three of them — and the files of every
page held are one queue, fetched as turns come up. So listing is never what anything
waits on, and neither is a page's end: its last slow files hold up nobody, the next page's being
fetched already. A page is reported the moment its last file settles.

**Files of 50 MB or more are fetched six at a time**, across every venue, the size being the listing's.
A large file is bounded by the link, not by the wait for an answer: a hundred at once arrive no sooner
than six, each takes as long as all of them, nothing else is fetched meanwhile, and a stop loses every
one part-done. Six share the link and the rest of the budget stays with the small files. Each is
logged as it starts (`Downloading a large file`), since it is minutes before anything else is said of it.

**`HAULER_CONCURRENCY` is how many files are in flight across every venue together.** What it protects
is the link: every connection goes through one router whichever venue it is to, and a budget for each
venue would multiply by the venues walking. A venue walking alone has all of it; several share it in
the order their files asked.

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
| just fetched | no | **reported as a mismatch**, and held in scratch |

**A download that differs is held, not thrown away.** It is usually the venue's newer file: the
catalog is told, asks the venue, and takes what the venue says, after which the file is owed again at
its new size and checksum. When it comes round, what was fetched the first time is set against what
the catalog says now — agreeing, it is given its place and nothing is fetched; not, it is dropped and
fetched like any other. What is held is a short list in memory, by venue and key, so nothing is
looked for on disk. It is dropped for a venue that owes nothing, and with the rest of scratch as the
service starts.

**Nothing, where the catalog says there is something, is not a difference**: an empty body is a
transfer that failed, tried again like any other, and never reported.

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

## Which address a file is fetched from

A venue's server can answer at more than one address: its bucket, and a CDN in front of it, the same
files under the same paths. At startup hauler asks the catalog where each venue's servers answer
(`GET /venues`, `hosts`); a listed file names its server and its path, and its URL is one of the
server's addresses followed by the path.

Which address is faster depends on where hauler runs, on what a CDN has cached and on the hour, so it
is measured as it goes. Each file is asked of an address chosen at random, by weight:

- **An address is scored by what it delivers while it is delivering**: bytes per second of the time
  its requests were in flight, less its share of requests that failed. How often it was chosen does
  not enter into it, so an address given little work is not marked down for doing little.
- **Weights move once a minute, and half way.** Each look blends the last minute into the score — the
  first time, into the server's average for that minute — and only where the address answered at
  least 20 requests in it. A slow minute does not turn the choice
  round; several agreeing ones do. Shares are the scores in proportion, logged as `Hosts reweighed`
  when one moves by five points or more.
- **A refusal does not wait for the minute.** An address that answers `429`, or any answer saying how
  long to wait, is out of rotation at once: for as long as it said, or three minutes, doubling each
  time it does it again, to half an hour. So is one that answers `403` five times running with
  nothing delivered between — one `403` can be a file an edge will not serve, five are a block.
  Logged as `Turned away — out of rotation`.
- **No address is left out for good.** The least any address in rotation gets is one request in a
  hundred. One that has sat at that floor for half an hour is given a tenth of the work for five
  minutes, its old score forgotten, to show what it does now; one that was taken out comes back the
  same way.

**A file is gone only where every address in rotation says so.** A `404` from one address has the
file asked of the next at once, and it is `failed` when none is left to ask. For anything else, only
the listed address — the first of a server, the one the catalog lists and probes — speaks for the
venue: another that refuses a file or fails is an address doing badly, marked down, and the file is
asked of one not tried for it yet, without waiting.

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

**A refusal takes the address that refused out of rotation.** A `403` or a `429` is aimed at the
address as often as at the file, and every request sent through a refusing address is refused too.
So that address is left alone — see [which address](#which-address-a-file-is-fetched-from) — and the
file is asked elsewhere. Where a server has one address, its fetches wait for it. Hauler sets no rate
of its own; a venue that keeps refusing is a sign to lower `HAULER_CONCURRENCY`.

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

**A stop is answered within thirty seconds, whatever is downloading.** It takes
no new file; the files already downloading that finish in that time are
reported, the page reports what it got through, and the process exits. Thirty
seconds is the compose file's `stop_grace_period`: a stop is an order, and
matters more than a download. A file still downloading when it runs out is cut
short with the process and fetched again by the next walk — the largest take
minutes on a slow link, so a stop does not wait for them.

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
