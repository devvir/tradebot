# Prospector: walking an archive

How prospector reads a venue that can be listed: mapping the archive into scopes, paging each scope,
what a page writes and withdraws, how scopes split while a walk runs, what lands where, and what is
refused or left unread. What a walk is for, and when one runs rather than an update, is
[PROSPECTOR.md](PROSPECTOR.md#how-a-pass-works); the jobs and run rows a walk is held in are
[PROSPECTOR-PASSES.md](PROSPECTOR-PASSES.md).

## 1. Map the archive

The prefix tree is **discovered, never declared**: a dataset list kept in code is only ever as
complete as the last person who looked, and a dataset nobody knew about is exactly the one a catalog
is for.

```
?prefix=data/&delimiter=/               → data/futures/  data/option/  data/spot/
?prefix=data/futures/&delimiter=/       → cm/  um/
?prefix=data/spot/monthly/&delimiter=/  → aggTrades/  klines/  trades/
?prefix=data/option/daily/&delimiter=/  → BVOLIndex/  EOHSummary/
```

Ten requests map Binance, and they surface `option/`, `BVOLIndex`, `EOHSummary` and `aggTrades`
with nothing naming any of them. **Finding a tree is not cataloguing it.** A file becomes a row only
once the adapter's `inspectUrl` can place it in a series (for binance, a dataset named in its
`MEANINGS`); until then a walk records its path in [`unreadable`](#every-path-is-parsed-or-it-goes-on-the-worklist),
and the walk after the adapter learns the shape catalogues it.

**Asking the tree, not the symbols.** A listing describes a whole subtree at once, so the archive is
mapped in a handful of requests and read in `total keys ÷ 1000` pages. Asking per symbol instead
costs `symbols × periods` requests — a single symbol's klines alone are ~17, one delimiter listing
plus a paged walk of each interval directory — for the same answer.

**Splitting stops when there is work for every lane**, and for no other reason. Every venue nests
differently, so a rule that knows what a level *means* breaks on the next venue — and one that
infers size from shape breaks on the venue after that. Binance's `data/spot/daily/klines/` is wide
*and* branching, 3,694 symbols each holding 13 interval directories; gate's `spot/orderbooks/` is
wide and terminal, each of its month directories holding about 153,000 files. **Shape is not size.**
So the mapping expands prefixes — every prefix it has not read yet at once, up to the room left —
until it holds as many scopes as the walk has lanes, and treats a prefix as terminal when either
of two things is true:

| condition | why |
|---|---|
| **catalogable** files sit directly under it | replacing it with its children would silently drop them. On S3 such a prefix is split by character instead — see [below](#scopes-split-themselves) |
| it has no children | nothing to split |

**It only has to be roughly right.** A scope that turns out to carry a disproportionate share of
the archive is split again while the survey runs — see *[Scopes split themselves](#scopes-split-themselves)*
— so a poor first guess costs a few listings rather than the whole pass. How many lanes a venue
has is its adapter's `concurrency`, capped by the machine's ceiling
([PROSPECTOR-TRANSPORT.md](PROSPECTOR-TRANSPORT.md#cadence-and-concurrency)), so a venue is split for
the lanes it will actually have.

**The key root is always expanded**: it is the venue as a whole, which the job itself covers, so it
is never a scope of its own. A root holding a catalogable key of its own cannot be divided at all — that
key would sit inside no child — and the survey refuses it.

**A level is read to `IsTruncated`, not to the first page.** A `delimiter=/` reply is capped like any
other, with child directories and keys sharing the 1000-entry budget, so a level wider than a page
arrives cut off. The answer that loses data is whether files sit here: a dated key sorting past the
cut reads as "no files here", the prefix is replaced by its children, and that key belongs to no
scope at all. S3 states outright whether it held anything back, so it is asked. Splitting reuses
this reader, so a truncated child list would equally close a scope over children nobody walked.

**Every page until the first file, and no further.** A prefix holding a file is never split by
directory, so once one is seen nothing later on the level can change the answer. What must be
complete is the child list of a level *without* files, and that is still read to the end. Stopping at
the file is what separates a split from a re-walk on a flat directory: gate files a month of order
books directly under the month, and reading that level to `IsTruncated` is some two thousand requests
to learn what its first page said.

**"Catalogable" is load-bearing in the first rule.** It asks whether a key here would become a row —
the same `accepts` and `dateOf` questions the recording step asks — not whether any key exists. A
bucket root serves `index.html` and `favicon.ico`, and treating those as files to protect would make
the entire bucket one terminal scope walked as a single serial chain. Descending past keys the
adapter already declines loses nothing, because they were never going to be recorded.

It also makes the rule hard to trip by accident, in two layers. A stray `.log`, `.tmp` or `README`
carries no date, so `dateOf` declines it and the prefix stays splittable. And where a venue leaves
something that *does* look like a dated file, one `exclusion` row settles it — which makes the
exclusion table a splitting lever as well as a cataloguing one.

**A refused directory is not descended into at all** — it is ignored as though it were not there.
Filtering keys at the recording step would keep the catalog correct, but the walk would still happen
first: binance's `data2/data/spot/klines/` is 655 pages of a worker's time that store nothing.

That makes `accepts` a question about **prefixes as well as keys**, and an adapter's patterns have
to hold for both. The direction that hurts is a pattern catching a directory it should not, since
the tree then disappears without a trace — which is why binance's `data3` rule leans on the trailing
slash to tell a stray key from the directory holding the liquidation snapshots.

**Every prefix is expanded at most once**, which is what makes the mapping terminate rather than
merely tend to: a venue answering with a child equal to its parent — a stray trailing slash, an index
linking to itself — would otherwise be split into itself for ever.

## 2. Walk each scope

Descent yields **scopes**: key prefixes, disjoint, which between them cover everything under the key
root. A job writes one `run` row per scope, carrying its cursor, and that row is what the rest of a
job deals in. A scope is not a [partition](../VOCABULARY.md#archives), one month of a slice and a row
of the `partition` table; these docs use *partition* only in that sense.

**A scope is a serial chain.** Each page's cursor is where the previous page stopped, so no amount
of concurrency makes one scope faster. Scopes are therefore the only unit of parallelism, and they
cut the keyspace exactly — disjoint, and together covering everything under the root. **Imbalance
sets the wall clock, not the total**: if one scope holds most of the keys, its chain decides when the
survey ends however quickly the others finish, which is what [splitting](#scopes-split-themselves)
is for.

Each scope is paged to exhaustion, several at a time. What a page *is* depends on the platform,
and it is the one place the two scanners genuinely part company.

### On a listing venue

Two properties of S3 shape this:

**Keys sort lexicographically and the date is the trailing part of a filename.** So one symbol's
dates are contiguous and dates across symbols are not:

```
spot/monthly/trades/AAVEUSDT/AAVEUSDT-trades-2026-07.zip
spot/monthly/trades/ADAUSDT/ADAUSDT-trades-2020-01.zip     ← next symbol restarts at its floor
```

A walk therefore **cannot seal a month part-way through**. What it can seal is a whole prefix: when
`spot/monthly/trades/` completes, that prefix is known for every month at once.

**`max-keys` caps at 1000.** Larger values are echoed back in `<MaxKeys>` and never applied — the
echo is the request, not the cap, so anyone reading the response would conclude it worked.

Pagination uses `marker` set to the previous page's last key. S3 omits `NextMarker` when no
delimiter is present, so a walk that trusts `NextMarker` alone stops after one page and reports
success, with everything below silently missing.

### On an index venue

There is no marker to page with: a directory answers in full or not at all. So a page is **one
directory**, and a walk is a depth-first traversal of the scope's tree rather than a straight
line through a keyspace.

That costs nothing in resumability, because depth-first with children in sorted order visits paths in
exactly the order they sort — a directory, then everything beneath it, then its next sibling. So the
directory just read is the whole of a walk's state: everything at or below it is done, and the next
page is the first directory above it, which the tree itself answers. A scope resumes from one
short string exactly as a listing venue resumes from a marker, and a subtree that ends before the
cursor is skipped by comparing two strings rather than opening it.

Directories already read are remembered for the length of the process so each costs one request, and
nothing is ever answered from a memory this job did not fill — a parent is always read before its
children, so a symbol added since last month cannot hide behind a stale answer.

### What a page writes, and what it withdraws

**A page states its stretch of the keyspace in full**, and says which stretch that is (`covers`):

| scanner | a page covers |
|---|---|
| S3 listing | every key after the marker it was asked with, through the marker it hands back — or from the scope's start on its first page, to its end on its last |
| index | its directory's own files, and below it only the subdirectories it links |

Both are checked, not assumed: every S3-protocol venue answered strictly in byte order on
2026-10-03, which is the order `path` sorts in; and an index walk gives every directory of a
scope its own page, files or not.

So **a page is compared with what the catalog holds in that stretch, and only the differences are
written**:

- a key the catalog does not hold is added;
- a key whose size or ETag differ is updated, its previous version appended to `revision`, and
  `downloaded_at` cleared, since what was downloaded is no longer the file;
- a key whose `modified`, series, date or existence differ is updated and nothing else: the bytes
  are the ones already known, so it is not owed again;
- **a key that says nothing new is not written at all.** On a re-walk that is nearly every key;
- a catalogued file inside the stretch that the page did not list has been withdrawn: its
  `existence` becomes `absent` and its row stays. A parked key the page did not list leaves `wip`.
  On an index venue, a subdirectory the page no longer links is withdrawn with everything below it.

On a listing venue the comparison is **one ordered read of the stretch**, not one lookup per key — a
page's thousand keys answer from a few milliseconds of index rather than five hundred seeks. It is read once
per page, before the page is cut into write batches; a key that is about to be written, parked or
withdrawn is looked up again inside the batch that writes it, since another writer may have touched
it in between, and a key that said nothing new is skipped on the read's word.

### Withdrawals

**A file is marked `absent` in two places and no others**: a walked page that covers where it is and
does not list it, and a download report the venue confirms
([reports](PROSPECTOR.md#reports)). Keys that reach the catalog any other way — a backfill, a probe's
answer — cover no stretch, and say nothing about what is no longer there. A probe that keeps missing a
key gives up on a row in `wip`; it never touches a row in `file`.

A withdrawn file's row stays, with its history; only `existence` changes, and its partition's counts
and version move with it.

**A withdrawn file comes back the way any file arrives.** A listing that states it in full writes the
row again. A listing that only names it sends it to `wip` although the catalog holds a row for it,
because a row marked absent says nothing a probe could not correct; the probe's answer then brings
the row back. What the archives hold of it still counts where it returns with the size and ETag it
had, and is owed again where it does not.

**Every one is written to `withdrawals.log`, beside the database.** A withdrawal is rare and never
ordinary: an archive is insert-only unless somebody erred, so it means the venue corrected a mistake
or is making one. The catalog keeps only the outcome, so the log keeps the event — one JSON line per
file:

| Field | |
|---|---|
| `at` | when it was written |
| `event` | `withdrawn`, or `returned` for a withdrawn file catalogued again |
| `cause` | `walk`, `report`, or `probe` for a file a probe found again |
| `venue`, `host`, `path`, `date` | the file |
| `size`, `etag` | what the catalog held, or holds now |
| `downloaded` | on a withdrawal: whether the archives held it |
| `status` | on a withdrawal by report: what the venue answered |

Each batch is also one warning in the service's log, naming the venue, the cause, how many files and
the first of them. Nothing reads the file back; it is a record and not state.

## Scopes split themselves

The mapping only has to be roughly right, because a scope that turns out to hold too much is
split while the survey runs. **The signal is idle workers** — the very thing a good split exists to
avoid, measured directly rather than predicted from a directory's shape.

```
a lane finds the queue empty
  → nothing running?                 the survey is over
  → the busiest running scope:       pause it, list its level, replace it with its children
  → nothing left that can be split?  stop asking
```

**The busiest is the one deciding when the survey ends**, and `run.requests` already counts its
pages, so it identifies itself. Splitting anything else terminates just as surely and helps just as
little.

**A walk is paused between pages, never interrupted mid-page.** `sweep` commits its cursor after
every page and returns without closing the run, so what a pause leaves behind is a scope that
knows exactly where it reached. Splitting under a running walk would race that cursor and hand the
children a position their parent had already passed.

**The cursor divides by where it falls**, which is sound because both scanners walk in order — a
lexical key walk on S3, a sorted depth-first traversal on an index:

```
parent at  P/c/key-0400
  P/a/  P/b/   entirely behind it   → already walked, no scope made
  P/c/         contains it          → inherits it, resumes mid-way
  P/d/  P/e/   ahead of it          → fresh scopes
```

The swap is **one transaction** — parent closed, children written, one job epoch shared. A crash
between the two halves would leave a stretch of keyspace belonging to nothing, and the work list is
the scopes' rows, so nothing would ever notice.

Two guards keep a split from destroying what it was meant to divide:

- **A prefix holding a catalogable file of its own is never split by directory.** A parent covers
  every key beneath it; its children cover only their subtrees, so a key sitting directly there
  would belong to none of them. **On S3 it is split by character instead**: any string is a prefix,
  so `…/202505/` divides into `…/202505/A`, `…/202505/B` and so on, which between them hold every
  key beneath it. The characters are found by skipping (ask for the first key after a marker, note
  the character it continues with, move the marker past that character), one request each, so a
  flat month of tens of thousands of files splits in a few dozen requests. They are read rather than
  assumed because gate publishes symbols written in Chinese. Without this a flat month is one serial
  walk while every other lane stands idle. A prefix that is itself a key stays whole, and so does one
  whose venue ignores the marker. An HTML index cannot be listed by an arbitrary prefix, so there a
  prefix holding files stays whole.
- **A split that would produce no children leaves the run open.** Every child sorting behind the
  cursor means the prefix is genuinely finished — but so does a child list that came back short, and
  the two are indistinguishable from here. Leaving it open costs one more pass; closing it wrongly
  loses the keyspace in silence.

**It terminates** because every path shrinks the problem: a split replaces a prefix with strictly
longer ones over a finite tree, and a prefix that cannot be split is remembered so it is never
examined twice. When everything running is terminal, refinement is over and idle workers become a
fact to accept rather than a condition to retry.

**A split is bounded, because everything waits on it.** The scope is stopped for it and every
idle worker is parked on its answer, so a split that does not come back is the whole survey
standing still. One that takes more than five minutes is abandoned: the scope resumes whole and
is not offered for splitting again that pass — the cost of a prefix that could not be split, and no
more.

### What a walk says while it runs

The walk's 30-second heartbeat (`Walking`) carries its request rates, the host's limiter state and
the machine's ticket pool, so a request that is not going out says which of the two is holding it.
What the rates are, and why they are read over a minute and an hour, is in
[PROSPECTOR-TRANSPORT.md](PROSPECTOR-TRANSPORT.md#what-the-rates-say).

**At `LOG_LEVEL=debug` it also says where requests spend their time** (`timings`): average and 90th
percentile, in milliseconds, of each part of a request's way since the previous line — waiting for a
slot, the trip to the transport worker, the venue's first byte, the body, reading the page, and the
page's processing after its slot is given back. Only the last runs without a slot. See `timings.ts`.

## 3. Record

On a listing venue every key carries what the catalog needs, so a survey establishes existence, size
and checksum in one pass:

```xml
<Key>data/spot/monthly/klines/0GBNB/12h/0GBNB-12h-2025-09.zip</Key>
<LastModified>2025-10-06T09:39:01.000Z</LastModified>
<ETag>"9cfc390fb9f68d8ef1fdbc7053d2698c"</ETag>
<Size>1045</Size>
```

An index venue names files and stops. Rather than let a row like that into `file` and make every
reader remember to exclude it, **a finding lands wherever it is ready for**: complete ones straight
into the catalog, bare ones into `wip` until a probe settles them and promotes them
([probing](PROSPECTOR-PASSES.md#probing-settling-what-a-listing-could-not-carry)).

That is what keeps `file` holding exactly one kind of row. No query works around half-known files,
`bytes` is a real total rather than a lower bound, and the probe reads a small table of its own
rather than a partial index over the largest one. Three rules make it safe, and all three are the
same rule in different places: **ready stays ready** (an index venue re-offers the same bare names on
every walk, and a bare sighting of a catalogued file writes nothing), a withdrawal reaches `wip` too,
and arriving is first discovery rather than a revision.

**Rows carry who named them.** A listing cannot name a key that is not there, so a walk's findings
land as `existence = 'confirmed'`; keys an update built from a pattern and a date land as
`'assumed'`, because nothing has seen them. That is a property of the candidate rather than of the
pass that parked it, which is what lets an update drain a walk's leftover backlog without treating
its keys as guesses — a distinction the pass kind alone gets wrong after a restart.

Every file a walk records also states the bounds of its series — see
[a sighting states the bounds](PROSPECTOR-SERIES.md#a-sighting-states-the-bounds-a-finished-pass-checks-them).

## Every path is parsed, or it goes on the worklist

Reading paths exists to keep series and their tips current, so **a path nobody can parse is a series
nobody is tracking** — its tip never advances and the update that was the whole point quietly stops
extending it.

So nothing is passed over in silence. A path no adapter can place lands in `unreadable`, keyed by
path with a count, and the survey carries on:

```sql
unreadable(venue_id, path, reason, seen, first_seen, last_seen)
```

`reason` says why: **`unread`**, a shape the adapter's `inspectUrl` does not recognise, or
**`unplaced`**, a path that could not be put in a series the catalog holds (or on a venue with no
`inspectUrl`).

The file is not catalogued: a row with no series answers none of the questions `file` exists to
answer. It waits in `unreadable` until the adapter learns the shape, and the walk after that
catalogues it. Counting rather than repeating is what makes the table worth reading: one row seen
40,000 times is a dataset nobody parses, and one row seen once is a stray key.

## What is excluded, and why

**Everything a venue publishes is catalogued except what is refused here**, and only what is **not
proper historical data** is refused: a bucket's web assets, a venue's staging area, temporary files,
and files served with corrupt or wrong contents. Not data that is merely unannounced, unreliable or
superseded — an abandoned earlier generation of a month is still that month, and a catalog that has
already decided against it cannot be asked for it. Nothing is skipped for being hard to parse either:
a path that survives these rules and cannot be placed is written to
[`unreadable`](#every-path-is-parsed-or-it-goes-on-the-worklist) rather than passed over.

Each rule was established from the venue's own files, and the venue docs carry the evidence.
**Before removing one, read the evidence** — and before adding one, pick the tier by what the rule
*is*, not by what is convenient:

| tier | for | lives in | changing it costs |
|---|---|---|---|
| `excludedAnywhere` | files no venue should ever catalogue | `src/paths.ts` | a deploy |
| an adapter's `accepts` | one venue's shapes, trees and prefixes — a **rule**, holding for keys nobody has published yet | that adapter | a deploy |
| the `exclusion` table | **specific** known-bad files, by exact path, where there is no shape to describe | a row, plus a migration | nothing; the row applies from the next job |

**Every key a survey turns into a file passes all three**, whether a walk listed it or an update
generated it: the `exclusion` table first, then `accepts`, then `excludedAnywhere`. Descent asks the
first two about **prefixes as well as keys**, so a refused directory is never descended into — that is
where the saving is, and why a rule that can be described belongs in `accepts` rather than as five
hundred rows. The `exclusion` table is the opposite case: a handful of files a venue serves wrongly,
which no expression predicts.

**A survey only reads the table.** Its rows for the venue are loaded into memory when a job starts
(`exclusions.ts`), so a row added to the live catalog applies from the next job, and a job keeps one
list for its whole run. Nothing in the survey path writes them. A row is added twice, by hand: the
`INSERT` on the live catalog, and the same row in the migration that ships the list, because a
catalog rebuilt from scratch walks the same files again — a walk of gate's
`futures_usdt/trades/202107/` lists the 85 spot files the migration excludes again unless something
refuses them. The shipped rows are written for every server of their venue.

**Nothing already catalogued is removed.** A rule stops a path being catalogued; a row already in
`file` stays, with its history.

### Excluded at every venue

Four suffixes, in `excludedAnywhere`. None of them is one venue's quirk:

| suffix | what it is |
|---|---|
| `.CHECKSUM` | a checksum file beside an archive file, as [binance](../venues/BINANCE.md#files-carry-checksums) and [KuCoin](../venues/KUCOIN.md) publish |
| `index.html` | a directory listing page; [bybit](../venues/BYBIT.md#what-is-in-the-bucket-but-is-not-archive) writes one into its folders |
| `.csv` | an **uncompressed** stray. Archival data is published compressed, so a bare `.csv` is a copy left beside or before the compressed file, as in gate's early months ([GATE.md](../venues/GATE.md#archives)) |
| a trailing `/` | a directory marker — S3 lists a zero-byte key for a folder created rather than implied, so `data3/` arrives beside the keys beneath it |

### Refused by a venue's `accepts`, or named in the `exclusion` table

**Each adapter's `accepts` docblock names what it refuses**, in `src/adapters/`, and the
venue's doc under [docs/venues/](../venues/) holds the evidence. **The shipped `exclusion` rows are in
`src/database/migrations/001-core.ts`**, each list with its reason in the docblock above it: gate's
two zero-byte uploads, 85 of the spot files it serves at futures URLs for 2021-07 (what that month
holds: [GATE.md](../venues/GATE.md#2021-07-spot-data-at-the-futures-url)), and bybit's one misfiled
day. How each venue's refusals were chosen, where that is this service's decision rather than the
venue's fact, is in [PROSPECTOR-VENUES.md](PROSPECTOR-VENUES.md#venue-by-venue).

### Not an exclusion: the venue's key root

The key root is where a walk **starts**, not a filter. binance has none, so `data/` is simply part of
every catalog path; kucoin's is `data/`, bybit's second host `orderbook/`, and the catalog stores
paths relative to it. Everything beneath is walked. A key root is always part of the venue's keys —
a path that only addresses the venue, such as a bucket name or okx's `cdn/`, belongs in `base`.
