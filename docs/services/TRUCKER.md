# Trucker

Trucker fetches each venue's published historical archives and drops them on the host,
untouched. It is the haulage stage: get bytes off the internet and onto disk. Nothing else.

It is the first of three collection paths, in order of preference: **archives → REST →
websocket.** An archive is a settled, complete file a venue publishes after the fact, so it is
always the cheapest and most trustworthy source. Trucker handles that tier; anything a venue
does not archive falls to the REST and websocket collectors.

## Scope

**Does:**

- Download whatever each venue publishes, as published — same bytes, same container format
  (`.zip`, `.csv.gz`, `.tar.gz`)
- Store under a host directory mounted into the container at a fixed path, organised by venue
- Know what already exists, so runs are resumable and idempotent
- Verify integrity where the venue supplies a checksum

**Does not:**

- Transform, decompress, re-encode, or normalise anything
- Use vault — vault stores date-partitioned CSV in *our* shape; these are foreign archives in
  the venue's shape, and imposing a schema here would be premature
- Decide what the data means — a later service brings these to a common shape

**Why raw:** the archives are ground truth. Any normalisation is a lossy opinion, and opinions
are cheaper to change than downloads are to repeat. Whatever a later service gets wrong can be
redone correctly *because* the untouched originals are still here.

The `okx-data-dump` package is the cautionary counterexample. Its pipeline is: stream the zip
to disk → `pd.read_csv` → add a derived `timestamp` column → **re-sort the rows** →
`to_parquet` → **`os.remove(zip_path)`**. Three things are lost at once: the original bytes,
so nothing can be re-verified against the venue; the venue's own header, since the CSV is
parsed with hardcoded column names and `header=0`, so a added or reordered column mislabels
data silently rather than failing; and the published row order, replaced by a sort. Parquet is
a fine *target*, but as an artifact derived from a preserved original, never as a replacement.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | — | **Host** root of the tradebot tree. The `@shared` is always `$DATA_DIR/@shared`, mounted at `/data/shared` |
| `TRUCKER_DATA_DIR` | `$DATA_DIR/archives` | **Host** archive directory, mounted at the fixed container path `/data/trucker`. May point anywhere — another volume, another machine |
| `TRUCKER_DIR` | — | Overrides the container archive path when running outside Docker |
| `TRUCKER_SHARED_DIR` | — | Overrides the container shared-`@meta` path when running outside Docker |
| `TRUCKER_VENUES` | _all_ | Comma-separated venue tokens |
| `TRUCKER_SYMBOLS` | _all_ | Symbol tokens, matched as case-insensitive substrings |
| `TRUCKER_START_MONTH` | — | Oldest month fetched, inclusive: `yyyy-mm`, `yyyymm` or `yymm` |
| `TRUCKER_END_MONTH` | _none_ | Newest month fetched, inclusive. Unset fetches everything published |
| `TRUCKER_CONCURRENCY` | `4` | Concurrent downloads **per venue** |
| `TRUCKER_RESCAN_HOURS` | `6` | Hours between sweeps |
| `TRUCKER_MIN_FREE_GB` | `50` | Stop fetching below this much free space |

`TRUCKER_SYMBOLS` matches substrings because venue naming differs too much for exact lists to
be portable: `BTC` selects `BTCUSDT`, `BTC_USDT` and `BTC-USDT-SWAP` alike.

### The month bounds

Both bounds name a **month**, not a date, and both are **inclusive**:

```
TRUCKER_START_MONTH=2019-01     # from 1 January 2019
TRUCKER_END_MONTH=2019-12       # through 31 December 2019
```

Accepted as `yyyy-mm`, `yyyymm` or `yymm` — dashes are stripped and the year form follows from
the length. A date is rejected outright rather than interpreted.

Months rather than dates because a date cannot be honoured here. A monthly file is keyed by its
last day, so a mid-month cut either takes a whole month only partly wanted or drops it entirely
and loses the days already past — the old date form quietly snapped to a boundary the caller had
not named, and what `2022-03-05` did depended on which side of the granularity cutover it fell.
`2022-03` states exactly what it means, today and in six months.

Unset, there is **no ceiling**: the walk runs from the floor to the present month.

The ceiling filters what is offered for download and nothing else. No cursor advances past it
and no absence is recorded because of it, so raising it resumes exactly where the previous pass
stopped.

It is **not** how a backfill is paced. Walking the archive era by era — set the ceiling to 2018,
wait, move it to 2019 — is what the [month-major walk](#the-walk-is-month-major-oldest-first)
does on its own, one month at a time, publishing each as it finishes. Driving that by hand
leaves every month in between looking incomplete to anything downstream, which is the whole
problem the walk order solves. The ceiling is for bounding a run, not for sequencing one.

## Architecture

One adapter per venue implements `VenueArchive` (`src/venues/types.ts`); everything else —
download, retry, backoff, integrity, resume, storage — is shared and venue-agnostic.

An adapter supplies its datasets, how to list a dataset's symbols, and how to list a symbol's
files. Four optional members handle the venues that break the usual assumptions:
`constructsUrls`, `classify`, `continuation` and `unreliableAbsence`, each described below.

A `Dataset` is one publishable series: a market and a data kind. Its `id` is a progress-key
segment and must stay stable — changing it re-downloads that history.

An `ArchiveFile` is one downloadable file, with a `url`, a `path` relative to the venue root,
the `date` of the last day it covers, and its `period` (`daily` or `monthly`).

### Discovery differs fundamentally per venue

There is no uniform "list what exists" mechanism, and that is the main design pressure.

| Venue | Discovery | Cost |
|---|---|---|
| binance, kucoin, htx | S3 XML listing, `prefix` + `delimiter` | one paginated listing per symbol, started at the cursor where the filename shape allows a marker |
| bybit | HTML directory index, scraped for `href`s | one page per symbol, recursing into subdirectories |
| gate | none — URLs constructed | one request per candidate month, bounded by `launch_time` / `buy_start` and the archive floor |
| okx | none — URLs constructed | one request per candidate period, bounded by `listTime` |
| bitget | constructed above 2024-04-18; the portal's file-list endpoint below it | one request per candidate day; below the naming change, one index query per seven days walked |

For the constructed-URL venues an "absent" answer means *never published*, which is the
expected reply for most requests — not an error. Those venues set `constructsUrls`.

Two parsing details that fail silently if got wrong:

- **Only `<CommonPrefixes><Prefix>` is a child directory** in an S3 listing. The response also
  carries a bare top-level `<Prefix>` echoing the request, which ends in `/` like the rest;
  matching `<Prefix>` alone turns it into a phantom symbol named after the last path segment.
- **S3 `prefix` and `marker` go in unencoded.** KuCoin's endpoint serves its HTML page instead
  of the XML listing when the slashes are percent-encoded, and again when `prefix` is the only
  query parameter — so `max-keys` is always sent.

Bybit's traversal recurses rather than assuming a depth. Its categories disagree: trades sit
directly under the symbol, MT4 klines are grouped by year below it. Following whatever
directories turn up means a category that adds a level later is picked up without a change.

## Granularity: one fixed cutover

Several venues publish the same trades twice — once as a month, once as that month's days.
OKX's June 2026 monthly file for `1INCH-USDT-SWAP` holds 550,733 rows against 19,162 for a
single day, with identical columns: **a month is not a summary of its days, it is the same
rows in one file.** Binance publishes both shapes for its entire history, and Bybit spot lists
44 overlapping months on BTCUSDT alone.

So one boundary decides everywhere: **periods through June 2026 are taken monthly, and from
1 July 2026 onward daily.** Both sides are settled history and neither moves, so the two sets
meet exactly and no date can be covered by two files.

The rejected alternative was deciding per sweep which months count as "closed". That makes the
answer depend on when trucker runs, which is precisely how the same day ends up fetched at two
granularities — and it then needs a compensating mechanism to delete what it duplicated.

**Which shapes exist is read from the listing, never declared.** The boundary only decides
when both are present:

- **Days only** → keep them all. Bybit's perp trades go back to 2020-03-25 as days and nothing
  else — 2,316 files on BTCUSDT, not one monthly — as do Binance `metrics` and `bookDepth`.
  A blanket date rule would erase those histories.
- **Months only** → keep them all. Binance `fundingRate` has no daily form at all, so applying
  the boundary would drop every month after it and the series would stop dead at the cutover.
- **Both** → months to the left, days to the right.

Deriving it means the rule cannot drift from what a venue actually publishes, and adding a
series requires no claim about its granularity.

## The walk is month-major, oldest first

A month is walked across every dataset and every symbol before the next one begins, so the
venue advances as a whole.

The alternative — walking a symbol's entire history, then the next symbol's — collects the same
bytes and is cheaper in listings, but it leaves **every month partial until the entire archive
is collected**, which is terabytes and weeks away. Nothing downstream can act on that. Stocker
cannot build a partition, cold storage cannot cut a tarball, and both end up reconstructing
completeness from trucker's private bookkeeping: which symbol is settled, which delisted, which
had not listed yet. That coupling is the thing month-major exists to remove.

Walking towards the present rather than away from it is what makes the result durable. The past
does not change: 2018's trades will not be added to in 2026. So a finished month is finished for
good, and the tip only ever moves forward.

The cost used to be listings, and only on the venues that have an index — the constructed-URL
venues issue the same probes in a different order. Asking once per symbol per month instead of
once per symbol cost the sum of every symbol's age in months:

| | symbols | avg age | listings, whole backfill | per sweep, caught up |
|---|---|---|---|---|
| kucoin | 10,460 | 25.3 mo | 264,574 | 10,460 |
| binance | 5,221 | 43.0 mo | 224,715 | 5,221 |
| bybit | 2,631 | 24.9 mo | 65,579 | 2,631 |
| htx | 3,102 | 4.8 mo | 14,755 | 3,102 |

About 570k against 21k symbol-major: **550k extra, once.** Listings are serial within a dataset
and venues run in parallel, so the wall-clock cost is the slowest venue — on the order of a day,
against a backfill measured in weeks of bandwidth.

Caching each symbol's listing on disk is the obvious optimisation and it is **not worth
building**. It would only ever serve closed months, and those are the months the walk has
already passed. The cost that recurs is the ~21k listings per sweep over the one or two open
months, where new files are still landing and a cache must not be trusted.

## Progress is counted in days, never in files

A cursor is one line per (venue, dataset, symbol) in `@meta/settled/{venue}.tsv`, holding a
`yyyymmdd`: **the newest day known to be covered.** A monthly file is keyed by the last day of
its month, so a month that lands advances the cursor thirty-odd days at once. Gate publishes
nothing but months and its cursors read `20260630`, not `202606`.

The cursor and the published milestone are the same record — see
[Published milestones](#published-milestones--metasettledvenuetsv). Trucker keeps no state
outside its data directory, so the archive and how to resume it move together.

This is what makes a date impossible to fetch twice. The cursor records which *days* are
covered, not which files were fetched, so daily, monthly, or any future weekly or yearly
partitioning compare directly and none can overlap another.

**A date settles only when every file covering it has landed.** Some venues split one period
across several files — Gate publishes a day of order-book deltas as 24 hourly files, Bitget a
day of trades as numbered parts — and all of them carry the same date. Judging the date on
whichever file happened to arrive first would mark a day done with 23 hours still missing, so
the outcomes are grouped by date and the worst one in a group decides it. Sub-daily files
therefore need no finer cursor: a partial day is simply never settled, and re-listing it next
sweep costs 24 `stat` calls and no requests.

**Resume is a `stat`, not bookkeeping.** Before any request, `exists()` checks the final path;
if present the file is `skipped` with no HTTP call at all. The filesystem is the record of
truth and the cursor is an optimisation on top — losing the ledger costs a re-listing pass, not
re-downloads. It matters most for the constructed-URL venues, which would otherwise re-probe
years of dates that will always answer absent.

Cursors only ever move forward, and only across the contiguous run of files confirmed on disk.
A `failed` file stops the advance, so the next pass retries it rather than stepping over a
hole and never coming back.

An `absent` file stops the advance only while "not published yet" is still plausible, and that
window scales with the period: **three days for a daily file, thirty-five for a monthly one.**
A month appears only once it has ended, sometimes days after — Gate's `202607` was still
absent on 28 July. A window sized for dailies would let the cursor step over a month and lose
it for good. Beyond the window absence is permanent (a symbol not yet listed, a month a market
did not trade) and blocking on it would re-probe dead dates forever.

Symbol lists are cached for 12 hours in `@meta/symbols/{venue}.tsv`, since listing them costs a
bucket enumeration or an API call and they change on the timescale of listings, not runs. An
**empty list is never recorded** — every collected dataset has symbols, so empty means the load
faulted, and keeping it would collect nothing for the TTL with no error anywhere. The venue
metadata fetches behind these lists throw on a non-2xx or an empty answer for the same reason,
and their in-process caches carry the same 12-hour expiry, so the periodic rescan sees newly
listed symbols without a restart.

The list a sweep walks is the **union of the live list and every symbol ever seen**, held in the
same file. Venues that enumerate from their live instruments
API — OKX, Bitget, Gate — stop mentioning a symbol the day it delists, while its history stays
on the CDN, so without the union those archives would silently become unreachable. It is
applied uniformly for consistency, but it is only load-bearing on those three: Binance,
KuCoin, HTX and Bybit enumerate from the bucket or index, which still lists a delisted
symbol's files, so their `symbols()` already returns everything ever published.

**The set is a floor, not an authority.** It is additive and never pruned, so a symbol that
reaches it once is walked forever — which also means a *wrong* symbol is permanent, where an
expiring list would have aged it out. Nothing currently produces one (the listing parser reads
only `<CommonPrefixes><Prefix>`, which is what stopped the phantom `trades` symbol), but a
change to symbol parsing wants the record cleared alongside it — delete the venue's file, or
the offending lines from it, while the service is stopped:

```bash
rm <data-dir>/@meta/symbols/{venue}.tsv
```

The file carries two kinds of line, told apart by a tag column, since a venue symbol can
contain nearly any punctuation but never occupies the tag's column:

```
spot-deals	symbol	BTC_USDT
spot-deals	fetched	2026-08-01T09:15:04.112Z
```

A symbol is appended the first time it is seen and never again, so the file tracks the venue's
catalogue rather than the number of passes.

## Downloading

### Reading a response

`classify` maps a status to one of three verdicts:

| Status | Verdict | Reasoning |
|---|---|---|
| 404 | `absent` | Most venues answer 404 for a missing file *and* a missing symbol |
| 429 | `backoff` | Slow down |
| 403 | `backoff` | How a CDN usually expresses a block; no venue here uses it for a missing key, except Bitget |
| 5xx | `backoff` | Transient by definition; S3-fronted hosts also answer 503 (`SlowDown`) under load |
| other | `retry` | No model for it, and guessing is how a client gets banned |

A venue may override this with `Venue.classify`, which receives the response body as well as
the status and returns `null` to fall through to the default. Bitget is why it exists — see
its section below.

**404s log at `debug`, not `warn`.** They are the expected answer for any date before an
instrument listed, and at warn level they buried every useful line. Counts still appear in the
per-symbol and per-dataset summaries. Every other non-2xx logs at warn with its status.

### Retries and backoff

Five attempts per file, with exponential delay and full jitter — synchronised retries across
workers are their own hazard.

The limiter is **per venue**, so one venue's trouble never throttles another. It enforces a
minimum interval between request starts, which bounds the rate even when every response is
instant (a CDN cache hit returns in milliseconds, and unthrottled concurrency would turn that
into a burst). A `backoff` verdict extends a venue-wide cooldown, doubling each time and
capped at 15 minutes; `Retry-After` wins when the venue says how long to wait. The cooldown
halves on every clean response, so a venue recovers once trouble passes.

The cooldown is deliberately venue-wide: a 429 means we are collectively too fast, so slowing
only the failing request would keep the pressure on.

### Integrity

**Verification runs on the `.part` file, and the rename to the final name is the last step.**
The order is what makes it safe: a file that fails verification never appears at a path
`exists()` would accept, so it is retried rather than skipped as complete forever.

Binance and KuCoin publish a `.CHECKSUM` beside every file; nobody else does. Neither says
which algorithm, so the digest length decides — 32 hex chars is MD5, 64 is SHA-256 — and an
unrecognised length leaves the file unverified rather than rejected, since the wrong algorithm
would discard perfectly good data. The digest is computed by streaming the partial from disk,
never by loading the archive into memory. The companion fetch goes through the venue limiter
like any other request, and a companion that stays unreachable after a few attempts leaves the
file **unverified rather than failed** — discarding a good multi-hundred-MB download over a
flaky 63-byte side request would be the worse trade.

Everywhere else `Content-Length` is compared against bytes written. Without that check a
response truncated by an early close would be accepted as complete and skipped forever. The
comparison is skipped when the response carries `Content-Encoding`: the body is decoded before
it is written, so the declared length describes bytes that never reach disk.

### Partial writes

Writes go to `<file>.part`, verified there, and renamed only once verification passes, so a
partial or corrupt file is never mistaken for a finished one — `exists()` stats the final
name. A retry truncates any stale `.part`, and orphans left by a hard kill are swept at
startup, when nothing can be in flight.

### Multi-part periods

Some venues split one period across sequence-numbered files with no index saying how many.
Capping the guess at N silently loses data on any busier day, so `files()` emits only the
first part and `Venue.continuation` walks the chain: each part that lands asks for the next,
and the first absent one ends the period. That costs exactly one extra request — the
terminator — and can never miss a part however many there are.

A period's status is the worst outcome in its chain, so a failed part keeps the cursor from
stepping over the whole period.

### Absences that cannot be trusted — an unfounded rule, kept until discovery goes

> **The claim behind this does not hold, and the machinery below is waiting to be deleted rather
> than corrected.** OKX was said to answer 404 for a URL that serves 200 seconds later. Checked
> against its own ledger: of **46,847 recorded absences, 219 were re-probed and every one was still
> absent**, and `attempts` is `1` on all 46,847 — so the double-probe described here has never run
> on any of them. `docs/venues/OKX.md` has the measurement. It is left in place because discovery
> is being replaced by the catalog and this goes with it; changing collection behaviour now would
> be churn on code about to be removed.

OKX alone is marked `unreliableAbsence`. Its `absent` verdicts are probed twice
before being accepted, and one the cursor is about to pass is appended to
`<dataDir>/absences.jsonl` rather than forgotten. Once a sweep has nothing left to
fetch, due entries are retried on a widening schedule (1h, 6h, 24h, 72h) and dropped only
after five spaced attempts — or immediately, if one succeeds. **Only an `absent` probe counts
as an attempt**: a `failed` one is a transport or server problem that says nothing about
whether the file exists, so it re-queues the entry unchanged rather than letting a few
bad-network evenings write off a file the ledger exists to protect. The ledger is plain JSONL,
so what a venue never published stays readable after the fact.

Every other venue's 404 is simply true. Treating all of them as suspect would double the
request count of the probing venues and ledger millions of dates that never existed, to guard
against a fault only one venue has ever shown.

## Runtime

**Order is symbol-major, four levels deep.** Venues (concurrently) → datasets (sequential) →
symbols (sequential, alphabetical from the listing) → files (oldest first,
`TRUCKER_CONCURRENCY` at a time). A symbol's entire history is fetched before the next symbol
starts, and files are oldest-first so an interrupted symbol leaves a *contiguous* run — which
is what makes its cursor meaningful.

A consequence worth knowing: alphabetical order means BTC is reached late on venues with
thousands of symbols, since numeric-prefixed symbols sort first. `TRUCKER_SYMBOLS` is how you
get the majors first, and the cursors make widening it later free.

**Venues run concurrently.** They are unrelated servers with independent rate limits and the
limiter is per-venue, so serialising them buys no politeness while costing a great deal: one
venue's throttling or outage would idle the whole service, and the last venue in the list
would wait for every earlier one to exhaust its catalogue. Total throughput is capped by the
network either way; spreading it means a stalled venue leaves bandwidth for the rest. In-flight
downloads are up to `venues × TRUCKER_CONCURRENCY`.

**Sweeps cannot overlap.** A full backfill runs far longer than `TRUCKER_RESCAN_HOURS`, so a
plain interval would stack sweeps re-listing the same symbols and advancing the same cursors.
A tick landing mid-sweep is skipped and logged; the running sweep already picks up anything
newly published when it reaches that symbol, and the next tick catches the rest. The guard
lives in `src/schedule.ts` rather than inline in the entry point, so the one thing standing
between one sweep and several sharing a cursor is testable. A sweep that rejects is caught and
logged there too: an unhandled rejection would take the process down and end rescanning for
the life of the service.

Keeping up with new data is the same code path as the initial backfill — every pass re-lists,
skips what is on disk, and takes whatever appeared.

**Failures are contained at the smallest useful scope.** A listing failure costs that symbol
for the sweep; a dataset failure — a symbols listing down, a metadata API fault — is logged
and the venue's remaining datasets still run; a venue failure never touches the other venues.
Everything skipped is picked up again next sweep, since the cursor only advances over what
actually landed.

**Free space** is checked between symbols, since a single file can be hundreds of MB and
stopping mid-symbol would leave a cursor claiming more than is on disk. Below the floor the
sweep stops. It is best-effort, not a reservation.

**Startup** fails immediately and legibly if the mount is missing or not writable by the
container's user, rather than after a long listing pass.

## Storage layout

Each venue's own path structure is mirrored beneath a venue root. The only imposed convention
is the venue directory; everything below it is the venue's layout verbatim, minus a bucket
wrapper segment that carries no meaning (`data/` on Binance and KuCoin, `historical_data/` on
HTX, `cdn/okex/traderecords/` on OKX — every key lives under it, so it is addressing rather
than organisation).

Two host directories, mounted separately: what trucker owns, and what it publishes.

```
$DATA_DIR/@shared/                      → /data/shared   (trucker writes, consumers read)
  facts/archives.sqlite                 the published tip, one fact per venue-month
  changes/htx.tsv

$TRUCKER_DATA_DIR/                   → /data/trucker
  binance/spot/daily/trades/BTCUSDT/BTCUSDT-trades-2026-07-24.zip
                                    BTCUSDT-trades-2026-07-24.zip.CHECKSUM
  binance/spot/monthly/trades/BTCUSDT/BTCUSDT-trades-2026-06.zip
  bitget/trades/UMCBL/BTCUSDT/20260702_001.zip
  bitget/kline/BTCUSDT/UMCBL/20260702.zip
  bybit/trading/BTCUSDT/BTCUSDT2026-07-25.csv.gz
  gate/spot/deals/202607/BTC_USDT-202607.csv.gz
  kucoin/futures/daily/trades/BTCUSDTM/BTCUSDTM-trades-2026-07-25.zip
  okx/trades/monthly/202606/BTC-USDT-SWAP-trades-2026-06.zip
  okx/trades/daily/20260708/BCH-USD-SWAP-trades-2026-07-08.zip
```

**Why not a common `venue/year/date.ext` scheme:**

1. **The venues do not agree on what a file *is*.** Binance keys by (market, period, type,
   symbol, interval); Bybit by (category, symbol); OKX by (type, period, date) with the symbol
   inside the filename; Kraken ships one archive containing every pair. There is no shared
   axis to standardise on — a common scheme would need per-venue rules anyway, which is the
   thing it was meant to avoid.
2. **A URL maps to exactly one path, mechanically.** Resumability becomes "does this path
   exist?", with no bookkeeping and no ambiguity about which remote file a local file is.
3. **Renaming loses provenance.** `BTCUSDT2026-07-25.csv.gz` and `BTCUSDT_2026-07-25.csv.gz`
   are different Bybit categories; flattening them destroys the distinction and the ability to
   re-verify against source.
4. **Normalisation is the next service's job**, and it can impose whatever shape it wants
   *because* the raw tree is faithful.

### What a consumer must know

The tree holds **both granularities**, split at the cutover: a venue directory can contain
`monthly/…-2026-06.zip` beside `daily/…-2026-07-01.zip`. They never overlap, so reading both
is correct and no de-duplication is needed — but a consumer must read **both**, or it silently
loses either the history or the recent tail.

### The published contract — `topic=archives`, `fact=complete`

**One fact, and it is the only one a consumer reads:** the month a venue is collected through.

```
topic=archives  venue=gate  period=201802  fact=complete
value=2026-08-03T14:22:10.004Z
```

One fact per venue-month, so closing a month again replaces its time in place rather than
appending beside it — the key does the work an append-only file needed a "later line wins" rule
for. It lives in the shared facts store, which is where every service states what it knows and
reads what everyone else does.

Everything else under `@meta/` is trucker tracking its own progress. Those records answer
"where is this symbol up to" — a question whose answer changes for ever, because an active
symbol always has more coming. This one answers "which months have stopped changing", which
once true stays true.

So a consumer needs no notion of symbols, delistings, listing dates or collection order:

```
is this month ≤ the tip?  →  it is complete, and it will not change
```

That is what lets stocker build a partition and cold storage cut a tarball without either of
them knowing how trucker works.

A month is published only when **every dataset of the venue** finished it with no failed
period, and only once it is past the 35-day monthly publication window, so a file landing late
can never contradict a tip already given. A failure anywhere leaves the month open and a later
pass walks it again.

**The tip is the unbroken run of closed months, not the highest one closed.** The two are the
same only while nothing has failed, and the difference is what makes the contract true rather
than usually true. A month left open does not stop the walk — the months after it are collected
and closed on their own merits — so the closings are a set with a hole in it, and the highest of
them would vouch for every month beneath including the hole. bybit's 202402 and 202405 each
faulted five hours into a pass; the tip read 202501, and stocker built 2,091 partitions from two
months that were never finished.

So the tip stops at the break. The closed months above it are not thrown away and not re-walked
— they simply stop being claimed until the hole is filled, and filling it releases all of them
in one step. **Every unclosed month within range is walked again on the next pass**, which is
how the hole gets filled: a month is only abandoned when the walk stops looking at it, and it
never does.

Forward-only in the sense that matters: a month once closed stays closed, and the tip only
retracts when it turns out never to have been earned.

An archive collected before the ledger existed is **seeded** on start, from the lowest coverage
across the venue's whole symbol universe, rounded down to the last whole month. That is what
stops the first month-major pass re-walking years already on disk. A venue with any unwalked
symbol seeds nothing and is walked from the floor — correct, and cheap where the files are
already there.

### Published milestones — `@meta/settled/{venue}.tsv`

Trucker's own cursor, and no longer something to read from outside. A consumer can see which
files exist but not whether more are coming, and that difference
decides whether a period is safe to process. Only trucker knows, so it writes the answer down:

```
spot-deals	BTC_USDT	20180531
spot-deals	ETH_USDT	20180531
```

One line per dataset and symbol, holding the date collection is **complete through** — every
file covering it and every earlier one has landed or been established as never published. "Is
2018-05 ready?" is `endOfMonth('201805') <= settled`, with no inspection of the tree and no
guessing from file counts.

Append-only, later lines superseding earlier ones, and a milestone only ever moves forward — a
consumer may already have acted on it. Tab-separated because venue symbols contain nearly every
other punctuation character (`BSV*(-3)-USDT`, `人生K线-USDT` are both real), and one file per
venue because venues are walked concurrently.

**It is also trucker's own progress cursor** — where each symbol resumes from. The two were
separate records holding the same number, written one after the other on every symbol, which
bought nothing but a way for them to disagree after a crash. There is now one write, and a
record cannot drift from itself.

It needs no migration: values are held in memory and a line is written only when it says
something new, so the first pass over an already-collected archive records every symbol as it
is walked. That first pass is the price of an unknown cursor — a listing per symbol, no
re-downloads, since every file already on disk is `skipped` on a `stat`.

### Coverage — `@meta/covered/{venue}.tsv`

How far each symbol has been **looked at**, as opposed to how far data was found for it. Internal:
it seeds the tip for an archive collected before that ledger existed, and is what a venue-wide
floor is computed from. Nothing outside trucker reads it.

The milestone only advances when a file lands, so for a symbol that stopped publishing it
freezes at its final file for ever: a symbol delisted in 2017 reads `20170930` however many
sweeps pass over it. Nothing else on disk separates "everything it ever published is collected,
and that was the end of it" from "collection has not reached 2018 yet" — and the two demand
opposite answers to the question a consumer actually asks, which is whether a period is complete
for **every** symbol of a dataset.

Taking the lowest milestone across a dataset answers it wrongly, pinned for ever by whichever
symbol died first. Coverage answers it directly:

```
spot-trades	ELCBTC	20260803        looked at, through 3 August
spot-trades	ELCBTC	20170930        (settled) the last file it ever published
```

A dataset-month is complete when every symbol's coverage reaches the month's last day — no
inspection of the tree, and no per-venue knowledge of which symbols are still alive.

Coverage advances on every outcome that teaches something: a listing that returned nothing new,
a symbol skipped because its archive starts after the ceiling or because it is already settled
past it, and a download pass where every file resolved. It is withheld on the one outcome that
teaches nothing — a listing the venue failed to answer — and on any period that failed to
download, exactly as the milestone is withheld.

It never claims a date whose absences are still provisional: the reach of a pass is the
configured ceiling, or, when there is none, the near edge of the publication window. Claiming
coverage of a month a venue has yet to upload would publish it as complete while files were
still coming.

On start, symbols with a milestone but no coverage are seeded from the milestone — the strongest
claim the older record supports, and deliberately the weaker of the two readings, so a delisted
symbol is seeded at its final file rather than at today and a month after its delisting stays
incomplete until a real sweep says otherwise. Under-claiming costs one pass; over-claiming would
publish a month as complete on the strength of a guess. The seeding is idempotent and runs on
every start, so there is no migration to remember and no state recording whether it happened.

### The rest of `@meta/` — trucker's own bookkeeping

The `archives` facts are the whole published contract; everything beside them is trucker's own, and deleting
any of it costs work rather than data.

| File | Holds | Cost of losing it |
|---|---|---|
| `facts/archives.sqlite` | **the published tip** — the month the venue is collected through | re-seeded from coverage at the next start |
| `settled/{venue}.tsv` | per-symbol cursor, where a walk resumes | one re-listing pass |
| `covered/{venue}.tsv` | how far each dataset+symbol has been looked at | re-seeded from milestones at the next start, weaker until a sweep widens it |
| `inventory/{venue}/{dataset}.tsv` | what the venue publishes: every date, per symbol | one full enumeration per symbol — hours on binance |
| `symbols/{venue}.tsv` | every symbol ever seen, plus the last-listed stamp | one symbol enumeration; delisted symbols unreachable until re-seen |

All of them share the same dull format — tab-separated, append-only, later lines superseding
earlier ones. The inventory is split one file per dataset as well, since it is much the largest
of them and a walk only ever needs the dataset in hand; the rest are one file per venue because
venues are walked concurrently and would otherwise append over each other. Each is read once and
held in memory for the life of the process, which is trucker's alone to write.

### The inventory — what the venue publishes

The archive below its trailing edge does not change, so what a symbol publishes is a fact to
record once, not a question to ask per month. Without that, the month-major walk asks each symbol
for its whole history once **per month** and keeps a month of the answer: on binance a single
kline symbol's listing runs to ~87 pages, and no month ever finished.

A row is one **shape** — a URL and a storage path with the date lifted out (`{d}`) — plus
run-length date ranges in the key's own units:

```
BTCUSDT  daily  y-m-d  https://…/{d}.zip  spot/…/{d}.zip  20170817-20260731  2026-08-05T…
```

Three properties earn their place:

- **The template is derived from the venue's keys, then verified by rendering it back.** Any key
  that does not reproduce byte-for-byte is stored verbatim instead. Nothing is assumed about how
  a venue names files — bitget publishes one series under two names in the same week.
- **A gap stays a gap.** Runs, not a first-and-last span: bitget's early history is genuinely
  discontinuous, and claiming those dates exist would spend a request per day to be told 403.
- **A refresh merges, never narrows.** A tip re-ask covers a fortnight; without merging, the
  ledger would forget the decade below it.

It answers where a symbol's archive begins, where it ends, and what lies between, so the walk
skips a symbol that publishes nothing below the ceiling without asking anyone. KuCoin is why that
matters: it publishes nothing before 2022-12, and a run bounded at 2019-12 once listed all 2,397
symbols of every dataset, discarded every file, and left nothing behind to stop the next sweep
doing it again.

**It says what the venue has, never what we hold** — that is a `stat`, and keeping the two apart
is what makes a re-run cost filesystem calls rather than downloads.

Venues whose URLs are constructed (gate, and bitget and okx above their shape change) have no
listing to remember and are not recorded here: a ledger of constructed candidates would hold what
we *assume* exists, which is the one thing it must never claim.

### When a venue rewrites history — `@shared/changes/{venue}.tsv`

The assumption that settled history does not change is load-bearing: a closed month is published
as final, tarred into cold storage, and built into partitions. So a fresh listing is **diffed
before it is merged**, never absorbed blindly, and anything that is not "new files at the tip"
is written down:

```
spot-trades  BTCUSDT  removed     20260701  20260702  2026-08-05T…
spot-klines  ETHUSDT  backfilled  20180101  20180131  2026-08-05T…
```

| kind | what the venue did |
|---|---|
| `removed` | withdrew dates it used to list — expected on HTX, which prunes; a real event anywhere else |
| `backfilled` | published history older than anything it had listed for that shape |
| `infilled` | filled a gap it had previously reported as empty, possibly inside a closed month |
| `reshaped` | started serving already-collected dates under a second filename |

Only what the venue was **asked** about is judged — everything after the cursor the listing
started from, which for a full enumeration is everything. Judging by what came back instead
would miss the one case most worth catching, a venue pruning its oldest files.

Trucker does not act on any of this. It collects what the listing now says and leaves the file
for a human, because the decision — re-tar cold storage, rebuild a partition, retract a published
month — is not one a collector should take on its own. The same file is what a tool building cold
storage should check before it assumes a closed month is still what it was.

## What trucker collects

**107 datasets across 7 venues** — everything each venue publishes as files. The policy is to
take whatever is offered and prune later: a series not collected now is a gap that has to be
backfilled or bought, while a series collected and later judged useless is one `rm`.

| Kind | Count | What it is |
|---|---|---|
| klines | 24 | OHLCV at every interval a venue publishes |
| trades | 18 | Tick-level fills |
| book | 19 | Order books, from OKX's 5000 levels to Bitget's level-1 BBO |
| funding | 9 | Realised and predicted perpetual funding |
| index | 8 | Index and premium-index series |
| mark | 6 | Mark price series |
| metrics | 2 | Binance open interest and long/short ratios |
| liquidations | 1 | Binance coin-margined liquidation snapshots |
| borrow | 1 | OKX margin borrowing rates |

Per venue: gate 39, binance 21, okx 14, bitget 10, htx 9, kucoin 9, bybit 5.

### What the venues publish and trucker does not take

Short list, and every entry is a decision rather than an omission. Anything discovered later
that belongs here is a **dataset added**, which reopens closed months — so it is worth keeping
current.

| Venue | Not collected | Why |
|---|---|---|
| binance | `option/BVOLIndex`, `option/EOHSummary` | Options. A volatility index and end-of-hour option summaries are not a price series: pricing them needs a model, and one chain explodes into hundreds of thin partitions downstream. The same reasoning excludes OKX's option chains. |
| binance | `aggTrades` (spot, um, cm) | **Proven redundant.** Every one of 113,501 ADAUSDT aggregates rebuilt exactly from the raw fills, and `trades` starts earlier (um BTCUSDT 2019-09 against 2020-01) over the same symbol set. |
| gate | `orderbooks_slice` (depth snapshots) | Covers only `BTC_USDT`/`ETH_USDT` per market, and a 20-level snapshot each second adds little over the delta stream already collected, which carries full depth plus every change. |
| gate | TradFi candlesticks | Reachable — `tradfi/candlesticks_1h/202605/XAUUSD-202605.csv.gz` serves 200 at 10s, 1m, 15m, 1h, 4h and 1d. Waiting only on where its contract list comes from: the portal's symbol endpoint carries spot and futures but has no `tradfi` key. |

One thing that looked like a gap and was not: gate's spot candlesticks below 1h are **daily**
files, not monthly, so every monthly URL for them — including the one gate's own form builds —
answers `NoSuchKey`. They are collected, at the right cadence.

Everything else each venue publishes is collected. Checked against the S3 and HTML listings for
binance, kucoin, htx and bybit, and against the download portals for gate, okx and bitget:
kucoin's `depth/` holds only `orderbooklv50`, htx's `orderbook/` only `lv400` (spot) and `lv150`
(futures), bybit has five top-level categories, bitget's index rejects any `businessType` past
its three, and okx's portal offers exactly five products.

### Datasets without a symbol axis

OKX publishes funding and borrowing as **one file per day covering the entire venue** —
`allswap-fundingrates` carries every swap in 12 KB, `allmargin-borrowrates` every margin
currency in 13 KB. A monthly per-symbol form also exists, but the daily-all file is both
complete and thousands of requests cheaper, since most symbols have no rows on most days.

These declare market `ALL` and their `symbols()` returns a single `ALL` placeholder, so one
cursor tracks the whole dataset. Nothing in the core needed changing to support it.

---

## Venue reference

### Binance — `data.binance.vision`

Public S3 bucket, fully enumerable via
`https://s3-ap-northeast-1.amazonaws.com/data.binance.vision?delimiter=/&prefix=…`.

```
data/{market}/{period}/{dataType}/{SYMBOL}[/{interval}]/{SYMBOL}-{dataType}-{date}.zip
                                                      + .CHECKSUM   ← every file
```

| Market | Period | Data types |
|---|---|---|
| `spot` | daily, monthly | `aggTrades`, `klines`, `trades` |
| `futures/um` | daily | `aggTrades`, `bookDepth`, `bookTicker`, `indexPriceKlines`, `klines`, `markPriceKlines`, `metrics`, `premiumIndexKlines`, `trades` |
| `futures/um` | monthly | as daily **plus `fundingRate`**, minus `bookDepth`/`metrics` |
| `futures/cm` | daily/monthly | as `um` **plus `liquidationSnapshot`** (daily) |

Coverage to **2017-08-17** (BTCUSDT spot trades). The only venue supplying checksums.

Collected: trades, klines, the mark/index/premium kline variants, `bookTicker` and `bookDepth`,
`fundingRate`, `metrics` and cm `liquidationSnapshot`. The option series (`BVOLIndex`,
`EOHSummary`) are not — see *Options are not collected*. Note the granularities differ per series and are read from the listing —
`fundingRate` is monthly-only, `metrics`, `bookDepth` and `liquidationSnapshot` daily-only.

`bookDepth` is a trap by name: its columns are `timestamp,percentage,depth,notional`, i.e.
notional sitting within ±% bands of the mid. It is a depth *summary*, **not an order book**.

Klines nest an interval below the symbol (`…/BTCUSDT/12h/…`), so listing the symbol prefix
without a delimiter returns every interval at once and all are collected without enumerating
them. The **monthly kline intervals are a superset of the daily ones** — `1mo`, `1w` and `3d`
exist only monthly, on both spot and um — so taking months before the cutover loses nothing
and gains three series.

Symbols are discovered by listing *both* prefixes and unioning them: most of the history is
taken monthly, so a symbol appearing only under `monthly/` would otherwise never be found.

```
spot trades       772221544,0.16850000,31.20000000,5.25720000,1784851208006037,True,True     ← no header
spot aggTrades    429861665,0.16850000,217.00000000,772221544,772221548,1784851208006037,True,True
spot klines 1m    1784851200000000,65098.98,65113.86,…                                       ← µs timestamps
um trades         id,price,qty,quote_qty,time,is_buyer_maker                                 ← header, ms
um aggTrades      agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker
um bookDepth      timestamp,percentage,depth,notional                                        ← ±% bands, NOT a book
um metrics        create_time,symbol,sum_open_interest,sum_open_interest_value,…long_short_ratio…
um markPriceKlines / indexPriceKlines / premiumIndexKlines   open_time,open,high,low,close,…
um fundingRate    calc_time,funding_interval_hours,last_funding_rate                         ← monthly only
```

Quirks: **spot files carry no header row, futures files do**; spot klines use *microsecond*
timestamps while futures klines use milliseconds.

`trades` is every individual fill; `aggTrades` collapses same-price fills at one instant into
a single row with a first/last trade-id range. Both are collected — aggTrades is smaller and
usually enough, trades is the ground truth, and only the ground truth can be re-aggregated.

### Bitget — `img.bitgetimg.com/online`

No listing: the CDN answers 403 to any directory or bucket-style query, so URLs are
constructed and probed. Three things make it unlike every other venue.

**403 means "does not exist", and the reason is mundane.** Every miss — bogus symbol, bogus
product type, a date below the archive floor, a part number past the end of the chain, and a
genuinely malformed path — returns the same 111-byte
`<Error><Code>AccessDenied</Code></Error>`, while a real file returns 200. That is S3
answering `GetObject` for a missing key when the bucket policy grants `s3:GetObject` but not
`s3:ListBucket`: 403 rather than 404 exactly so the response cannot be used to enumerate keys.
Nothing there ever answers 404.

Under the default rules that 403 reads as a block and would stall the venue on its first
missing file, so Bitget maps 403 → absent via `classify` — but **only when the body is that
AccessDenied document**. A 403 carrying anything else is not the missing-key answer, whatever
it is, and falls through to the default backoff; without the body check a real CDN block would
read as "never published" for every file it covered, and the cursor would step past them all
for good. This does not mask throttling either way: a real rate limit from this CDN arrives
as 429 or 503.

**The archive starts 2024-04-18.** Bisected on BTCUSDT — `20240417` absent, `20240418` present
— identically for spot trades, futures trades and klines. Whether that is a fixed start or the
trailing edge of a rolling retention window is **not established**; it sat 831 days back when
measured, and one observation cannot tell the two apart. A fixed floor is safe either way,
since a floor below a rolling edge costs probes and never data.

Each symbol additionally starts at its own `openTime` from the public API. `launchTime` is
documented but comes back empty for every contract, and `openTime` is populated for 599 of 722
USDT futures and 11 of 16 coin futures, but all 1,181 spot symbols — the blanks are the older
listings, which is why the fallback is the archive floor.

**A day of trades is split across parts** — `…/{date}_001.zip`, `_002`, … — handled by
`continuation`. Verified on BTCUSDT 2026-07-02: four parts, 4.9 MB, terminated by a single
absent probe. Klines are one file per day.

The path layout is inconsistent between the types: trades put the product type before the
symbol (`trades/SPBL/BTCUSDT/…`), klines and depth put the symbol first
(`kline/BTCUSDT/UMCBL/…`, `depth/BTCUSDT/1/…`). The product-type token differs per data type
too — spot trades are `SPBL`, spot klines `SP`, and depth uses bare `1` for spot and `2` for
futures (a spot-only pair such as LTCBTC answers absent under `2`).

**"Depth" here is level 1 only** — `timestamp, askPrice, bidPrice, askVolume, bidVolume`, best
bid and ask over time. It is a BBO series, not a depth ladder, despite the name. Its archive
starts a few months later than trades, around mid-2024.

### `dmcbl-klines` appears to publish nothing — worth confirming by hand

The `dmcbl-klines` dataset has never yielded a file. Every probe returns 403 carrying S3's
`AccessDenied` document, which is this venue's signature for a key that does not exist:

- all **11 DMCBL symbols**, sampled at five points spanning each one's full date range — 55 of
  55 answered 403;
- both path orders tried (`kline/{SYM}/DMCBL/…` and `kline/DMCBL/{SYM}/…`).

The URL construction is not the problem. The same symbol and date under the other product type
returns data — `kline/BTCUSD/UMCBL/20260721.zip` is 200 and 53,962 bytes, against 403 for
`kline/BTCUSD/DMCBL/20260721.zip` — and DMCBL *trades* download normally at
`trades/DMCBL/BTCUSD/…`. So the shape is right and coin-margined klines simply are not published
under `DMCBL`; they appear to live under `UMCBL` alongside the USDT-margined ones.

The dataset is left in place rather than removed, because the cost of it being wrong is zero: it
downloads nothing and records nothing. **Worth confirming against the download portal**, since
everything above is inferred from HTTP responses rather than from anything Bitget states.

**Container formats differ per series**: trades ship a `.csv` inside the zip, while klines and
depth ship an **`.xlsx`**. Anything parsing these must branch on the series, not the extension
of the archive.

### Bybit — `public.bybit.com`

HTML directory listing, scraped for `href`s. No checksums.

| Path | Symbols | Coverage | State |
|---|---|---|---|
| `trading/{SYM}/{SYM}{YYYY-MM-DD}.csv.gz` | 1,818 | 2020-03-25 → current | live |
| `spot/{SYM}/{SYM}_{YYYY-MM-DD}.csv.gz` | 1,053 | 2022-11 → current | live |
| `premium_index/{SYM}/{SYM}{date}_premium_index.csv.gz` | 11 | 2019-10 → **2020-03** | dead |
| `spot_index/{SYM}/{SYM}{date}_index_price.csv.gz` | ~10 | 2019-10 → **2020-03** | dead |
| `kline_for_metatrader4/{SYM}/{year}/{SYM}_{iv}_{from}_{to}.csv.gz` | ~8 | 2020– | live |

Naming is inconsistent across categories (`{SYM}{date}`, `{SYM}_{date}`, `{SYM}-{month}`), so
filenames always come from the listing and are never constructed. The symbol comes from the
listing path, not a filename regex, which is sturdier given the three competing conventions.

The **date** still has to be read from the filename, and the index series put it in the middle
rather than at the end (`BTCUSD2019-10-01_premium_index.csv.gz`). So the date is the last one
appearing anywhere in the name, not the one before the extension — which also keys an MT4 range
by its end, as wanted.

**Perp publishes days only** — 2,316 files on BTCUSDT, not one monthly — while spot lists 44
monthly files alongside their days. MT4 klines carry a date range and are keyed by the **end**
of that range, which is the wanted behaviour: the period is settled once its range is
complete. They also nest a year below the symbol, which the recursive traversal handles.

**No order book data at any level.** `premium_index` and `spot_index` are collected even
though both died in March 2020 — they are small, complete, and the only premium/index history
Bybit ever published.

```
trading (perp)   timestamp,symbol,side,size,price,tickDirection,trdMatchID,grossValue,homeNotional,foreignNotional,RPI
                 1784937600.0683,BTCUSDT,Sell,0.001,64112.90,MinusTick,0f4a3b89-…,…      ← sub-ms timestamps
spot             id,timestamp,price,volume,side,rpi
mt4 kline        2023.01.01 00:00,16581.0,16584.0,16580.5,16584.0,114.627
```

### Gate — `download.gatedata.org`

URLs are constructible, no listing needed:

```
https://download.gatedata.org/{biz}/{type}/{YYYYMM}/{MARKET}-{YYYYMM}.csv.gz
```

`biz` ∈ `spot`, `futures_usdt`, `futures_btc`. Spot calls its trade series `deals`, futures
call theirs `trades`. Symbols come from the public API (`/spot/currency_pairs`,
`/futures/{settle}/contracts`).

**Each symbol starts at its own listing date**, taken from that same answer, which is what
makes a venue with no listing affordable at all: 856 of the 867 USDT contracts began after
2019, so under a 2019 ceiling every month probed below the listing date is a guaranteed 404.
Futures carry `launch_time` and `create_time`, spot `buy_start` and `sell_start`, all in
seconds. **None of them is reliable alone** — Gate's spot pairs disagree between their two
stamps often enough to matter, `PEIPEI_USDT` reading 2024-06-14 to buy and 2020-12-07 to sell —
so the earliest populated stamp is taken, and the archive floor when a market populates none
(80 of 2,237 spot pairs). Too early only costs probes; too late silently skips data that
exists.

The same answer serves symbol enumeration and the floors, cached for 12 hours, so a sweep asks
the API once per market rather than once per dataset.

**Monthly is the only shape offered, at every date**, so the cutover does not apply — there is
nothing to choose between. A month appears only once it has closed (`202607` was 404 while
July was running, `202606` served 200), so the running month is simply absent until it is not,
and the 35-day monthly absence window is what stops the cursor stepping over one that
publishes late.

Five kline intervals are published, verified one by one: 1m, 5m, 1h, 4h, 1d. 15m, 30m and 8h
return 404, so they do not exist rather than being missed.

```
spot/deals                    1767225600.277618,152559793,87645.7,0.000057,1  ← µs, id, price, amount, side(1=sell,2=buy)
futures_usdt/trades           1767225601.477201,643050119,87617.7,7601        ← size sign encodes direction
futures_usdt/candlesticks_1m  1767225600,151037,87617.9,87621.6,87598.1,87617.7
futures_usdt/mark_prices      1767225600.521700,87645.17,87620.82,87617.7
futures_usdt/funding_updates  1767225600,0.0001,0.0003,0,27.31,87620.74,87645.01,480
futures_usdt/funding_applies  1767225600,0.0001
```

Microsecond timestamps throughout, no headers. Breadth is excellent: mark prices, funding
updates *and* funding applies as separate series, all collected.

### Gate's books are hourly, and a delta stream

`orderbooks` is the one series Gate does **not** publish monthly. It is
`{market}/orderbooks/{YYYYMM}/{SYMBOL}-{YYYYMMDD}{HH}.csv.gz` — 24 files per day, verified
spanning exactly one hour each (16:00:00 → 17:00:00 on a sampled file, 327,430 rows). The
earlier assumption that it was monthly is why every guess at it returned 404.

Columns are `timestamp,action,price,size,beginId,merged`, and it is a **delta stream, not
snapshots**: `set` re-benchmarks a level, `take` and `make` adjust it, and size sign encodes
side. One sampled hour held 1,828 `set`, 162,957 `take` and 162,645 `make`.

All 24 files of a day carry the same date, so the day is all-or-nothing to the cursor.
Volume is substantial — BTC_USDT on `futures_usdt` runs ~32 MB/hour, about 765 MB/day.

### HTX — `www.htx.com/data/` (bucket `huobi-service-data`)

S3 XML listing through the website host. The `/vision/` page is only a browser UI over it,
running the same bucket-listing script KuCoin uses — which is why probing hostnames like
`futures.huobi.com/data` found nothing and HTX was once wrongly written off as having no bulk
archive. The listing endpoint 301s without its trailing slash, and files are served under
`/data/`, not the site root.

```
historical_data/{spot|futures}/daily/{type}/{SYMBOL}/…
```

Daily only. Everything it publishes is collected: trades, klines, `funding-rates`,
`index-klines`, `mark-klines`, and the books.

The flat datasets are listed from the cursor via an S3 marker. The filename stem between
symbol and date is not derivable from the path — `funding-rates/` holds
`{sym}-fundingRates-…`, `orderbook/lv400/` holds `{sym}-l2orderbook-400lv-…` — so each stem
was read off a live listing. The kline families nest an interval directory below the symbol,
where a symbol-level marker would sort past the interval directories and skip them, so they
are listed unmarked.

**HTX's book is the second deepest anywhere — `orderbook/lv400` on spot, `orderbook/lv150` on
futures.** It ships as `.tar.gz` rather than the `.zip` used by every other HTX series, so the
listing filter accepts both. Its records carry the same `instId`/`action`/`ts` JSON shape as
OKX's books, which is why the two venues' download portals look and behave alike.

That makes HTX one of the richest archives in the set from a venue with 1.9 % of derivatives
share, which is the general lesson: **market share says nothing about a venue's spot business
or the quality of its archive.** Candidacy is decided by what can actually be obtained.

### KuCoin — `historical-data.kucoin.com`

Bucket `k-line-history-data`, listable through the website host with S3 query params. Files
carry `.CHECKSUM` companions, like Binance.

```
data/{spot|futures}/daily/{type}/{SYMBOL}/{SYMBOL}-{type}-{date}.zip
```

| Market | Types |
|---|---|
| `spot` | `trades`, `klines`, `depth/orderbooklv50` |
| `futures` | `trades`, `klines`, `fundingRates`, `index`, `mark`, `depth/orderbooklv50` |

Daily only, and all of it is collected: trades, klines, `fundingRates`, `index`, `mark` and
the books. `index` and `mark` nest an interval below the symbol exactly as klines do, so a
non-delimited listing picks up every interval at once. The flat datasets (trades,
`fundingRates`, the books) are listed from the cursor via an S3 marker — their filename stem
is the last path segment, verified on live listings — while the nested ones are listed
unmarked, since a symbol-level marker would sort past the interval directories.

**KuCoin publishes 50-level order book history for both spot and futures**, at
`depth/orderbooklv50/` — roughly 43 MB per symbol-day. Symbol naming differs per market
(`BTCUSDT` spot, `BTCUSDTM` futures, `XBTMH25` for dated contracts), so symbols must be read
from the listing.

```
spot trades       trade_id,trade_time,price,size,side
                  8833558834331649,1715558400475,61484.1,0.0000325,BUY
spot klines       time,open,close,high,low,volume,turnover
futures trades    1749781187484,1715644801095,62932.6,6,sell
futures klines    time,open,high,low,close,volume          ← interval in filename (12h, 15m…)
futures funding   symbol,time,fundingRate
orderbooklv50     {"sequence":1745704141177,"asks":[["64734.8",120],…],"bids":[…]}   ← 22 MB/day
```

### OKX — `static.okx.com/cdn/okex/traderecords`

```
…/traderecords/{type}/daily/{YYYYMMDD}/{instId}-{type}-{YYYY-MM-DD}.zip
…/traderecords/{type}/monthly/{YYYYMM}/{instId}-{type}-{YYYY-MM}.zip
```

No file listing exists — none has been found, and the one third-party downloaders use goes
through `api.tardis.dev` rather than OKX itself. A search of the CDN for a directory listing,
an S3-style endpoint, and the `priapi/v5/broker/public/orderRecord` endpoint referenced by
another downloader all returned 404. So URLs are constructed and probed, split at the cutover.

Monthly files are verified present for every month from `202110` to `202606`; `202109` answers
404 at both granularities, so the archive begins in October 2021 even though the portal
advertises September.

Each symbol starts at the later of its own `listTime` (from the instruments endpoint) and the
archive's start. That matters: without it every symbol is probed from 2021 regardless of when
it listed, and a recent listing like `0G-USDT-SWAP` (2025-09-22) burns ~1,480 round trips on
dates that cannot exist.

This is the one venue marked `unreliableAbsence`, on grounds that did not survive checking — see
*Absences that cannot be trusted*.

```
instrument_name,trade_id,side,price,size,created_time
BTC-USDT-SWAP,2802853319,sell,64927.5,0.2,1784822400188
```

**Dated futures are keyed by underlying chain, not by contract**, for every data kind and not
just books:

```
…/trades/daily/20260701/BTC-USD-futureschain-trades-2026-07-01.zip
```

One such file holds every live expiry at once — `BTC-USD-260703` through `BTC-USD-261225` on
the day this was checked — and it is the only way to obtain an expired contract's history,
since nothing is published per contract. Symbols for these datasets are therefore the
underlyings from the instruments endpoint, and the archive start is the **earliest** listing
across the chain rather than any one contract's.

The `futureschain` marker is load-bearing. `BTC-USD-trades-…` also answers 200, but its rows
carry `instrument_name: BTC-USD` — a different series entirely. Omitting the marker does not
fail, it silently collects the wrong data.

**Options are not collected.** Their books exist at both depths and are archived by the venue,
but they are a different instrument class: priced off strike, time to expiry and volatility
rather than a price series, thinly traded, and shipped as chain files bundling hundreds of
series into one archive. Nothing downstream uses them.

The portal advertises five categories — trade history (Sept 2021→), candlesticks (July 2023→),
funding rate (March 2022→), **high-resolution L2 order book (March 2023→)** and borrowing rate
(Dec 2021→). All five are now collected, but two of them live on prefixes no amount of guessing
at the `traderecords` layout would reach; both came from watching what the portal requests.

### Funding and borrowing

```
traderecords/swaprates/daily/{YYYYMMDD}/allswap-fundingrates-{YYYY-MM-DD}.zip
traderecords/borrowrates/daily/{YYYYMMDD}/allmargin-borrowrates-{YYYY-MM-DD}.zip
```

Venue-wide daily files — see *Datasets without a symbol axis*. The plural `swaprates` is the
whole reason earlier `swaprate` guesses failed.

### The L2 book archive

```
okx/match/orderbook/L2/{400lv|5000lv}/daily/{YYYYMMDD}/{instrument}-L2orderbook-{depth}lv-{date}.tar.gz
```

Note the host prefix is `cdn/okx/match/`, not `cdn/okex/traderecords/`.

**The two depths are different data, not one nested in the other.** Measured on the same
BTC-USD day:

| | records/day | ts spacing | levels |
|---|---|---|---|
| 400lv | 2,015,702 | 10–50 ms | 400 |
| 5000lv | 86,074 | exactly 1000 ms | 5000 |

400lv is ~23× finer in time; 5000lv is 12.5× deeper in price. Both carry 96 snapshots a day
(one per 15 minutes) plus updates in between, and neither contains the other — so both are
collected and the choice is deferred to whoever normalises them.

Records are JSON lines: `instId`, `action` (`snapshot` or `update`), `ts`, and `asks`/`bids`
as `[price, quantity, orderCount]`. The same shape as HTX's book files.

Instruments come in two flavours. Spot and swap are per-instrument (`BTC-USDT`,
`BTC-USD-SWAP`) and enumerated from the instruments API with their `listTime`. **Options and
dated futures are published one file per underlying, bundling the whole chain** — a single
`BTC-USD-optionchain` tarball holds 804 option series — so those datasets enumerate the
distinct `uly` values instead, 95 of them for futures.

## Known limitations

- **A file present but corrupt stays skipped.** `exists()` checks presence and non-zero size,
  never integrity. A separate verify pass would be needed.
- **Only two venues ship checksums.** Elsewhere `Content-Length` catches a truncated stream
  but not a corrupt file.
- **A venue that changes its published layout fails silently** in the direction of finding
  nothing, not of downloading wrong data — the listing simply comes back empty.
