# Hauler

Hauler brings catalogued venue files to disk under canonical names. It walks each venue's listing over
the [catalog API](../modules/CATALOG-API.md), fetches what the listing says is still owed, verifies it,
and reports what became of it.

Everything it does follows from one division: **the catalog says what exists and what is owed, and
hauler owns what is on disk.** Hauler never decides that a file exists or is gone; it reports what the
venue answered, and the catalog's side rules on it.

## What it is not

- **It does not discover.** The catalog knows what exists. Hauler reads a listing and fetches it.
- **It does not know how a venue structures its archive**, nor what a venue calls anything. Each
  object's key is the path it is written at, so a venue the catalog gains needs nothing of hauler.
- **It does not decide what to fetch.** A catalog lens does, named in `HAULER_LENS`; with none, every
  file the catalog holds. See [Through a lens](#through-a-lens).
- **It keeps no persistent state.** What is on disk and what the catalog says is owed are the whole of
  it, so a restart simply walks again. Some state lives in memory only and starts empty with the
  process: downloads held for the catalog to rule on, each address's score and time out of rotation,
  and the count of each venue's walks.

## Through a lens

`HAULER_LENS` names a catalog lens by its slug. Hauler sends it as `x-catalog-lens` on every listing
and every report, and on nothing else: the venue list is asked for without it. The catalog then lists
only what the lens lets through, and settles a report only for what it lets through, so hauler
filters nothing itself. An unknown slug is refused by the catalog, and each walk fails loudly rather
than hauling everything. What a lens is and how it selects is in
[CATALOG-LENSES.md](../modules/CATALOG-LENSES.md).

**Several haulers split the work by disjoint lenses.** Pending is a property of the file, not of the
lens it was listed through: a file one hauler reports downloaded is no longer pending for any other.
Two haulers whose lenses overlap each miss, in their own archives, what the other fetched first.
Nothing in the catalog keeps them apart; the deployments do, by giving each hauler its own lens, or
its own `HAULER_VENUES`, and its own archives directory. Each hauler needs an archives directory of
its own in any case: a start deletes the directory of unfinished downloads (see [Stopping](#stopping)),
whoever's they are.

## The layout on disk

Hauler writes each listed object at `<archives>/<key>` and derives no name of its own. In the
container `<archives>` is `/data/archives`, so a file lands at, for example:

```
/data/archives/binance/perp/klines,1m/B/BTCUSDT/202001/binance|perp|klines,1m|BTCUSDT|20200101.zip
```

The key grammar, including the letter folder `F` and the market bundle (`@`), is the catalog's:
[CATALOG-API.md](../modules/CATALOG-API.md#listings). A key that is not under the venue being walked,
or that has an empty, `.` or `..` segment, is logged and skipped rather than written.

## Walking a listing

**The venue list and each venue's addresses are read once, at startup**, from `GET /venues`: every
venue the catalog knows, or those named in `HAULER_VENUES`. A venue the catalog gains later is walked
only after a restart. A venue named in `HAULER_VENUES` that the catalog did not know at startup has no
address: its files stay owed, logged per file as having no known address, until a restart. A refusal
of the venue list is asked again every minute; hauler does nothing until it has an answer.

For each venue hauler pages through `GET /listings?prefix=<venue>/&pending=true&max-keys=1000` as
JSON, resuming after the last key of each page. Each object names its server (`Host`) and its `Path`
there; [which address](#which-address-a-file-is-fetched-from) it is fetched from is decided here.

**Pages are listed ahead of the fetching**, up to three pages' worth of files waiting, and the files
of every page held are one queue. Listing is never what anything waits on, and neither is a page's
end: its last slow files hold up nobody, since the next page's files are already being fetched. A page
is reported the moment its last file settles.

**`HAULER_CONCURRENCY` is how many files are in flight across every venue together.** What it
protects is the link: every connection leaves through the same network whichever venue it is to, and
a budget per venue would multiply by the venues walking. A venue walking alone has all of it; several
share it in the order their files asked. A file waiting, for an address or between attempts, gives
its turn back meanwhile.

**Files of 50 MB or more are fetched six at a time**, across every venue, by the size the listing
gives. A large file is bounded by the link, not by the wait for an answer, so more at once arrive no
sooner and a stop loses each one part-done. A large file whose turn is not free waits aside while the
files behind it are fetched. Each is logged as it starts (`Downloading a large file`).

**A server whose every address is out of rotation is waited out.** Its files are put back in the
queue and wait for an address to come back, holding no turn.

**A file added behind the cursor is found by the next walk**, as on any bucket.

**A walk says what it is doing**: when it asks the catalog what is owed, when the catalog has
answered, and what each page came to.

### Space on the archives volume

The volume is looked at before each file, at most once a second. It is low below `HAULER_MIN_FREE_GB`
of free space, with fewer free inodes than 10,000 or half a percent of all (whichever is more), or
for a minute after a write was refused for want of room (`ENOSPC`, `EDQUOT`), which also catches a
quota no look at the volume sees. While it is low no new file is taken, the ones in flight finish and are reported, and the walk
ends saying so. The venue is walked again after the long wait, so freeing space is all it takes.

### When it walks again

Each venue walks on its own loop. After a walk that brought any file to disk, fetched or found there
already, and did not end for want of space, the next one starts **5 minutes** later: a backfill in
progress keeps cataloguing more. After any other walk (nothing to do, the volume low, or a failure,
which is logged), **30 minutes**.

## Verifying what was fetched

The listing carries each file's size and ETag, and every file is checked against both before it is
called done. An ETag is compared as an MD5, without its quotes and in any case; one that is not a
plain MD5 (a multipart ETag, or none) is not evidence either way, and the size alone decides.

| the file | matches | |
|---|---|---|
| already on disk | yes | **touched**, and reported as downloaded |
| already on disk | no | **fetched again**; the file on disk stays until a verified replacement is in hand |
| just fetched | yes | downloaded; whatever was at its path is **moved aside** as `.bak` |
| just fetched | no | **reported as a mismatch**, with the size and MD5 it came as, and held in scratch |

**What is stored is the bytes as served.** Hauler asks with `accept-encoding: identity` and decodes
nothing; redirects are followed, five at most. A connection silent for five minutes fails.

**A body shorter than promised is a transfer that failed**, not a file that differs: shorter than its
own `content-length`, or empty where the listing says the file is not. It is tried again like any
other failure and never reported.

**A download that differs is held, not thrown away.** It is usually the venue's newer file: the report
has the venue asked again, and the file comes back owed at its new size and ETag. When it comes round,
the held download is set against what the listing says now. Agreeing, it is given its place and
nothing is fetched; not, it is dropped and the file fetched like any other. What is held is a list in
memory, by venue and key. Everything held of a venue is dropped after a walk that found nothing owed,
and a download held two walks ago or earlier, its file not listed since, after any walk not cut short
by a stop or a low volume.

**Nothing appears at its final path until it has been checked.** A download lands in `.hauler-tmp`
at the archives' root, under a name that is a digest of its destination, and is renamed into place
only once it agrees with the listing. The file is flushed before the rename and its directory after
it, so a file at its path survives a power cut. An interrupted download leaves only a partial, never
a truncated file at the real path.

**What the disk will not do leaves the file owed**: a download that cannot be written, or a file that
cannot be read, moved aside or given its place, is left out of the report and comes round again.

### Adopting an archive that already exists

The first row is what adopts files already on disk with no seeding step: a file present and correct
is reported as downloaded whatever the catalog believed.

**Touching is deliberate.** Only files listed as owed are checked, so a touched file's modification
time is the walk that confirmed it, and a file hauler downloaded keeps the time it was written. A
file's date says when hauler last wrote or confirmed it.

**A file that disagrees is kept, never deleted.** Once a verified replacement is in hand, the old file
is renamed beside itself to `<name>.bak`, or `.bak.2`, `.bak.3` where that is taken. Where the
replacement is the same bytes, nothing is moved and the file is touched.

## Which address a file is fetched from

A venue's server can answer at more than one address: the one the catalog lists and probes, and
alternatives such as a CDN in front of the same bucket, with the same files under the same paths.
`GET /venues` gives each server's addresses, the listed one first; a file's URL is one of them
followed by the file's `Path`.

Which address is faster depends on where hauler runs, on what a CDN has cached and on the hour, so it
is measured as it goes. Each request goes to an address chosen at random, by weight:

- **An address is scored by what it delivers while it is delivering**: bytes per second of the time
  its requests were in flight, scaled by the share of its requests that succeeded. How often it was
  chosen does not enter into it.
- **Weights move once a minute, and half way.** Each look blends the last minute into the score (the
  first time, into the server's average for that minute), and only where the address answered at
  least 20 requests in it. Shares are the scores in proportion, logged as `Hosts reweighed` when one
  moves by five points or more.
- **A refusal does not wait for the minute.** An address that answers `429`, or any answer carrying a
  `Retry-After`, is out of rotation at once: for as long as it said, an hour at most, or, where it
  said nothing, three minutes, doubling while it keeps on, to half an hour. One that answers `403`
  five times running with nothing delivered between is taken out the same way: one `403` can be a
  file an edge will not serve, five are a block. Logged as `Turned away — out of rotation`.
- **No address is left out for good.** The least any address in rotation gets is one request in a
  hundred. One that has sat at that floor for half an hour is given a tenth of the work for five
  minutes, its old score forgotten; one that was taken out comes back the same way.

**A file is gone only where the listed address and every other in rotation say so.** A `404` or
`410` from one address has the file asked of the next in rotation at once. The file is `failed` once
none is left to ask and the listed address was among those asked; where the listed address could not
be asked, the file stays owed.

**Otherwise only the listed address speaks for the venue.** Another address that refuses a file or
fails is marked down, and the file is asked of one not yet tried for it; once none is left, of the
listed address. A file is given three attempts in all; a `404` or `410` that leaves another address
to ask does not count as one. After an error status or a short body from an alternative the next
attempt goes at once; otherwise it waits a random time up to 5, then up to 10 seconds.

Hauler sets no request rate of its own; a venue that keeps refusing is a sign to lower
`HAULER_CONCURRENCY`.

## Reporting

After each page, hauler posts what became of it to `POST /listings/report`, by each object's Key and
through its lens:

- **`downloaded`**: fetched and verified, present and correct, or a held download the listing now
  agrees with.
- **`failed`**: gone at every address asked, as above, or a `403` from the listed address every
  time it was asked, the last attempt included. A `403` is as often a venue turning a client away as
  a bucket hiding a file it lacks, so it is tried again first, and reported for the venue to be asked
  only where the listed address answered nothing else.
- **`mismatched`**: with the size and MD5 actually received.

**What says nothing about the file is not reported.** A connection that never opens, a lookup that
fails, a `5xx`, a `429`, a short body or a disk that will not take the file: the file is left out of
the report, stays owed, and is listed again on the next walk. A walk's log counts these as
`unreached`. They are not failures: the file is fine, only the way to it is not, and reporting them
would have the venue asked again about files it serves.

**A `207` names keys the catalog would not settle**: one naming no file, or one the lens does not let
through. Each is logged as an error and not sent again; neither mends itself by being sent twice, and
both mean the catalog and hauler disagree about what was listed. A report that fails outright is
logged, and its files are listed again on the next walk.

**The caller reports; the catalog's side rules.** The catalog forwards each report to prospector,
which checks a failed or mismatched file against the venue and records what the venue says. See
[PROSPECTOR.md](PROSPECTOR.md#reports).

**Reporting is not transactional with the download, on purpose.** A file fetched but never reported
is listed again on the next walk, found on disk, and reported then.

**A catalog that is away is waited for.** A connection that fails (refused, dropped, the name not
found while the container restarts, no answer in time) and a `5xx` are the catalog unable to answer,
not an answer. The request is asked again, a second apart and doubling up to thirty seconds, until
the catalog answers: a walk pauses where it is, the files already in hand keep downloading, and
reports are delivered late rather than dropped. Both requests are safe to repeat: a listing is a
read, and a file reported twice is recorded once. A `4xx` is the catalog's answer and is not asked
again. The catalog going away and coming back are each logged once for the service, however many
venues were waiting on it.

## Stopping

**A stop gives the files in flight fifteen seconds, and no longer.** It takes no new file, and the
catalog is no longer waited for: each request gets three attempts. A file waiting for an address or
between attempts asks nothing more and stays owed. Downloads that finish in the fifteen seconds count;
whatever is still downloading after them is given up, left owed and its partial removed, and every
page then reports what it got through before the process exits. Fifteen seconds is half the compose
file's `stop_grace_period` of thirty, which leaves the other half for the reports to go out.

**A start removes every unfinished download** before it fetches anything, which is deleting
`.hauler-tmp`: every partial is there, on the archives' own volume so that the rename into place stays
one step. A partial becomes a file only by being verified and renamed, so one left over is a download
that never finished (a stop that outlived its grace period, a crash, a pulled plug), and the next walk
fetches that file again. `.bak` files are left alone: they are whole files that disagreed, kept for a
person to read.

## Configuration

The variables are in the [service README](../../services/hauler/README.md). Hauler serves no API
beyond its health check, `GET /health` on port 3000.
