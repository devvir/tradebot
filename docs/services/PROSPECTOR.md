# Prospector

## What it is

**Prospector establishes what each venue publishes as files, and keeps that current.** It writes
what it establishes to the catalog database, and it is that database's only writer. It is not its
only reader: the catalog service opens the same file read-only and serves the listings (see
[CATALOG.md](CATALOG.md)). Prospector serves no listing. Its own API, private to the archives
module, starts and pauses surveys, reports where each venue stands, settles reports of what became
of listed files and stores lenses — see [the API](#the-api).

**Every venue publishes its history as files, and no two of them agree about anything else.** The
trees differ, and so do the names inside them. One venue exposes a complete index; another indexes
part of its bucket and leaves the rest reachable but unlisted; another has no index at all and
expects a human at a download form. The vocabulary differs too: one writes `candlesticks_1m` where
another writes `klines/1h`, one calls a perpetual `futures_usdt` and another `SWAP` and another
`linear`, one files a month and another files each day of it, and the date sits wherever that venue
happened to put it.

**Prospector reads each venue in its own terms and records it in one vocabulary.** Markets,
datasets, bar lengths, book depths and dates are canonical — `perp`, `klines`, `1h`, `202406` —
whatever the venue calls them. Each file keeps the venue's own path beside them, so a URL that works
is rebuilt from any row, and which tree a file sits in, how the venue spells its instrument and the
grain it was published at are recorded with it rather than left to be worked out again.

This document is the overview: what prospector produces, how it is built, how a pass runs, its
configuration and its API. Each subject it touches has its own article:

| article | subject |
|---|---|
| [PROSPECTOR-SERIES.md](PROSPECTOR-SERIES.md) | patterns, series, instruments and seeds; the bounds a series carries; which keys an update generates; the preamble; reconciliation; periods published in parts |
| [PROSPECTOR-WALK.md](PROSPECTOR-WALK.md) | walking an archive: mapping it, paging each scope, what a page writes and withdraws, splitting scopes, what is excluded and what goes unread |
| [PROSPECTOR-PASSES.md](PROSPECTOR-PASSES.md) | jobs and their run rows, resuming, scheduling and enrolment, pausing, probing the backlog, and what ends a key |
| [PROSPECTOR-TRANSPORT.md](PROSPECTOR-TRANSPORT.md) | pacing, cadence and concurrency, refusals, retries, how requests are carried, the network gate, and calls to a venue's own API |
| [PROSPECTOR-VENUES.md](PROSPECTOR-VENUES.md) | the venue registry, the hooks the core offers adapters, and how each venue is handled |
| [PROSPECTOR-STORAGE.md](PROSPECTOR-STORAGE.md) | the catalog database: its tables, slices and partitions, migrations and WAL |

## What it produces

A SQLite database: one row per file a venue publishes, carrying its path, the period it covers, its
size, its ETag, and the **series** it belongs to — which market, which dataset, which variant, which
instrument. Beside the files, a record of which parts of each archive have been established, how far
each series has been read, and what became of each file a download was reported for.

That makes a query of what would otherwise take network requests and a reader for every venue's
paths: what does this venue publish, over what period, how many files, how large, where is a given
file, what is that file *of*, and has this part of the archive been established or not. **A survey
answers how much there is before anything is fetched**: this many files, taking this much space,
over these periods.

The catalog is worth persisting because **an archive is stable**: published files rarely change, and
new ones almost always appear at the newest end, so what a survey establishes stays true and there
is no reason to re-derive it on demand.

## The model

Two concepts, and the split between them is the whole design.

**An adapter is one server.** It declares where the archive is, what prefix every key shares, and
how to read a date out of a path. It contains no control flow — if an adapter grows a loop, the
loop belongs in a scanner.

A server rather than a venue, because a venue is not always one address: bybit publishes its order
books on a different host, with a different shape and a different limiter, so it is two adapters
sharing a name. The pair `(name, host)` identifies a server; the name alone still identifies the
venue somebody asks for, and naming it selects both.

**A scanner is one platform**, not one venue. Most servers here publish a standard S3 listing
honouring `prefix` and `marker`, so they share `s3.ts` between them. A second, `html.ts`, reads
browsable HTML directory indexes — the page a plain file server renders when there is no
`index.html`. A third, `probed.ts`, is the description of a venue that cannot be listed at all: it
has no keyspace to walk, so it answers one question only, which is what a `HEAD` says about a single
key; okx and bitget both use it. `none.ts` is the null scanner, for a venue registered before
anything can read it. Each is named after the shape of the thing rather than after a venue, so it
outlives any one venue.

Bybit needs two, and that is what makes the split concrete. Its main archive is a publicly listable
bucket, read with `s3.ts`. Its **order books** live on a different server, `quote-saver.bycsi.com`,
which answers no listing API but serves browsable indexes, so that half is read with `html.ts`. One
venue, two servers, two scanners, and neither adapter knows the other exists.

**Where descent stops is not a wire format**, so the rule lives in one place (`scanners/descend.ts`)
and each scanner only supplies a way to read one level. Paging is where the two genuinely differ: an
S3 scope is a straight line resumed by a marker, while an index directory answers in full and a
walk is a tree traversal resumed by the directory it last read — see
[PROSPECTOR-WALK.md](PROSPECTOR-WALK.md).

The source follows the same split: scanners in `src/scanners/`, adapters in `src/adapters/` with
each venue's strategy (what it lists, how its archive spells an instrument, which shapes it uses)
beside its adapter in `src/adapters/<venue>/`, and everything written once — surveying, generating,
probing, the preamble, reconciliation — in the core. The registry of adapters, and how each venue is
handled, is [PROSPECTOR-VENUES.md](PROSPECTOR-VENUES.md); the steps for adding a venue are in the
[service README](../../services/prospector/README.md#adding-a-venue).

An adapter answers a handful of questions and holds no control flow. Each member's full contract is
its docblock in `src/types.ts`:

| | |
|---|---|
| `name`, `host` | the venue, and which of its servers this is. The pair identifies a server and keys its pacing; `host` is empty for a venue with one server. Every pair needs a row in the `venue` table, or startup refuses the adapter |
| `scanner` | which scanner reads the archive |
| `base` | where files are served, without a trailing slash. Read from the `venue` row at startup, never declared |
| `keyRoot` | the part of every key the venue's files share (`venue.key_root`, read with `base`): where descent starts, and what is stripped from a stored path. Empty means the whole bucket, stripping nothing. A URL is `base` + `/` + `keyRoot` + path |
| `dateOf(path)` | the period a path covers, or null — the one thing no generic rule recovers, since every venue puts the stamp somewhere else |
| `inspectUrl(path)` | what a path **is**: market, dataset, variant, instrument, canonically. Asked only of a key that did not arrive with its series, which is a walk's — a generated key carries its series instead, so a venue that cannot be listed needs none at all |
| `accepts(path)` | **policy**: whether a path belongs in the catalog at all. Asked of prefixes as well as keys, so a refused directory is never descended into |
| `listable` | whether the archive can be listed. False means it never walks: its series are declared and every pass is an update |
| `probes` | whether a walk needs a `HEAD` per file. True for two opposite reasons — a listing that names files and nothing else, and a venue with no listing at all. Every update probes, whatever this says |
| `pacing` | what this host tolerates, beside the evidence for the number. Never configurable: what a venue tolerates is a fact about that venue — see [PROSPECTOR-TRANSPORT.md](PROSPECTOR-TRANSPORT.md) |
| `getContext(db, occasion)` | everything its scanner needs, assembled before a pass — see [below](#a-scanner-is-handed-a-context-never-an-adapter) |
| `slotsFor(at)` | a slot a calendar cannot spell — a month named by both its ends |
| `categoryOf(pattern)` | which keyspace a shape serves, where one canonical market is two archives and a contract domiciled in one can never hold a key in the other |
| `urlSymbolFor(found)` | how the archive spells an instrument. A listing has no path to read it off, so without this a newly listed instrument generates URLs under a name the archive does not use |
| `instruments(db)` | what the venue lists today, for [the preamble](PROSPECTOR-SERIES.md#the-preamble-asking-the-venue-what-it-lists) |
| `notFoundCodes` | the statuses that mean a key is not there. Default `[404]`. Only for a venue where the status alone settles it; where the same status can also mean we are refused, `refusesUs` and `ruleOnFailure` separate the two by headers |
| `refusesUs(status, headers)` | whether a refusal is aimed at **us** or at one key, where the core's reading is wrong. A bucket that answers `403` for every object it never held looks, by status alone, exactly like a ban |
| `ruleOnFailure(row, status, headers, tries)` | what a probe that did **not** settle means here — for that same venue a `403` is its `404`, and re-confirming those absences would spend millions of requests to learn what the first answer said. It sees the row, because what a failure means is often about *which* key failed |
| `probingLag` | how far behind today a probing pass stops asking, in days. Default 1 — yesterday. Set from the venue's measured publication delay — see [how far behind today](PROSPECTOR-SERIES.md#how-far-behind-today-a-probing-update-asks) |
| `expandParts(asked)` | which parts a period was published in, where it takes more than one file — named as tokens for the pattern's `{PART}`, one at a time or all at once. See [a period published in parts](PROSPECTOR-SERIES.md#a-period-published-in-parts) |
| `ruleOnSuccess(row, size)` | what a probe that **did** settle means for the key, where a published key is not the file |

`dateOf` says what a path *is*; `accepts` says what we have *decided about it*. What is refused, at
which of three tiers, and why, is [what is excluded, and
why](PROSPECTOR-WALK.md#what-is-excluded-and-why).

**The `series` table belongs to the core**, in `catalog/series.ts`; no adapter reads or writes those
rows. Every file a venue publishes belongs to a series, so it cannot be a structure some adapters opt
into. What stays with an adapter is the *reading*: how a URL resolves into market, symbol, dataset,
period and pattern, and which of those a given venue can answer at all. The series model is
[PROSPECTOR-SERIES.md](PROSPECTOR-SERIES.md).

### A scanner is handed a context, never an adapter

**A scanner sees only what it was promised.** It is shared by every venue of its shape, so reaching
into an adapter would let it come to depend on anything there; instead the adapter builds a context
and the core carries it down without looking inside. The scanner never sees a database either: it
receives what the adapter assembled, as data.

```
Adapter.getContext(db, occasion)  ->  context
Scanner.scopes(context, limits) · page(context, scope, cursor)
        level?(context, prefix)  · confirm(context, path)
```

For a listing venue that context is the same every time — addresses, the adapter's own `accepts` and
`dateOf`, and **fetchers already bound to the venue's rate gate, its log label and its stop**, so a
scanner cannot outrun a cadence, log as the wrong venue, or keep waiting once the pass is asked to
stop. One factory in `context.ts` builds it for all of them. For okx and bitget it is an address and
a `HEAD`.

**`occasion` says why the context is built:**

| occasion | what it is for |
|---|---|
| `'full'` | a walk |
| `'partial'` | an update: what has appeared since |
| `'lookup'` | **reach nothing.** What an HTTP handler passes to confirm one key inside a request, where fetching would turn a confirmation into an unbounded call |

No adapter's `getContext` reaches its venue on any occasion: every context is the venue's address and
the adapter's own functions, assembled in memory. Asking a venue what it lists is
[the preamble](PROSPECTOR-SERIES.md#the-preamble-asking-the-venue-what-it-lists)'s job, run at the
start of a fresh update before it generates anything.

**Which pass runs is decided by `passFor` (`sync.ts`)**, in this order:

1. a venue that cannot be listed updates, always;
2. a forced update (`update: true`) is an update;
3. a venue whose first walk is not behind it goes on walking;
4. an update already open is finished;
5. otherwise the [walk schedule](PROSPECTOR-PASSES.md#when-an-update-is-a-walk) decides: the pass is
   a walk where one of the venue's days has come round since its last walk began, and an update where
   none has.

## How a pass works

**Resuming, refreshing and updating are not three kinds of run.** A run is a set of scopes, walked in
parallel, each disjoint from the others and each remembering where it got to. Resuming is picking up
the scopes that still have keyspace ahead of their cursors — whether the pause was an API call, a
crash or a kill makes no difference to any of it. Updating is what follows once every scope is
exhausted, and it differs in one respect only: it has to construct the keyspace that did not exist
when the run began, rather than read it. The machinery of jobs, scopes and cursors is
[PROSPECTOR-PASSES.md](PROSPECTOR-PASSES.md).

**An indexed venue** — S3, HTML — does the heavy lifting with the index it has:

1. one scope, the base;
2. mapping splits it into children, and a scope that turns out to hold too much is split again
   while the survey runs — which is what buys concurrency;
3. the walk confirms files, and **every confirmed file records its series**, so the venue maps itself
   as a side effect of being read;
4. the walk completes, and from then on it updates, walking again on the days the
   [walk schedule](PROSPECTOR-PASSES.md#when-an-update-is-a-walk) sets.

**An unindexed venue** — okx, bitget — has no index to walk, so it has no way to map itself that way:

1. its series are declared up front, shipped as a migration;
2. it updates.

There is no splitting and no backfill from an index, because there is nothing to read. **Its heavy
lifting happens as the update step**, which for a fresh catalog means generating every key inside
every series' bounds — the same code path an indexed venue reaches later, doing more work the first
time round.

So the two converge: whatever a venue's scanner is, **once its series are known it updates by
probing**, generating the dates missing between each series' tip and today. That is why every update
probes, whatever the adapter's `probes` says. New instruments reach either kind the same way, through
the venue's instrument listing; only a walk finds a new shape — see [where series come
from](PROSPECTOR-SERIES.md#where-series-come-from).

### The state flow

**A venue's standing is read off its run rows**; nothing records it separately. `phaseOf` reads the
kind of run the venue does — its `walk` rows where it has ever walked, its `update` rows where it
never has (okx, bitget) — so a venue that cannot be listed has these phases too, and one that has
established millions of files is never mistaken for one nobody has surveyed.

| phase | what it means | how it is recognised |
|---|---|---|
| **not run** | nothing has started | no run rows of the venue's kind |
| **planned** | scopes created, none has progressed — a brief moment | open scopes, none with a page read |
| **running** | walking or generating | an open scope that has read a page |
| **complete** | the first pass has covered its keyspace and has not closed yet, while its probe drains | no open scope, and no job has ever closed |
| **updating** | finding files added since | no open scope, and a job has closed before |

**Having been complete once is permanent**: from then on a venue between passes is `updating`, and
whether its next pass walks or updates is `passFor`'s answer (see
[above](#a-scanner-is-handed-a-context-never-an-adapter)). A venue that has walked is read off its
walk rows alone, so an update in progress there also reads as `updating`.

What differs between a walk and an update is only **where the scopes come from**:

| | walking | updating |
|---|---|---|
| scopes | the archive, mapped by the scanner | one per series, read off the table |
| a page | a listing request | dates substituted into a pattern, no request at all |
| splitting | a fat prefix is refined into its children | nothing to split: a series is already the smallest unit |
| withdrawal | a range walked to exhaustion can say a file has gone ([withdrawals](PROSPECTOR-WALK.md#what-a-page-writes-and-what-it-withdraws)) | claims nothing: it only ever asked for what it generated |
| probing | only where the scanner carries no metadata | always, because nothing generated carries any |

Everything after the scopes exist is the same code — the same cursors committed page by page, the
same job that stays open until each is exhausted — which is what makes both stoppable and resumable
by the same machinery.

**A venue that cannot be listed never walks.** okx and bitget both declare `listable: false`: there
is no keyspace to read, their series arrive by declaration, and their very first pass is an update
over them.

### Walking and probing

**Two axes, never mixed.** The *occasion* of a pass is a **backfill** — the first — or an
**update**, every pass after it. The *mechanism* is a **walk**, which reads the venue's listings, or a
**probing run**, which generates keys from the patterns and asks about each. A venue is backfilled by
walking where it can be listed and by probing where it cannot; a listable venue's updates are walks
on the days its [walk schedule](PROSPECTOR-PASSES.md#when-an-update-is-a-walk) sets, and probing runs
otherwise.

**A walk costs the whole archive; a probing run costs its live edge.** Walking re-reads history that
grows every day and is never interesting twice, while probing asks only about the periods each series
has not answered for — so one gets worse for ever and the other converges.

**Per request the comparison can go the other way.** A listing page answers up to a thousand keys and
a probe answers one, so a venue with many open series against a compact archive re-reads all of its
history in fewer requests than a probing run spends asking series by series. And **only a walk
discovers a shape**: a probing run asks about series the catalog holds, at patterns it already knows.

What makes probing safe is that **published files rarely change**. Venues do occasionally publish
something invalid, corrupt or incomplete, but it is rare and never urgent. So what a probing update
does not see is small, and each case is corrected later:

| what a probing update does not see | what the catalog holds until it is corrected |
|---|---|
| a file changed in place | the old size and ETag, until a walk reads the key again or a reported mismatch is confirmed |
| a file was deleted | the file as `confirmed`, until a walk covers where it was or a reported failure is confirmed as absence |

**A late file is the one case only a walk corrects.** A file that arrives *late* is a **new** file
*below* the tip, so no generated range asks for it. A catalog partition (a month of a slice, a row of
`partition`) with nothing `pending` has had every file the catalog knows of reported downloaded; that
is a statement about known files, not a guarantee that the month is whole. What *settled* means for a
partition is defined in [VOCABULARY.md](../VOCABULARY.md#archives).

#### How each venue updates

Measured 2026-09-29 on a catalog rebuilt from nothing, in `run.asked` — one request per listing page
or per probe, HTTP retries excluded, which is what a venue's limit is spent against. The probing
figure is a steady update: one new day due on every active series.

| venue | a walking update | a probing update |
|---|---|---|
| bybit, both hosts | 3,716 + ≈ 2,970 | 3,740 + 15,203 |
| kucoin | 61,857 | 53,114 |
| htx | 64,253 | 46,837 |
| binance | 205,733 | 97,075 |
| gate | 171,466 | 41,042 |
| okx | nothing to walk | 10,139 |
| bitget | nothing to walk | 7,867 |

okx and bitget publish no listing, so every update of theirs probes. For the rest, which updates are
walks is not the venue's to say: see [when an update is a walk](PROSPECTOR-PASSES.md#when-an-update-is-a-walk).

**A walking update costs what the backfill's walk cost**, wherever the listing carries size and
etag. bybit's second host is the exception: its listing names files without describing them, so its
backfill probed every file once — 675,438 probes behind 2,054 pages — while an update probes only
the files it does not hold, about 915 a day.

**A walk is bandwidth, a probing run is requests.** A gate listing page is 335 KB and a probe about
1 KB of headers, so a walk slows with a crowded link where probing barely notices. Durations measured
on a shared link say how venues compare with each other and nothing about what any of them costs
alone.

**A probing update asks twice about a generated key that is not there**, except where the adapter
sets it down on the first answer of absence — see [what ends a
key](PROSPECTOR-PASSES.md#what-ends-a-key-absence-confirmed). It shows as two requests per generated
key wherever nothing new is due.

### Refreshing

**A refresh is not a kind of run.** It is the step before one: `refresh: true` drops the venue's run
rows, so the next pass maps the archive again from nothing and re-walks every scope. Series and files
are untouched — what a venue published is a measurement and stays true; what is discarded is only the
record of how far this service had read.

It has to be a **full re-walk**: new keys are appended within each symbol group rather than
globally, so a new month for `AAVEUSDT` lands at `A…`, behind any cursor already past it. No marker
finds it.

**A refresh costs what a walk of that venue costs.** Where the listing carries size and ETag, a
re-walk writes nothing for a file that has not changed. Where it names files and nothing else, every
key it names that is not already catalogued is parked for a probe, so a refresh is hours of probing —
which is why a resume never becomes one (see [generated keyspace is scopes and cursors
too](PROSPECTOR-PASSES.md#generated-keyspace-is-scopes-and-cursors-too)). At a venue that cannot be
listed a refresh drops the run rows and re-walks nothing: the pass that follows is an update over
the declared series, as every pass there is.

## What it deliberately does not do

- **It fetches no archive data.** It reads listings and metadata, never contents.
- **It decides no venue for itself.** *Whether* a venue is surveyed is somebody's decision, recorded
  in `survey`; a deployment nobody has asked anything of collects nothing, for ever. What it does
  keep is the one schedule that is not a judgement — how often an enrolled venue is re-read, which
  is a day, because that is the grain the archives move at.
- **It does not distinguish a backfill from a refresh.** Both are jobs, and the difference is only
  whether a predecessor's rows were thrown away first.
- **It does not select.** Everything a venue publishes is catalogued, whether or not anyone has a
  use for it, except what is [excluded](PROSPECTOR-WALK.md#what-is-excluded-and-why) as not proper
  historical data. A catalog that only holds what someone already wanted cannot answer what else is
  there.
- **It does not interpret what a file contains.** `market`, `dataset` and `variant` are recorded so
  a consumer can ask by them, but nothing here rules on whether a 50-level book is the same data as
  a 5000-level one, or which of two renderings of a month is the better one. It records that both
  exist and leaves the choice where the use is.
- **It makes no claim about a calendar month.** A listing is ordered by key, not by date, so what a
  survey can establish is a whole prefix — never a month part-way through one. What that implies
  for anything reading the catalog is the reader's business.

## Configuration

The environment variables, their defaults and what each accepts are in the
[service README](../../services/prospector/README.md#environment). Everything else is fixed inside
the container: the catalog lives at `/data/catalog`, where the compose file mounts the host's
`CATALOG_DIR`, and the API listens on `8080`.

- `PROSPECTOR_VENUES` limits which venues this process will survey or resume, and starts nothing on
  its own: whether a venue is surveyed is a request to the API, never a setting.
- `PROSPECTOR_CONCURRENCY` is the machine's ceiling on requests in flight. Why it is the one pacing
  figure an environment sets is [the ticket pool](PROSPECTOR-TRANSPORT.md#the-machine-wide-ticket-pool).
- `CATALOG_TOKEN` is the API's shared secret — see [the API](#the-api).
- Which days a listable venue walks rather than probes is the deployment's
  `src/walk-schedule.yaml` — see [when an update is a walk](PROSPECTOR-PASSES.md#when-an-update-is-a-walk).

What a venue tolerates is not configurable: each adapter declares its pacing beside the evidence for
it ([PROSPECTOR-TRANSPORT.md](PROSPECTOR-TRANSPORT.md#pacing-one-gate-per-venue-per-host)).

## The API

**Private to the archives module.** Prospector publishes no host port: it is reachable only over the
deployment's shared Docker network, on `8080`. It starts, pauses and reports on surveys, settles reports of what became
of listed files, and stores lenses. What the catalog holds is served by the catalog service — see
[CATALOG-API.md](CATALOG-API.md).

**Authenticated with one shared secret**, `CATALOG_TOKEN`, carried in `x-catalog-token`; a wrong or
missing token is a `401`, the two answered alike. An empty `CATALOG_TOKEN` turns the check off, and
config warns at startup, because "nobody set it" and "anyone is welcome" must not look alike. The
server is service-kit's, so body parsing, request logging, `/ping` and rate limiting come with it. A
handler that throws is a `500` that says nothing about the request, while the log keeps the whole of
it.

| | |
|---|---|
| `POST /surveys` | Start or continue. `venue` optional: a name, several, or absent for all. |
| `POST /venues/:venue/surveys` | The same, for one venue named in the path. |
| `POST /surveys/pause` | Stop where it is, keeping every cursor. Same `venue` argument. |
| `GET /status` | Where every venue stands, with its totals, as `{ items: [...] }`. `venue` narrows it. |
| `POST /reports` | What became of listed files, by file id. |
| `POST /lenses` | Store a new lens. |
| `PUT /lenses/:slug` | Change a stored lens. |
| `DELETE /lenses/:slug` | Remove a lens. |

Routes are thin: `api/collector.ts`, `api/reports.ts` and `api/lenses.ts` validate and answer, and
the work is in `collector.ts`, `reports.ts`, `lenses.ts` and `@tradebot/lenses`.

### Surveying

**One verb, because where a venue has got to is not a caller's decision.** A venue with nothing
starts; one with work outstanding continues from its cursors; one already complete finds what has
appeared since. And it does not stop: a surveyed venue keeps itself current, walking once and then
updating daily, **across restarts**, until it is paused or refreshed — see
[enrolment](PROSPECTOR-PASSES.md#enrolment-and-what-a-restart-means).

**A named venue is checked against the registry** — the venues with an adapter and a scanner,
narrowed by `PROSPECTOR_VENUES` — never against the `venue` table, whose rows are shipped data a database built
without it does not have. An unknown name is a `404` naming it and listing the venues there are.

| modifier | |
|---|---|
| `refresh: true` | Throw the progress away and walk it all again — see [refreshing](#refreshing). |
| `update: true` | Skip the wait and update now. |

`refresh` is opt-in precisely so an ordinary request can never silently discard a backfill in flight.

`update` is **refused where no pass has ever completed** on any of the venue's hosts (a venue in its
first walk, or never run, is owed the walk it is already doing) and does **nothing where an update is
open and running**. An update open with nothing working it — what a pause or a killed container
leaves — is resumed, and comes back in `resumed` rather than `started`, because carrying on from
cursors that already exist is not the same thing as planning fresh scopes. Anywhere else a new update
starts, a venue part-way through a later walk included.

The two are mutually exclusive, since one discards the progress the other builds on: asking for both is
a `400`. A forced update that started and resumed nothing is a `409` carrying the reason.

**They are also the only requests that interrupt a venue already surveying**, which they have to be: the
loop does not end on its own, so refusing on that ground would make a refresh impossible for ever after
the first survey. An *ordinary* request on a running venue is answered `already running`, which says the
work is happening rather than refusing it. Both modifiers stop the venue's loop, wait for it to
actually stop, and start it again: resetting under a live walk would drop the rows a scope is still
committing cursors against. The latest request wins — a refresh or forced update still waiting when a
later one, or a pause, arrives gives up without touching anything.

**The request places the order and answers; it does not carry it out.** A survey claims its venue
synchronously — that claim is what stops a second request starting the same one twice — and hands
the passes to the next turn of the loop, so the reply is not held behind every venue's synchronous
prologue (the series registry loaded, a phase read, a probe opened).

The answer says what happened to each venue rather than failing the whole call because one was busy:

```json
{ "at": "…", "started": ["binance", "htx", "kucoin"], "resumed": [],
  "skipped": [{ "venue": "bybit", "reason": "already running" }],
  "phases": { "binance": "updating", "htx": "complete", "kucoin": "not run" } }
```

`phases` is read off whichever kind of run a venue actually does: okx and bitget never walk, so theirs
is read off their `update` rows, and `not run` means a venue that has never been surveyed, or one
being refreshed. It answers as soon as the work is under way; a survey runs for hours.

`POST /venues/:venue/surveys` is a **shortcut, not a second endpoint**: the venue moves from the path
into the same argument the body form fills, so phases, modifiers and refusals are identical by
construction. Where both name a venue, the path wins.

**A pause keeps every cursor**, which is why there is no matching resume verb: starting a paused
venue *is* resuming it, to what the pause interrupted. It is **permanent until then** and survives a
restart, because the pause is a row rather than a flag in memory — see [what a pause
is](PROSPECTOR-PASSES.md#a-pause-is-not-a-cancellation). A venue with nothing running is answered
`not running`.

### Status

A venue's row carries its totals (`firstMonth`, `lastMonth`, `files`, `bytes`, `pending`,
`pendingBytes`, `withdrawn`, and `series`: `withFiles` out of `total`), summed over its hosts, and
where it stands:

| | |
|---|---|
| `state` | `not started`, `starting`, `walking`, `updating`, `waiting` or `paused` |
| `enrolledAt` | when somebody first asked for this venue. `null` where nobody has |
| `since` | when the open job began, or, where paused, when it was stopped |
| `during` | what a pause interrupted, so a reader knows what resuming returns to |
| `nextRun` | when the next update falls due, where the venue is waiting for one |
| `surveying` | whether **this process** has a loop alive for the venue |
| `stopping` | asked to stop, still finishing the page it was on |
| `established` | the earliest of its hosts' [established](PROSPECTOR-PASSES.md#asking-what-is-established) times at the root. `null` where none has one |
| `lastRun` | its most recent pass, below |
| `completedEver` | whether a pass has ever finished on every one of the venue's hosts |
| `listable` | whether there is a keyspace to walk. `false` where the bucket refuses a listing |
| `probing` | whether the venue parks candidate keys: its adapter probes, or its newest pass is an update |
| `wip` | keys parked in `wip`, waiting for an answer |

`lastRun` is the venue's **most recent pass**, whether or not it ended: `{ kind, at, startedAt,
ongoing, first, previous }`. It answers what `established` cannot: that is a completion time, so a venue three
hours into its first walk has none and reads like one nobody has ever surveyed. **`startedAt` is the
run's own start, and `since` is not**: where a venue is paused, `since` holds when it was stopped.
`previous` is set only while a pass runs: the newest pass that finished on any host, `{ at,
startedAt, first }`, where `first` says it finished by the time the last host first completed —
the backfill.

**`state` and `surveying` are deliberately side by side**, because they are different facts: the first
is work the catalog has outstanding, the second is whether anything is doing it. Walking with
`surveying: false` is what a killed container leaves behind, and the one worth acting on.

**`completedEver` is every host, not any.** A venue whose second host has never finished a pass is
half read, whatever the first has done. It is stated rather than left to be inferred: `listable`
misleads on the venues whose first pass is an update, and the newest run's `kind` on any venue that
re-reads itself by walking.

**`paused` and `waiting` are not the same idle.** One is a person's decision that survives restarts; the
other is a schedule.

**`starting` is the one state the rows cannot say.** A pass lists instruments and writes new series
before it opens a job, and until then its rows read exactly as a venue asleep between passes. So it
comes from the process instead, and lasts until the job opens.

**`listable` is what makes `refresh` offerable or not.** A venue whose bucket serves no listing has its
series declared, and every pass is an update over them, so dropping its run rows leaves nothing to walk.

**Resumption is per host, and `state` is per venue.** Bybit's two servers keep separate run rows and
are picked up from their own state, so one can be walking while the other waits; `GET /status`
collapses the pair into one word for the venue.

### Reports

```json
{ "downloaded": [4815162],
  "failed":     [4815163],
  "mismatched": [{ "FileId": 4815164, "Size": 506, "ETag": "…" }] }
```

**A file id is the file's rowid**, which is how this service names a file. The answer counts what was
`recorded`, `withdrawn` and `corrected`, and `unknown` for ids that name no confirmed file. A report
holds at most 10,000 files; more is a `400`.

**The reporter reports problems; this service rules on them.** Nothing a caller sends is taken as fact
about a venue: a file reported as `failed` is asked of the venue, and one of three things follows.

| The venue | The file |
|---|---|
| serves it | stays owed, and comes round again |
| says it does not have it | is ruled absent, so nothing is left outstanding |
| could not be asked, or answered something that says nothing about the file | stays owed; nothing is written |

**What an answer means is the adapter's to say.** A `2xx` is the file. Any other status goes to the
venue's `ruleOnFailure`, which knows how its venue spells absence: `'drop'` is absence and `'keep'`
is not, whatever the status. Where the adapter has no rule, or its rule declines, absence is the
statuses it names in `notFoundCodes` — `404` unless it says otherwise — and every other answer is
unknown. A listing venue is asked for the one key, and a listing that answers without it is absence.
A request that fails or times out is never absence.

One answer is enough. An adapter that wants a venue asked more than once before a file is given up
has the rule to say so. A file ruled absent is withdrawn, as a walk withdraws one — see
[withdrawals](PROSPECTOR-WALK.md#withdrawals). A reported mismatch is confirmed the same way, below.

**Settling is idempotent.** A file reported `downloaded` again is already held, and nothing moves; one
reported `failed` or `mismatched` again is asked of the venue again. A report may be repeated any
number of times.

### When a download does not match

`mismatched` says that the bytes fetched for a file are not the ones the catalog records: a reporter
holding a different size or ETag has found that the archive changed, not hit an error. So the report
carries what was seen.

**Prospector confirms before recording**, through the adapter — a listing venue asks for the one key
and reads the row back, an index venue sends a `HEAD`. It costs one request and fires almost never,
since an archive is insert-only unless somebody's engineering team erred. What it protects against is
a reporter's bug writing nonsense into the catalog, which nothing would notice until the next full
survey.

**ETags are compared case-blind, because the case belongs to the server and not to the file.** OKX
serves the same order-book file from Alibaba OSS and from S3 — byte-identical, same length, the same
md5 in opposite cases. Kept as sent, that reads as a new version: the file's previous version is
appended to `revision` and `downloaded_at` cleared, so a file already on disk becomes one that is
owed. Sightings are stored lower-cased (`etagOf`) and both comparisons lower-case again. Nothing
about a hex digest is case-bearing, so this cannot lose a distinction.

What prospector confirms is what gets written, not what it was told. Agreement makes the observed
version current, moves the displaced one into `revision` with the download state it had, and marks
the file held. Disagreement records what the venue says and leaves the file owed — whatever the
caller holds, it is demonstrably not what is being served — and logs loudly, because that means
either a client bug or a file that changed twice in a minute.

### Lenses

A lens is a named selection of the catalog, stored here because storing it is a write. What a lens is
and how its members are decided is the `@tradebot/lenses` package, which this service calls and does
not own; how lenses are read is the catalog's (see [CATALOG-API.md](CATALOG-API.md#reading-through-a-lens)).

| | |
|---|---|
| `POST /lenses` | `{ slug, name, note, definition }`. `400` without a slug, `409` when the slug is taken, otherwise `201` with the lens |
| `PUT /lenses/:slug` | The fields given replace the lens's own; those left out keep their values. `404` where there is no such lens, `409` when the new slug is taken, otherwise `200` with the lens |
| `DELETE /lenses/:slug` | The lens and its members. `204`, or `404` |

**A write answers as soon as the row is stored**, and nothing about the lens is validated here beyond
the slug it is addressed by. The row is written where the request is handled, not in the serial write
queue the survey's writes wait in: every write here is synchronous from `BEGIN` to `COMMIT`, so a
handler finds nothing half done, and that queue can be seconds deep while a venue is walked.

**What a lens lets through is worked out afterwards.** A lens whose definition is new or changed
carries `updating: true` until then. `src/lenses.ts` works it out in one pass, five seconds after the last
save of a run of saves, and a round every thirty seconds brings every lens up to date with whatever
partitions it has not looked at; a lens that cannot be brought up to date is logged and tried again
the next round. A partition is taken into its lenses in the transaction that creates it
(`catalog/cache/partitions.ts`), so a lens never meets a partition it has not looked at.

## Storage

One SQLite file, `catalog.db`, in WAL mode. **Prospector creates and migrates it, and is the only
thing that writes it — every row of every table, lenses included**; readers open it read-only beside
it. Its tables hold what each venue serves and what became of it, the patterns, series and
instruments it is published as, the slices and partitions it is cut into, the run rows that say how
far each pass has read, enrolment, the exclusion and unreadable lists, and the stored lenses. The
schema, the migrations and why there is one writer are [PROSPECTOR-STORAGE.md](PROSPECTOR-STORAGE.md).
