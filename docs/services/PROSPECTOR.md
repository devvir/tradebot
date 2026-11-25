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
S3 partition is a straight line resumed by a marker, while an index directory answers in full and a
walk is a tree traversal resumed by the directory it last read.

The source follows the same split: scanners in `src/scanners/`, adapters in `src/adapters/` with
each venue's strategy (what it lists, how its archive spells an instrument, which shapes it uses)
beside its adapter in `src/adapters/<venue>/`, and everything written once — surveying, generating,
probing, the preamble, reconciliation — in the core. The steps for adding a venue are in the
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
| `pacing` | what this host tolerates, beside the evidence for the number. Never configurable: what a venue tolerates is a fact about that venue |
| `getContext(db, occasion)` | everything its scanner needs, assembled before a pass — see [below](#a-scanner-is-handed-a-context-never-an-adapter) |
| `slotsFor(at)` | a slot a calendar cannot spell — a month named by both its ends |
| `categoryOf(pattern)` | which keyspace a shape serves, where one canonical market is two archives and a contract domiciled in one can never hold a key in the other |
| `urlSymbolFor(found)` | how the archive spells an instrument. A listing has no path to read it off, so without this a newly listed instrument generates URLs under a name the archive does not use |
| `instruments(db)` | what the venue lists today, for [the preamble](#the-preamble-asking-the-venue-what-it-lists) |
| `notFoundCodes` | the statuses that mean a key is not there. Default `[404]`. Only for a venue where the status alone settles it; where the same status can also mean we are refused, `refusesUs` and `ruleOnFailure` separate the two by headers |
| `refusesUs(status, headers)` | whether a refusal is aimed at **us** or at one key, where the core's reading is wrong. A bucket that answers `403` for every object it never held looks, by status alone, exactly like a ban |
| `ruleOnFailure(row, status, headers, tries)` | what a probe that did **not** settle means here — for that same venue a `403` is its `404`, and re-confirming those absences would spend millions of requests to learn what the first answer said. It sees the row, because what a failure means is often about *which* key failed |
| `probingLag` | how far behind today a probing pass stops asking, in days. Default 1 — yesterday. Set from the venue's measured publication delay — see [how far behind today](#how-far-behind-today-a-probing-update-asks) |
| `expandParts(asked)` | which parts a period was published in, where it takes more than one file — named as tokens for the pattern's `{PART}`, one at a time or all at once. See [a period published in parts](#a-period-published-in-parts) |
| `ruleOnSuccess(row, size)` | what a probe that **did** settle means for the key, where a published key is not the file |

### A scanner is handed a context, never an adapter

**A scanner sees only what it was promised.** It is shared by every venue of its shape, so reaching
into an adapter would let it come to depend on anything there; instead the adapter builds a context
and the core carries it down without looking inside.

```
Adapter.getContext(db, occasion)  ->  context
Scanner.scopes(context, limits) · page(context, scope, cursor)
        level?(context, prefix)  · confirm(context, path)
```

For a listing venue that context is the same every time — addresses, the adapter's own `accepts` and
`dateOf`, and **fetchers already bound to the venue's rate gate and log label**, so a scanner cannot
outrun a cadence or log as the wrong venue. One factory in `context.ts` builds it for all of them. For
okx and bitget it is an address and a `HEAD`.

**`occasion` says why the context is built**: for a walk (`'full'`), for an update (`'partial'`), or
to confirm one key inside a request (`'lookup'`), for which an adapter must reach no venue — see
[`getContext` and the occasion](#getcontext-and-the-occasion). No adapter's `getContext` reaches its
venue on any occasion; asking a venue what it lists is [the preamble](#the-preamble-asking-the-venue-what-it-lists)'s
job, run at the start of a fresh update.

**Which pass runs is decided by `passFor` (`sync.ts`)**, in this order:

1. a venue that cannot be listed updates, always;
2. a forced update (`update: true`) is an update;
3. a venue whose first walk is not behind it goes on walking;
4. an update already open is finished;
5. otherwise the [walk schedule](#when-an-update-is-a-walk) decides: the pass is a walk where one of
   the venue's days has come round since its last walk began, and an update where none has.

### A seed is research before it is data

**A seed is what a walk would have produced.** The two are not different designs. A catalog starts
from a search space — the patterns, a series for every instrument that ever occupied one, the floor
each shape starts at — and every pass after that generates keys from it and records what answers. A
walk produces that search space as a by-product of reading an index once; a seed states it directly.
Discard everything a walk learned except those three and hand them over as a seed, and the first
update rediscovers the files and arrives at the same catalog. What a seeded venue is owed is
therefore not a different kind of pass, it is the backfill a walk would have done for free — and the
work of establishing its search space, which for an unlisted venue is research rather than reading.

**Neither kind discovers a pattern on an update.** Only a walk creates one, from a path handed to it
by an index; an update generates keys from patterns already held and can never meet a shape it has
no pattern for. So a venue that changes its naming convention costs a listed venue a re-walk and an
unlisted one another round of research.

**At a venue that cannot be listed, what only a seed can supply is narrower than it looks:**

| | where it comes from |
|---|---|
| **a pattern** | the seed, and nothing else. An update generates from shapes it already holds and can never meet one it has no pattern for, so a shape absent from the seed is invisible for ever |
| **a series for an instrument the venue still lists** | the seed *or* the preamble. A listing names it and the preamble gives it a series per shape of its market, exactly as at any other venue |
| **a series for an instrument nothing lists any more** | the seed, and nothing else. No API names a delisted symbol, and its files are in the archive all the same |
| **a floor** | the seed. Generation starts above a tip and a tip only ratchets forward, so history below a seeded floor is asked about by nothing afterwards |

**So discovery is not what separates the two kinds of venue.** Every venue with an `instruments`
hook, listed or not, discovers new instruments the same way: the preamble asks the venue's instrument
listing. What differs is only how the backfill happened — a listed venue found its patterns, its
series and its files in one walk, while an unlisted one was handed patterns and series and then
guessed keys and confirmed them.

The seed format, and how a research seed becomes a permanent one, are in the
[seeds README](../../services/prospector/src/database/migrations/seeds/README.md).

**`first` and `last` are the oldest and newest file the catalog holds for the series.** A sighting
widens them (`sawFile`), and a finished pass resets both to what `file` holds (`reconcile`), which is
how a withdrawal narrows them; `last` is never a ceiling on generation. See [the three bounds a series
carries](#the-three-bounds-a-series-carries).

**The `series` table belongs to the core**, in `catalog/series.ts`; no adapter reads or writes those
rows. Every file a venue publishes belongs to a series, so it cannot be a structure some adapters opt
into. What stays with an adapter is the *reading*: how a URL resolves into market, symbol, dataset,
period and pattern, and which of those a given venue can answer at all.

`dateOf` says what a path *is*; `accepts` says what we have *decided about it*.

What is refused, at which of three tiers, and why, is
[what is excluded, and why](#what-is-excluded-and-why).

## The lifecycle, end to end

**Resuming, refreshing and updating are not three kinds of run.** A run is a set of scopes, walked in
parallel, each disjoint from the others and each remembering where it got to. Resuming is picking up
the scopes that still have keyspace ahead of their cursors — whether the pause was an API call, a
crash or a kill makes no difference to any of it. Updating is what follows once every scope is
exhausted, and it differs in one respect only: it has to construct the keyspace that did not exist
when the run began, rather than read it.

**An indexed venue** — S3, HTML — does the heavy lifting with the index it has:

1. one scope, the base;
2. mapping splits it into children, and a partition that turns out to hold too much is split again
   while the survey runs — which is what buys concurrency;
3. the walk confirms files, and **every confirmed file records its series**, so the venue maps itself
   as a side effect of being read. The tip moves as each row reaches `file`, which is an answer;
4. the walk completes, and from then on it updates, walking again on the days the
   [walk schedule](#when-an-update-is-a-walk) sets.

**An unindexed venue** — okx, bitget — has no index to walk, so it has no way to map itself that way:

1. its series are declared up front, shipped as a migration;
2. it updates.

There is no splitting and no backfill from an index, because there is nothing to read. **Its heavy
lifting happens as the update step**, which for a fresh catalog means generating every key inside
every series' bounds — the same code path an indexed venue reaches later, doing more work the first
time round.

So the two converge: whatever a venue's scanner is, **once its series are known it updates by
probing**, generating the dates missing between each series' tip and today. That is why every update
probes, whatever the adapter's `probes` says.

Two things this shorthand gets wrong if it is compressed any further:

- **"Unindexed venues need a migration" is not true.** A seed saves re-paying for bounds already
  measured. A venue with no seed builds its series the way a seeded venue builds one for a symbol that
  lists tomorrow — instrument listing for the universe, probing for the bounds.
- **"Unindexed venues don't discover series" is not true either.** Nothing discovers by probing; the
  preamble that starts an update asks the venue's instrument API. An indexed venue needs exactly the
  same thing once its walk is behind it, so discovery-by-API is what *updating* requires, not what
  *being unindexed* requires.

What neither path covers is a **new dataset or a new pattern**: probing cannot see one and the
instrument API does not name one. Only a walk finds one, which is why a listable venue is walked
again on a schedule.

## The state flow

**A venue's standing is read off its run rows**; nothing records it separately. `phaseOf` reads the
kind of run the venue does — its `walk` rows where it has ever walked, its `update` rows where it
never has (okx, bitget) — so a venue that cannot be listed has these phases too, and one that has
established millions of files is never mistaken for one nobody has surveyed.

| phase | what it means | how it is recognised |
|---|---|---|
| **not run** | nothing has started | no run rows of the venue's kind |
| **planned** | partitions created, none has progressed — a brief moment | open partitions, none with a page read |
| **running** | walking or generating | an open partition that has read a page |
| **complete** | the first pass has covered its keyspace and has not closed yet, while its probe drains | no open partition, and no job has ever closed |
| **updating** | finding files added since | no open partition, and a job has closed before |

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
| withdrawal | a range walked to exhaustion can say a file has gone ([withdrawals](#withdrawals)) | claims nothing: it only ever asked for what it generated |
| probing | only where the scanner carries no metadata | always, because nothing generated carries any |

Everything after the scopes exist is the same code — the same cursors committed page by page, the
same job that stays open until each is exhausted — which is what makes both stoppable and resumable
by the same machinery.

**A venue that cannot be listed never walks.** okx and bitget both declare `listable: false`: there
is no keyspace to read, their series arrive by declaration, and their very first pass is an update
over them.

**A reset is not a kind of run.** It is the step before one: `refresh: true` drops the venue's run
rows, so the next pass maps the archive again from nothing. Series and files are untouched — what a
venue published is a measurement and stays true; what is discarded is only the record of how far this
service had read.

## Walking and probing

**Two axes, never mixed.** The *occasion* of a pass is a **backfill** — the first — or an
**update**, every pass after it. The *mechanism* is a **walk**, which reads the venue's listings, or a
**probing run**, which generates keys from the patterns and asks about each. A venue is backfilled by
walking where it can be listed and by probing where it cannot; a listable venue's updates are walks
on the days its [walk schedule](#when-an-update-is-a-walk) sets, and probing runs otherwise.

**A walk costs the whole archive; a probing run costs its live edge.** Walking re-reads history that
grows every day and is never interesting twice, while probing asks only about the periods each series
has not answered for — so one gets worse for ever and the other converges.

**Per request the comparison can go the other way.** A listing page answers up to a thousand keys and
a probe answers one, so a venue with many open series against a compact archive re-reads all of its
history in fewer requests than a probing run spends asking series by series. And **only a walk
discovers a shape**: a probing run asks about series the catalog holds, at patterns it already knows.
A newly listed instrument arrives through [the preamble](#where-new-instruments-come-from); a new
shape is found by walking or not at all.

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
partition is defined in [VOCABULARY.md](../VOCABULARY.md).

### How each venue updates

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
walks is not the venue's to say: see [when an update is a walk](#when-an-update-is-a-walk).

**A walking update costs what the backfill's walk cost**, wherever the listing carries size and
etag. bybit's second host is the exception: its listing names files without describing them, so its
backfill probed every file once — 675,438 probes behind 2,054 pages — while an update probes only
the files it does not hold, about 915 a day.

**A walk is bandwidth, a probing run is requests.** A gate listing page is 335 KB and a probe about
1 KB of headers, so a walk slows with a crowded link where probing barely notices. Durations measured
on a shared link say how venues compare with each other and nothing about what any of them costs
alone.

**A probing update asks twice about a generated key that is not there**, because a 404 a moment
before publication is truthful and wrong — except where the adapter's `ruleOnFailure` answers `drop`
on the first answer of absence. `probingLag` already keeps the frontier past each venue's
publication delay, so the second ask buys little; it shows as two requests per generated key
wherever nothing new is due. The rule is in [what ends a key](#what-ends-a-key-absence-confirmed). A
404 or 403 is never retried at the HTTP level — only 5xx, 429 and transport failures are.

### How far behind today a probing update asks

**No venue publishes a period within a day of it starting**, so a frontier at yesterday asks every
one of them about files that cannot exist yet. Each venue's measured publication delay — hours from
the start of the dated day to the file's `Last-Modified`, at p50 and p99 — is in that venue's doc
under [docs/venues/](../venues/).

A pass at hour `H` (UTC) needs `probingLag >= (p99 - H) / 24`. Each adapter that declares a lag sets
a day more than that rule gives for a pass at midnight, since a publishing hour that drifts later
would put the frontier in front of the archive:

| adapter | `probingLag` |
|---|---|
| binance | 3 |
| bitget | 4 |
| bybit, both hosts | 3 |
| gate | 1, the default: gate declares none. That is below what the rule gives for its measured delay, so a pass early in the UTC day asks about some keys before they are published; the cost is those requests, and nothing is lost |
| htx | 3 |
| kucoin | 3 |
| okx | 3 |

**Nothing is lost by asking late**: the frontier advances a day every night and the patience window
covers what it has not reached. **Measuring the delay from `series.last` is a trap** — the newest
file per series says when the catalog last looked, not when the venue published.

## How an update finds files

**The index is a bootstrap device, not a permanent dependency.** A full sweep is how everything is
discovered — the symbols, the datasets, the URL shapes, the gaps, the conventions nobody wrote down.
That is worth paying for once. Afterwards an update does not need to be told what exists: it needs
the next file of each thing already known.

So an update reads no listing at all, and it is not a scanner that does the work. `update.ts` builds
a page the same way for every venue: **one scope per live series, and the dates between its tip and
the last complete period substituted into its pattern.** Nothing is fetched to produce them, so a
page costs no request and every key it yields is a candidate — which is why probing is always on
during an update, including for venues whose walks never probe.

**Resumability is unaffected.** Scopes and cursors do not care that nothing was fetched to produce
them: a cursor over generated keyspace is a period, and it behaves exactly as a marker over a
listing does.

**Per-venue variation is two optional hooks, not a generator each.** `slotsFor` renders a slot a
calendar cannot spell, and `expandParts` names the files a period was published in where it took more
than one. Everything else is substitution over rows, so a venue that needs neither adds no code to
this path at all.

**Nothing here discovers.** Generating can only extend series that already exist, so an instrument
listed this morning arrives some other way — see [where new instruments come from](#where-new-instruments-come-from).

### Where new instruments come from

**A pattern has the instrument as a slot; a series is one instrument's occupancy of it.** So a venue
listing a new symbol needs new **series** rows — one against each pattern of its market — and no new
pattern at all. A new *pattern* means something else entirely: the venue changed the shape of a URL.

Those series arrive three ways. **A walk** creates a series from the first file it reads under a new
name, and **a seed** declares series for a venue that cannot be listed. **The preamble** asks the
venue what it lists at the start of every update that is not a resume, on every venue with an
`instruments` hook, listable or not; a walk never runs it. It creates series for newly listed
instruments, marks departed ones `delisted`, and backfills the series it creates — see
[the preamble](#the-preamble-asking-the-venue-what-it-lists), which also covers the listing it
refuses because its names do not match the files. Probing can only ask about series already known,
so for okx and bitget the preamble is the only way a new instrument arrives after the seed.

A walk remains the authority on what an archive holds. The preamble creates series from a listing,
and the files then decide which of them stay: see [what a completed pass is
worth](#what-a-completed-pass-is-worth).

### The patterns are read out of the paths

Nothing writes a URL template by hand. An adapter's `inspectUrl` takes a path apart — which market,
which dataset, which variant, which instrument, which date — and `patternise` in `paths.ts` puts the
instrument and the stamp back as slots, so the pattern is the path with its two varying parts
replaced. `.../klines/BTCUSDT/1h/BTCUSDT-1h-2026-08.zip` becomes
`.../klines/{SYMBOL}/1h/{SYMBOL}-1h-{YYYY}-{MM}.zip`, both occurrences and all.

**That is deliberate, and it is the reverse of what it looks like.** Hand-writing one template per
dataset would be the same knowledge written twice — the expression that reads a path and the string
that rebuilds it — free to disagree the moment either is edited. Derived, they cannot: the pattern a
series generates into is literally the path a walk read.

A venue that constructs its keys has no walk to read from, so its patterns arrive with its seed,
written the same way, from paths the research behind its seed confirmed.

**A generated key is never read back.** `updatePage` builds it from a series, so which series it
belongs to is a fact before the request is made, and it travels with the key as `Listed.seriesId`
rather than being recovered from the path. Round-tripping `keyFor` through `inspectUrl` could only
agree or be wrong, and being wrong is silent: a file filed under a neighbouring instrument. So the
reader runs where the source did not answer the question: on a walk, where the index offers a path
and nothing else.

### What a pattern cannot spell, one instrument at a time

A pattern substitutes one instrument and one stamp, and that is deliberately all it does. Where a
key needs a *second* string — a directory that is not the name the filename uses — or a segment that
belongs to the instrument rather than to its market, a shape says `{TRANSFORM:kind:default}` and the
**`transform` table** answers it, per instrument, per dataset, over a span of dates. Where there is
no row the default stands and the key rejoins the ordinary path, so one shape serves the whole
market and the handful that depart from it.

**It is an exception, not a shape.** What a market does is a pattern; a venue reassigning one
instrument's directory, or filing one contract under a segment its siblings do not use, is not a
template anybody could write. A `url_symbol` cannot express it either: that is one string per
series, and these are two different strings inside one key.

**A wrong default is silent, which is what decides where these are written.** The key it builds is
well formed, the venue answers that it is not there, and that is indistinguishable from an
instrument that published nothing — so the series never finds a start and nothing says why. The
answer is known in exactly one place, the listing that named the instrument, and it is known nowhere
afterwards: not in the symbol, not in the market, not in any path. So a listing may hand its
transforms over with the instrument, and the preamble writes them **before** it creates that
instrument's series — a row written after would sit unread until something reloaded the registry,
which on a service that stays up is never.

That is why **okx and bitget have no `inspectUrl` at all**. Neither can be listed, so every key they
meet was generated, and the translation they need is one-way: attributes to URL, which is `keyFor`
substituting a date and a symbol into the pattern the series carries. The date is the one thing
still read from the path, by `dateOf`, which stays the single authority on it — a second source for
the same fact is a second thing that can disagree.

## What a survey does

### 1. Map the archive

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
until it holds as many partitions as the walk has lanes, and treats a prefix as terminal when either
of two things is true:

| condition | why |
|---|---|
| **catalogable** files sit directly under it | replacing it with its children would silently drop them. On S3 such a prefix is split by character instead — see [below](#partitions-split-themselves) |
| it has no children | nothing to split |

**It only has to be roughly right.** A partition that turns out to carry a disproportionate share of
the archive is split again while the survey runs — see *[Partitions split themselves](#partitions-split-themselves)*
— so a poor first guess costs a few listings rather than the whole pass.

**The key root is always expanded**: it is the venue as a whole, which the job itself covers, so it
is never a partition. A root holding a catalogable key of its own cannot be partitioned at all — that
key would sit inside no child — and the survey refuses it.

**A level is read to `IsTruncated`, not to the first page.** A `delimiter=/` reply is capped like any
other, with child directories and keys sharing the 1000-entry budget, so a level wider than a page
arrives cut off. The answer that loses data is whether files sit here: a dated key sorting past the
cut reads as "no files here", the prefix is replaced by its children, and that key belongs to no
partition at all. S3 states outright whether it held anything back, so it is asked. Splitting reuses
this reader, so a truncated child list would equally close a partition over children nobody walked.

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
exclusion table a partitioning lever as well as a cataloguing one.

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

### 2. Walk each partition

Descent yields **scopes**; committing them to the catalog turns them into **partitions**, which is
what the rest of a job deals in. The two words name the same prefixes on either side of that line —
a scope is a proposal, a partition is written down and has a cursor.

Each partition is paged to exhaustion, several at a time. What a page *is* depends on the platform,
and it is the one place the two scanners genuinely part company.

#### On a listing venue

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

#### On an index venue

There is no marker to page with: a directory answers in full or not at all. So a page is **one
directory**, and a walk is a depth-first traversal of the partition's tree rather than a straight
line through a keyspace.

That costs nothing in resumability, because depth-first with children in sorted order visits paths in
exactly the order they sort — a directory, then everything beneath it, then its next sibling. So the
directory just read is the whole of a walk's state: everything at or below it is done, and the next
page is the first directory above it, which the tree itself answers. A partition resumes from one
short string exactly as a listing venue resumes from a marker, and a subtree that ends before the
cursor is skipped by comparing two strings rather than opening it.

Directories already read are remembered for the length of the process so each costs one request, and
nothing is ever answered from a memory this job did not fill — a parent is always read before its
children, so a symbol added since last month cannot hide behind a stale answer.

#### What a page writes, and what it withdraws

**A page states its stretch of the keyspace in full**, and says which stretch that is (`covers`):

| scanner | a page covers |
|---|---|
| S3 listing | every key after the marker it was asked with, through the marker it hands back — or from the partition's start on its first page, to its end on its last |
| index | its directory's own files, and below it only the subdirectories it links |

Both are checked, not assumed: every S3-protocol venue answered strictly in byte order on
2026-10-03, which is the order `path` sorts in; and an index walk gives every directory of a
partition its own page, files or not.

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
per page, before the page is cut into write slices; a key that is about to be written, parked or
withdrawn is looked up again inside the slice that writes it, since another writer may have touched
it in between, and a key that said nothing new is skipped on the read's word.

Of everything that discovers files, only a walk withdraws. Keys that reach the catalog any other
way — a backfill, a probe's answer — cover no stretch, and say nothing about what is no longer there.
A probe that keeps missing a key gives up on a row in `wip`; it never touches a row in `file`. The
one other way a file is withdrawn is a download report the venue confirms — see
[Withdrawals](#withdrawals).

#### Withdrawals

**A file is marked `absent` in two places and no others**: a walked page that covers where it is and
does not list it, and a download report the venue confirms. Its row stays, with its history; only
`existence` changes, and the partition's counts and version move with it.

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

### Partitions split themselves

The mapping only has to be roughly right, because a partition that turns out to hold too much is
split while the survey runs. **The signal is idle workers** — the very thing a good split exists to
avoid, measured directly rather than predicted from a directory's shape.

```
a lane finds the queue empty
  → nothing running?                 the survey is over
  → the busiest running partition:   pause it, list its level, replace it with its children
  → nothing left that can be split?  stop asking
```

**The busiest is the one deciding when the survey ends**, and `run.requests` already counts its
pages, so it identifies itself. Splitting anything else terminates just as surely and helps just as
little.

**A walk is paused between pages, never interrupted mid-page.** `sweep` commits its cursor after
every page and returns without closing the run, so what a pause leaves behind is a partition that
knows exactly where it reached. Splitting under a running walk would race that cursor and hand the
children a position their parent had already passed.

**The cursor divides by where it falls**, which is sound because both scanners walk in order — a
lexical key walk on S3, a sorted depth-first traversal on an index:

```
parent at  P/c/key-0400
  P/a/  P/b/   entirely behind it   → already walked, no partition made
  P/c/         contains it          → inherits it, resumes mid-way
  P/d/  P/e/   ahead of it          → fresh partitions
```

The swap is **one transaction** — parent closed, children written, one job epoch shared. A crash
between the two halves would leave a stretch of keyspace belonging to nothing, and the work list is
the partitions, so nothing would ever notice.

Two guards keep a split from destroying what it was meant to divide:

- **A prefix holding a catalogable file of its own is never split by directory.** A parent covers
  every key beneath it; its children cover only their subtrees, so a key sitting directly there
  would belong to none of them. **On S3 it is split by character instead**: any string is a prefix,
  so `…/202505/` divides into `…/202505/A`, `…/202505/B` and so on, which between them hold every
  key beneath it. The characters are found by skipping (ask for the first key after a marker, note
  the character it continues with, move the marker past that character), one request each, so a
  flat month of tens of thousands of files splits in a few dozen requests. They are read rather than
  assumed because gate publishes symbols written in Chinese. Without this a flat month is one serial
  walk while every other lane stands idle. A prefix
  that is itself a key stays whole, and so does one whose venue ignores the marker. An HTML index
  cannot be listed by an arbitrary prefix, so there a prefix holding files stays whole.
- **A split that would produce no children leaves the run open.** Every child sorting behind the
  cursor means the prefix is genuinely finished — but so does a child list that came back short, and
  the two are indistinguishable from here. Leaving it open costs one more pass; closing it wrongly
  loses the keyspace in silence.

**It terminates** because every path shrinks the problem: a split replaces a prefix with strictly
longer ones over a finite tree, and a prefix that cannot be split is remembered so it is never
examined twice. When everything running is terminal, refinement is over and idle workers become a
fact to accept rather than a condition to retry.

**A split is bounded, because everything waits on it.** The partition is stopped for it and every
idle worker is parked on its answer, so a split that does not come back is the whole survey
standing still. One that takes more than five minutes is abandoned: the partition resumes whole and
is not offered for splitting again that pass — the cost of a prefix that could not be split, and no
more. The walk's 30-second heartbeat (`Walking`) carries its request rates, the host's limiter state and the
machine's ticket pool, so a request that is not going out says which of the two is holding it.

**At `LOG_LEVEL=debug` it also says where requests spend their time** (`timings`): average and 90th percentile, in
milliseconds, of each part of a request's way since the previous line — waiting for a slot, the trip
to the transport worker, the venue's first byte, the body, reading the page, and the page's processing
after its slot is given back. Only the last runs without a slot. See `timings.ts`.

### 3. Record

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
into the catalog, bare ones into `wip` until a probe settles them and promotes them.

That is what keeps `file` holding exactly one kind of row. No query works around half-known files,
`bytes` is a real total rather than a lower bound, and the probe reads a small table of its own
rather than a partial index over the largest one. Three rules make it safe, and all three are the
same rule in different places: **ready stays ready** (an index venue re-offers the same bare names on
every walk, and a bare sighting of a catalogued file writes nothing), a withdrawal reaches `wip` too, and arriving is first discovery rather than a revision.

**Rows carry who named them.** A listing cannot name a key that is not there, so a walk's findings
land as `existence = 'confirmed'`; keys an update built from a pattern and a date land as
`'assumed'`, because nothing has seen them. That is a property of the candidate rather than of the
pass that parked it, which is what lets an update drain a walk's leftover backlog without treating
its keys as guesses — a distinction the pass kind alone gets wrong after a restart.

## What is excluded, and why

**Everything a venue publishes is catalogued except what is refused here**, and only what is **not
proper historical data** is refused: a bucket's web assets, a venue's staging area, temporary files,
and files served with corrupt or wrong contents. Not data that is merely unannounced, unreliable or
superseded — an abandoned earlier generation of a month is still that month, and a catalog that has
already decided against it cannot be asked for it. Nothing is skipped for being hard to parse either:
a path that survives these rules and cannot be placed is written to **`unreadable`** rather than
passed over, because a file nobody parses is a series nobody tracks.

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
catalog rebuilt from scratch walks the same files again — a walk of gate's 2021-07 lists its 85
spot files at futures URLs again unless something refuses them. The shipped rows are written for
every server of their venue.

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
two zero-byte uploads and 85 spot files served at futures URLs, and bybit's one misfiled day. How each
venue's refusals were chosen, where that is this service's decision rather than the venue's fact, is
under [venue by venue](#venue-by-venue).

### Not an exclusion: the venue's key root

The key root is where a walk **starts**, not a filter. binance has none, so `data/` is simply part of
every catalog path; kucoin's is `data/`, bybit's second host `orderbook/`, and the catalog stores
paths relative to it. Everything beneath is walked. A key root is always part of the venue's keys —
a path that only addresses the venue, such as a bucket name or okx's `cdn/`, belongs in `base`.


## Jobs: resuming and refreshing

One pass over a venue is a **job**, and it is the only unit here. A job is a row at the empty scope
plus one row per partition, written together:

```sql
run(venue_id, kind, scope, cursor, requests, found, started, completed, asked, sent)
```

`kind` is `walk` for a listing pass and `update` for a generated one. Probing keeps no run rows:
`wip` is its work list. The kinds keep separate rows because a job is opened and resumed per kind
(`openJob`, `openPartitions`), and an update's scopes say nothing about the keyspace a walk covers.

**A host has at most one open job of each kind**, and a scope at most one open row: `run_open` is a
unique index over the rows not yet completed. Ordinarily only one job is open on a host at all; an
update forced over an unfinished walk (see [Surveying](#surveying)) leaves both open, and what goes
out from then on is counted to the update.

**`requests` counts pages; `asked` and `sent` count requests.** A page is a listing page on a walk
and a thousand generated keys on an update, so `requests` measures progress and says nothing about
what the venue saw.

`asked` is one per request the job needs — a key to probe, a page to list, a directory to map —
counted once however many attempts it then takes. `sent` is what actually went out for them, every
retry included. **Two numbers because only the first is a property of this service:** what a walk
costs against what an update costs is `asked`, which a bad link on the day cannot move, while what a
pass cost the venue that day is `sent`, and the gap between them is how much of it the network wasted.

Both are held per host, counted in `send`, which every archive request passes, and written onto that
host's newest open job by whatever is already writing a run: a page of a sweep, a batch of probes,
the end of a pass however it ended, and shutdown. Nothing schedules a write of its own.

A count with no open job waits for the next one, which is where the requests that map an archive
belong: they are sent before the walk they plan has a row. What an HTTP handler sends to confirm one
key goes the same way, onto whatever job is open next. **Instrument listings are not counted at all**
— they go through `metadata`, against a venue's API rather than its archive, and they are a handful
of requests a pass.

**A first pass is not a special case.** It is a job with no predecessor: same rows, same walk, same
code. The only decision anywhere is whether to build a new set of partitions or continue the open
one:

```
asked to survey
  a job is open?   →  walk the partitions it still has open
  no job open?     →  map the archive, open a job over it, walk it
  refresh: true?   →  drop the run rows first, so the second line applies
```

Nothing below that line asks which kind of survey it is in, because nothing needs to. **Nothing above
it consults a clock either** — see [nothing starts unasked](#nothing-starts-unasked-and-nothing-stops-on-its-own-either).

### Partitions are read, not re-derived

The work list is `SELECT … FROM run WHERE completed IS NULL` — the partitions that still have
keyspace nobody has read. A partition leaves that list by being walked to exhaustion, so resuming
needs no record of what an earlier attempt managed and no filter over what descent produced.

The set is committed **in one transaction with the job row**. That atomicity is what makes the rows
safe to treat as the work list: a half-written set would look exactly like a finished one, and the
partitions never written would be skipped in silence.

**A resumed job does not re-map the archive**, so a directory that appeared after the job began
waits for the next job. That costs nothing. The guarantee is only *present when the job started and
still there when it finished*, and something that appeared midway was never inside it.

Every row in a job shares one `started`, so a partition walked hours later still claims the archive
as it was when the job began — the conservative direction, and the one the cascade wants. A job
begun on Monday and finished on Friday is a Monday snapshot; dating it Friday would claim four days
it never looked at.

### A job closes only when every partition did

A partition that cannot be walked keeps its row and its cursor, and the job **stays open**. That is
not bookkeeping fussiness: the job sits at the empty scope, which is every prefix's first ancestor,
so closing it around a failure would answer "established" for the whole venue — including the
prefix nobody has read.

**A page that fails is asked again where it is, before its partition is given up on.** What fails a
page is nearly always what would fail any other at that moment — the link, the venue, a write that
could not get its turn — so moving on to another prefix gains nothing and leaves this one half read.
The page is read again from the same cursor, up to twelve times, after a wait that doubles from two
seconds to a minute: a little under seven minutes in all. A refusal is the venue's answer and is not
repeated. Nothing of a page counts until its cursor is written, so asking again costs one request.

Only a page that outlasts that fails its partition, and the job stays open over it. The next turn of
the loop finds a job to resume and takes up exactly the partitions that failed, half a minute later,
**for as long as the service runs**. Nothing counts passes and nothing gives up.

That is safe because there is no per-partition failure that stays failed. A prefix that no longer
exists answers `200` with an empty listing — a successful walk of an empty scope, not an error. A
given page is a fixed URL, so it cannot deterministically fail while its neighbours succeed. What is
left is transient (a 5xx, a 429, a reaped connection), venue-wide (a bucket whose policy changed,
which fails descent first), or local — and every one of those is cured by asking again later.

Resuming is also cheap, because it does not re-map: one listing request per remaining partition.

**A pass that ends with partitions still open says how many failed, and names none of them**: each
was said as it happened, kept its cursor, and is resumed. A partition that is open with no failure
to explain it — stopped to be split and never queued again — is named, since nothing else would say
so.

### An update's rows are its progress, and reconciliation deletes them

A job closes when its pass is over, and every partition finishing is not the end of a pass that
probes.

**A walk over a venue that states everything in its listing ends there**: the keyspace has been read,
the bounds are on disk, and that closed job is what `phaseOf` and `establishedAt` read.

**Every other pass leaves it open, and that is the whole of resuming one.** Every partition finishing
means *generation* is done — the keys are in `wip` and mostly unasked, and probing them is where the
hours go: on htx, generation finishes with some 185,000 keys still queued. A job closed at that
moment would leave a restart during the drain nothing open, so it would plan the pass again and
discard the per-series record of every series already generated.

That is equally true of a **walk** on a venue whose listing cannot state a size or an etag, which
parks those keys for a probe exactly as an update does. Closed at the end of listing, such a venue
would report itself *waiting* with its whole backlog outstanding, schedule its next pass from a pass
that has not finished, and lose the drain entirely on a restart, with nothing in the catalog saying
the work was owed.

So the condition is whether the pass probes, never which kind it is: `surveyVenue` closes a walk only
where nothing will probe, and otherwise the drain returning is what closes it — `closeWalk` for a
walk, `clearUpdate` for an update.

So the shape is:

| | |
|---|---|
| **a row per series, written when the pass is planned** | closed as that series' keys are written |
| **rows existing at all** | the last pass did not reach reconciliation |
| **`wip`** | the whole of probing's progress; nothing else records it |
| **reconciliation's last act** | delete the per-series rows, close the job row |

Resuming therefore means: no preamble, no re-planning, and every series the interrupted pass had not
reached still generated — once per series, not zero, not twice. Probing needs no equivalent because a
key is on the list until it is answered, so a restart picks up exactly what is left, `tries` intact.

**A resume is a resume, whatever its age.** Nothing decides that an interrupted pass has been sitting
too long. An open job with nothing working it is what a killed container leaves and what a pause
leaves, and both continue from their cursors — stopped at 3am and restarted a fortnight later resumes
exactly as one restarted at 8pm does. Judging a paused walk stale is a person's call, and `refresh`
is how they make it; code guessing at it would restart a multi-day walk because a deployment sat idle
over a weekend, the expensive outcome chosen by nobody. Scopes planned against tips that have moved
since cost one pass of a narrower range, and the next pass widens it; discarding the pass costs
everything it had already read.

**`run` is a progress table, not a log.** A finished htx pass leaves **one row, not 39,296**: the job
row, closed, carrying the pass's start, end and totals. It cannot be mistaken for outstanding work,
because progress is read from the partitions.

### Nothing is parked that the catalog already holds

Generation reads the tip and nothing else, so an update emits every key between the tip and the
frontier whether or not its file arrived days ago.

Probing them could not change anything either. Settling acts only on parked rows and inserts
`ON CONFLICT DO NOTHING`, so a held file is never corrected by an update; a correction goes through
`correctFile`, which an update never calls.

So the question is asked at the one moment the row is still cheap not to write — parking — as a
`NOT EXISTS` against `file`'s primary key. One index probe, against an insert, a read and a request
later on. What stays parked is what the patience window is for: the periods nobody has answered for
yet.

**A withdrawn file is not a held one.** Its row stays as the record that the venue once served it,
and the check reads `existence <> 'absent'`, so a file that went away is asked about again — which is
the only way to learn it is back. Settling it writes over the absent row, and over no other.

### One module owns `wip`, because the count has to be exact

`wip` reaches tens of millions of rows on a venue whose keys are constructed, and `count(*)` over
that is not a slow query but a stall: `node:sqlite` is synchronous, so the count freezes the whole
process — every socket, every timer, every other venue — for as long as it runs: 1.8 seconds on a
25-million-row backlog.

The answer is a maintained count, and a maintained count is only safe while nothing can change the
table behind its back. So every write to `wip` goes through `catalog/wip.ts`, and the count is kept as
a consequence of the writes rather than as a duty laid on every caller. Three rules make it hold:

- **The count is seeded once per venue per connection**, by the one real `count(*)` that nothing can
  avoid, and maintained from then on.
- **Deltas are applied after the commit, never inside it — and immediately after, with nothing
  awaited in between.** A transaction that rolls back did nothing to the table, and a counter moved
  before the commit would keep the change anyway. But a delta held *past* its commit is as wrong: the
  batched parker commits a slice and then yields, the probe settles those rows in the gap, and their
  removal would reach the counter before their arrival did. The counter clamps at zero, so the
  removal would be lost and the arrival land on rows that are already gone. `putFiles` and
  `settleFiles` own their transactions, because a file must not arrive without leaving the backlog;
  they take statements from the module and report what moved once it has committed.
- **It is held against the connection, not in a bare map keyed by venue.** A count describes one
  database and venue ids repeat across them, so a figure keyed by venue alone would outlive the
  catalog it was read from and be quietly wrong about the next one.

**The count is for reporting; the table decides.** Whether a pass may finish is asked of `wip`
itself — `EXISTS` on `(venue_id, seq)`, one index probe whatever the backlog's size — and only once
generation has finished, since an empty backlog while keys are still being produced means *not yet*.
A counter can be wrong in a way nothing detects; where the table says empty and the counter
disagrees, the counter is forgotten and re-read, so the status endpoint stops reporting a backlog
nobody has.

### Refreshing

A refresh is a **full re-walk** of every partition. It has to be: new keys are appended within each
symbol group rather than globally, so a new month for `AAVEUSDT` lands at `A…`, behind any cursor
already past it. No marker finds it.

### Nothing starts unasked, and nothing stops on its own either

A survey begins when something asks for one, over the API. From then on that venue **keeps itself
current** — across any number of restarts — until it is paused or refreshed:

```
[ backfill ] → sleep → update → sleep → update → … → walk on a scheduled day → sleep → update → …
```

**A venue is never finished, only current.** The archives grow every day, so reaching the end of one
is not a state to stop in — it is the point at which the cheap half becomes possible. The first pass
is a walk where there is a keyspace to read and an update where there is not; every pass after it is
an update, except where the walk schedule makes it a walk. `passFor` decides (see
[above](#a-scanner-is-handed-a-context-never-an-adapter)); nothing else chooses.

**A day between passes, measured from the start of the last one.** Every venue here publishes at
most one file per series per day, so asking more often is asking the same question twice. Measuring
from the start rather than the end is what stops a venue whose pass runs longer than a day drifting a
day later on every turn: a pass that took thirty hours goes straight round again.

**The start is read from the pass's own run row, never from a clock**, because a pass this process
*resumed* began before this process did; timed from the moment it was picked up, a restart would
change the venue's cadence. A walk and an update alike leave their `scope = ''` row behind, closed,
which reconciliation deliberately keeps — and it is the same field `dueFor` reads when a venue is
picked up on startup, so the two paths cannot disagree.

**Two different questions, and only one of them is ours.** *Whether* a venue should be surveyed at
all depends on what somebody is waiting for and what the disk can take, neither of which is visible
from in here — so it is asked for over the API. *How often a venue already being surveyed needs
re-reading* is not that question: the archives move once a day, so the answer is a day, and it is not
worth asking anybody.

The endpoints are in [the API](#surveying).

#### When an update is a walk

**Probing finds no shape that did not exist before.** It asks only about series the catalog already
holds, at patterns it already knows, so a dataset a venue adds, or a naming it changes, is invisible
until the archive is listed again. Every venue that can be listed therefore has to be walked now and
then, and a walk of a large one is days on a slow link. How often that can be afforded is a fact
about where this runs, so it is set per deployment, in `src/walk-schedule.yaml` — a file that is not
versioned and need not exist (`walk-schedule.example.yaml` beside it shows the form):

```yaml
binance: 15        # walks on the 15th of each month
kucoin: 1,10,20    # on the 1st, the 10th and the 20th
gate:              # never walks for an update
```

- **A venue the file does not name walks once a month, on the day that is its own number**: the
  lowest id its servers have in the `venue` table, wrapped to a day from 1 to 30. Nobody chose, so no
  two venues walk the same night.
- **Only a venue that can be listed may be named.** One that cannot is never walked.
- **Days run from 1 to 30**, since that is what every month but February has; a month without the day
  is passed over.

**A walk runs when it is due, not on its day**, because this service can be down for days. At each
update the question is whether a scheduled day has come round since the last walk began: the update
is a walk where the last walk began before the newest scheduled day that is today or earlier (UTC),
and more than 24 hours ago. So a day missed is made up at the next update, a day is walked once, and
a walk that began the evening before its day is not repeated at midnight.

**The file is read once, at startup, and has to be right.** A venue that does not exist or cannot be
listed, a day that is not a whole number from 1 to 30, a line that is not `venue: days`, a venue
named twice: any of these is logged as `The walk schedule cannot be used — fix it or remove it;
stopping`, naming the line or the venue, and the service exits with status 78 (`EX_CONFIG`, a
configuration error) before it surveys anything. A supervisor that restarts failed services starts
it again into the same refusal, logged at every start, until the file is fixed or removed. What is in
force is logged as `Walk schedule in force`.

#### Enrolment, and what a restart means

**A venue is surveyed because somebody asked once, and that is recorded rather than inferred.** The
`survey` table holds one row per venue — `enrolled_at`, and `paused_at` which is null while it runs.
Keyed by **name**, not `venue.id`: a venue is what a person starts and pauses, while `venue` has a
row per host, so keying on the id would enrol bybit's books separately from its trades. No foreign
key for the same reason — `venue` is unique on `(name, host)`, so there is no single row to point at.

| | |
|---|---|
| **no row** | nobody has ever asked. Nothing runs, ever |
| **row, `paused_at` null** | enrolled. Walking, updating or waiting — the run rows say which |
| **row, `paused_at` set** | enrolled and stopped, and it stays stopped, including across a restart |

**A pause flag rather than a state, because absence already carries the third case.** Whether a venue
is walking, updating or waiting is the run rows' business, and a second copy here would be free to
disagree with them.

So **a restart picks up what was already running and asks nothing new**. For each enrolled venue —
`PROSPECTOR_VENUES` still applying — an open job resumes at once from its cursors, a venue between
passes waits out the remainder of its day, and a paused one stays paused. A venue nobody enrolled is
untouched for ever, which makes **read-only a real state** rather than a convention: an instance that
serves the catalog and collects nothing is one where nobody started a survey.

**Resumption is per host, because the passes are.** Bybit's two servers keep separate run rows and
separate cursors, and one being mid-walk says nothing about the other — so each is picked up from its
own state, and a venue with one host walking and one waiting is exactly that. Only the *reporting* in
`GET /status` collapses the pair into one word for the venue.

**A restart cannot change a venue's cadence**, because the interval runs from the start of a pass
(see [above](#nothing-starts-unasked-and-nothing-stops-on-its-own-either)). A venue updated an hour
before its container was replaced is not owed another update. Completing a walk is the end of a
pass, not a prelude to a special first update: the next is due a day after the walk began, which for
a walk that ran longer than a day means immediately.

**One verb, because where a venue has got to is not a caller's decision.** `POST /surveys` is the
whole of it. A venue with nothing starts, one with work outstanding continues from its cursors, one
that has been complete waits for its next update, as it would have anyway — all read off the run
rows, none of it a decision a caller should have to make. Skipping that wait is what `update: true`
is for. Venues are unrelated hosts already surveyed concurrently, so naming none of them, and meaning
all, is the ordinary request. A named venue is checked against the adapter registry, never against
the catalog's `venue` table: the registry defines what a venue is, and a database built without seed
data has no `venue` rows.

**The request places the order and answers; it does not carry it out.** A survey claims its venue
synchronously — that claim is what stops a second request starting the same one twice — and hands
the passes themselves to the next turn of the loop, so the reply is not held behind every venue's
synchronous prologue (the series registry loaded, a phase read, a probe opened). What a caller is
owed is the order and the state each venue was in, both of which are known immediately.

**Two modifiers, and they are the only decisions a caller makes.**

`refresh: true` throws the run rows away and walks it all again. Opt-in precisely so that the
ordinary request cannot discard a backfill in flight.

`update: true` skips the wait and updates now. It is **refused where no pass has ever completed** —
a venue mid-walk or one that has never run is owed the walk it is already doing, and an update
planned against bounds nothing has established is not a cheaper version of that — and it does
**nothing where an update is already running**. So it acts in one state and a half: a venue waiting
out its interval, and one **paused partway through an update**, which it resumes.

That last case reports itself as a **resume**, not as a new update. From outside the two are
identical and they are not the same thing: one carries on from partition cursors that already exist,
the other plans fresh scopes, and somebody told "update started" about work that was half done has
been told the wrong thing. Whether the venue was paused is not the question — *what the pause
interrupted* is. A pause during the walk fails for the ordinary reason.

The two are mutually exclusive: one discards the progress the other builds on, so a request asking
for both has not decided, and is a 400. A forced update that moves nothing is a **409**, because the
one thing it was for did not happen — where an ordinary request finding every venue current has done
its job.

**They are also the only requests that interrupt, and they have to be.** A venue's loop does not end
on its own, so once a venue has been surveyed it is *always* running — and refusing on that ground
would make a refresh impossible for ever after the first survey, and a forced update useless in the
one state it exists for, since what it skips is a wait this loop is in the middle of. Both therefore
stop the loop, wait for it to actually stop, and start it again. The waiting is the whole of it:
interrupting from outside would drop the rows a partition is still committing cursors against.

**An ordinary request adds nothing to a venue already surveying**, and says so. That is not an
obstacle being reported — it is the work already happening.

**A pause is not a cancellation, and there is no resume verb to go with it.** The flag is read
between pages, so the page in flight is committed, every partition keeps its cursor and the job stays
open — the state a killed container leaves behind, reached deliberately. Starting a paused venue
therefore *is* resuming it, and puts it back to what the pause interrupted: walking on from its
cursors if it was stopped mid-pass, waiting if it was waiting. A venue paused while it waited is not
owed an update for having been paused.

**The probe stops on the same flag, and reads it where it has a boundary of its own.** Its unit is
the batch, not the pass: a pass ends when the backlog empties, which on a venue whose keys are
constructed is a week's work, so a flag read once per pass is one that lands long after anybody cares.
It is therefore read each time a batch of `wip` rows is loaded — after the previous batch has settled
what it settled, recorded its attempts and moved the cursor, and before the next is asked for. What
that costs is the seconds one batch takes; what it buys is that nothing is cancelled mid-flight and no
row is asked twice. The pass says `stopped` rather than leaving the drain to infer it from counts,
which is the same reason it says `abandoned` — the two end in the same place and mean opposite things
about whether the venue should start itself again.

**The pause is written down before the loop is touched**, because it has to outlive the process: a
deployment that resumes what it finds open would otherwise restart a venue somebody had deliberately
halted. Two separate things: the row in `survey` is what keeps a venue stopped, and an in-memory set
is how a *running* loop is told to stop now — deliberately forgotten on a restart, since there is no
loop left to stop. `GET /status` reports the second as `stopping`, the moment between asking and the
loop noticing.

**Only a person's decision writes the row.** A refresh and a forced update both have to stop a running
loop before they can do their own work, and neither is anybody deciding the venue should be stopped —
so both take the in-memory half alone (`halt`), never `pause`. During that gap the venue reports
`stopping`, never `paused`, which is the one word meaning a person stopped it.

**Unprobed files are outstanding work, and belong to no job.** A probe's subjects are rows rather
than keyspace, so they outlive the walk that discovered them: bybit's books carry no metadata in
their index, and a completed walk leaves hundreds of thousands of names still owed. That is why a
venue counts as busy until its probe drains, and why `GET /status` reports `wip` beside the job.

**A restart loses nothing, and starts only what was already going.** Whether anything is
*currently* walking a venue is a different question from whether work is outstanding, and
`GET /status` answers both — `state` for where the venue stands, `surveying` for whether this process
has a loop alive. Open and not surveying is what a killed container leaves behind between one start
and the next, and the one state worth acting on.

### Settling metadata a listing could not carry

A walk establishes **what is there**; a probe establishes **what it is**. On a listing venue the two
arrive together, because a listing states size and checksum. On an index venue it states neither, so
the catalog holds paths and dates until something asks — and "how much disk does this cost, and how
long will it last" is unanswerable from paths alone.

So a pass that probes — every update, and a walk on a venue whose adapter says `probes` — runs a
**second loop** beside its generating half, settling files a `HEAD` at a time. Neither waits on the
other while there is work: a file found in the first minute should not sit unestablished until the
last partition closes, so during a backfill the probe runs for hours behind the walk.

**A probe is the second half of a pass, and ends with it.** While indexing is under way an empty
backlog means *not yet*, so the loop waits and asks again. Once the generating half stops nothing more
is coming, and the probe is draining: it keeps taking rounds until the backlog is empty and then logs
*Survey complete* — the same line a pass that does not probe logs when its partitions are done. A pass
that finishes generating while a probe still owes logs *Candidates generated; probing them* instead:
half a million names nobody has established are not a surveyed venue.

**Whether a pass probes is a property of the pass, not of the adapter**, stated once (`probing` in
`survey.ts`): an update always probes, because it generates keys rather than reading them, so a
listing venue that never probes while walking starts probing the moment it stops. The pass, the log
line and the closing of a walk's job all read that one expression.

**A drain ends only by emptying the backlog.** A refusal or a fault says nothing about the rows —
they are still owed and the venue is simply not answering — so the probe stands down for as long as
the venue's gate or its declared stand-down says, and tries again. A round in which the venue answered nothing about any key is logged as an
error (`Probing is getting no answers; still trying`) and asked again; there is no give-up rule, so
the pass does not finish until the rows are answered (see
[what ends a key](#what-ends-a-key-absence-confirmed)).

**A round follows the one before it as soon as there is work** — a round that settled, retired or
confirmed anything goes straight round. Only a round that moved nothing waits, for thirty seconds:
an empty backlog while the walk is still running, or a venue that has stopped making sense. The
attempts that are supposed to be spread over time are spread by the *update* schedule, a pass a day,
not by pausing inside one pass.

Until the probe stops, the venue counts as running: `POST /surveys` skips it rather than
starting a second loop against the same host.

**The work list is a query, so there is no state to keep.** A pass asks `wip` for its rows and
settles them; a row leaves that list by being settled or set down, so the query *is* the cursor and a
restart resumes by asking again.

**In the order the rows were parked, which is `wip.seq`.** Whoever produced the work chose the order
— a walk offers a venue's keys in the venue's order, generation emits a series ascending by date —
and the probe imposes nothing of its own on top.

Ordering by *date* would be wrong, because the two halves of a pass run at the same time. Generation
is still parking keys while the sweep reads them, so a row written for a date the cursor has already
passed would be invisible until the next round however old it is; a sweep that had reached 2023 would
**not** have asked about everything below 2023. A `seq` only ever grows, so a key parked mid-sweep
always lands ahead of the cursor and is asked in the pass that produced it.

Which is why the column is `AUTOINCREMENT` and not a plain rowid. This table's *highest* rows are
the ones deleted, constantly, as they settle; with `max(rowid) + 1` the counter would run backwards
after every drain and reopen exactly that hole.

The consequence worth knowing: generation walks its series sequentially, so probing completes one
series at a time rather than advancing every series' date together. A pass cut short has answered
whole series rather than a slice of all of them.

The cursor is a **value**, one integer, rather than an open statement. SQLite will let a query step
while the same connection rewrites the rows it is walking, and what happens then depends on which
index the planner chose: rows visited twice, or skipped, with nothing said. A keyset cannot be wrong
that way, and it moves past rows that did *not* settle, so one stubborn file cannot hold the rest of
an archive behind it. A pass ends when the query comes back empty; the next starts from the
beginning, which is what picks up files a walk has found since.

**An answer that a key is not there counts towards the row's confirmations** — `CONFIRMATIONS`, 2
for a generated key and 30 for one a listing named. The row leaves `wip` once they are reached, or at
once where the adapter's `ruleOnFailure` answers `drop`; until then it stays and the next round asks
again. Nothing is recorded as absent: "not there now" is not a claim about what was ever published,
and the next update generates the key again. The full rule is in
[what ends a key](#what-ends-a-key-absence-confirmed).

**A first settling is not a revision.** Learning a size for the first time is not the file changing,
so the trail is appended to only when something known differs — otherwise every probed file would land
in `revision` on its first sighting and "what changed since I last looked" would answer "everything,
once".

### Asking what is established

`establishedAt(prefix)` answers with the latest `started` of the completed runs covering it — job
row or partition, at the prefix itself or any ancestor, since a walk of `spot/` settles everything
beneath it. **Only the kind that establishes the venue counts**: walks at a venue that has ever been
walked, updates at one that never has (okx, bitget), since an update reads only the newest stretch of
each series and says nothing about the rest of a walked tree. **A completed ancestor does not count
while an open partition of the same kind lies below it**: splitting closes the parent and hands the
rest of its keyspace to children, so the parent's `completed` says the run stopped, not that the
prefix is established.

Where several qualify the answer is the **latest**: each is a true statement about the prefix, so the
strongest one wins. Taking the shortest instead would let a venue-wide pass from last month shadow a
walk of that very prefix from an hour ago.

## Pacing: one gate per venue per host

**A venue counts our requests to one address, so the limit is counted per venue per address.** The
walk, the archive mapping and the probe are three callers of one host, and a limiter belonging to any
one of them caps a fraction of the traffic while the host meters all of it. So every request to a
venue's archive passes one `Pace`, held for the life of the process and keyed by the adapter's label
(the venue, plus its `host` where one venue has two adapters, as bybit has) and the URL's host —
`paceFor` in `pace.ts`. **Two venues behind one endpoint are two budgets**: binance and gate are both
listed at `s3-ap-northeast-1.amazonaws.com`, one bucket each, and a limiter keyed by the host alone
would pace both by whichever reached it first. Calls to a venue's own API are not paced here at all —
see *[asking a venue about itself](#asking-a-venue-about-itself)*.

**A venue is listed and probed at one address.** `base` in the `venue` table is that address, with
`key_root` the prefix every key shares, and every lookup of a venue's gate asks at `base`. Where a
venue's bucket answers directly, `base` is the bucket and not a CDN in front of it. Other addresses
that serve the same files under the same keys are recorded beside it, in `alternative_hosts`, a JSON
array of bases; nothing here asks them.

**The gate is inside the fetch.** `send` in `http.ts` is the one function every archive request goes
through — `fetchPage` for a listing page, `fetchHead` for a probe — which makes it the only place a
limit can be complete. It waits first for the [network gate](#the-network-gate-is-tuned-for-this-service-not-taken-as-it-comes),
then for the venue's slot. Putting it there also brings the retry ladder inside the count: a call
that retries five times is five requests the venue sees, and a gate wrapped around the call instead
of inside it would let those go out at five times the cap — at exactly the moment a venue is already
unhappy.

**The rate is the part that matters.** A venue budgets requests per second; concurrency sets a rate
only by accident, multiplied by whatever latency happens to be that day. So the rate is capped
directly, and `concurrency` only bounds how many requests may be in flight to reach it — see
*[on pace and parallelism](#on-pace-and-parallelism)*.

The counter is a **sliding second**: the times requests went out, with anything older dropped. A
request goes when fewer than `perSecond` of them fall inside the last second, and otherwise waits
exactly as long as it takes the oldest to fall out. The check and the claim happen in the same tick,
so two lanes cannot both see one free slot and both take it.

**Cadence layers**: a built-in default (`STEADY` in `pace.ts`, 100 a second with 100 in flight), and
over it the venue's adapter, which declares its own `pacing` beside a pointer to the venue doc that
holds the evidence for it. Every venue surveyed today declares one. A venue still on the default is
one nobody has had a reason to measure, not one that was measured and found generous.

**The rate is not configurable, deliberately.** What a venue tolerates is a fact about that venue and
does not change because the client moved to a host with more bandwidth, so it belongs beside the
evidence for it rather than in an environment file. What *is* local is how many requests this machine
will hold open at once — and that cannot outrun the venue's rate, only fail to reach it.

**bybit is listed at its bucket, never at its edge.** The CDN in front of bybit's archive,
`public.bybit.com`, bans an address at rates the bucket behind it takes without a refusal, and its ban
covers the CDN alone (see [BYBIT.md](../venues/BYBIT.md#limits)). So the primary host's `base` is the
bucket, `s3.ap-southeast-1.amazonaws.com/public.bybit.com`, walked at the 2,000 a second its adapter
declares; the edge is not among its `alternative_hosts`, and nothing here asks it.

### A refusal aimed at us stops the venue

**A refusal aimed at a key does not.** S3 declines one object and says so, with an `x-amz-error-code`;
a CDN turning us away serves its own error page naming no key. So `blocked` in `http.ts` reads a
reply as a refusal aimed at us when the adapter's `refusesUs(status, headers)` says so, and, where the
adapter has no such rule, when it is a `403` or `429` without `x-amz-error-code`. The default leans
that way because that is the direction where being wrong is cheap: a stood-down venue costs minutes,
a banned address costs the venue. A venue whose bucket answers `403` for every key it does not hold
says otherwise in `refusesUs` — bitget's counts any reply not served by `AmazonS3`, whatever its
status.

**A refusal is an answer, and is never retried.** A ban lapses only while nothing is asking, so
slowing down is not a remedy, and the ladder would spend four more requests confirming what the first
established.

**Five in a row stand the venue down.** After `REFUSALS_BEFORE_BLOCK` (5) refusals with no other
answer between them, the venue's gate stops every caller at once, including the lanes already waiting
for a slot — nobody has to be told, and nobody gets to keep asking. Any other answer resets the count,
and a refusal below five is logged and nothing more: one bad reply is far more often an edge having a
bad second than a venue objecting, while a real block fails every lane in flight within a fraction of
a second and reaches five at once. A pause does not reset the count either, so a refusal after it,
before any other answer, stands the venue down again at once.

**The pause doubles while the venue keeps refusing.** The first is the venue's `standDownMs` (two
minutes in `STEADY`, which no adapter overrides), each further one twice the last, up to `ceilingMs`
(thirty minutes). It is one pause per round rather than one per refusal: a refusal that arrives while
a pause is in force belongs to that round, because every lane in flight fails at roughly the same
instant and counting each of them would reach the ceiling in milliseconds. The doubling is forgotten
at the first answer that comes 30 minutes or more after the last stand-down began (`EASE_AFTER_MS`).

**The rate at the moment of a block is logged, because nothing else measures it.** No venue publishes
a rate-limit header, so the only evidence about where a limit sits is what was going out when it was
hit — and a per-pass average is the wrong number for that by construction, since it counts every
second spent paused. The gate reports the last second, the last five and ten, the busiest second so
far, what is in flight and the lifetime total, and those go into the block warning and the walk's
refusal line.

**A steady pass is read on different numbers, so the heartbeats carry different ones.** Ten seconds
says where the window landed rather than how the survey is going: on a venue that stands down, it
reads as a collapse whenever a pause falls inside the window and as full speed whenever one does not.
A survey running for days is judged over a minute and an hour instead — counted in a ring of
per-second and per-minute buckets, because an hour of timestamps at these rates is millions of
numbers held to answer one log line, and averaged over the time actually elapsed so that a process
two minutes old does not report an hourly rate a thirtieth of the truth.

Retries are reported there as a **share of everything sent**, not a count: five hundred is a healthy
afternoon at a thousand a second and a venue falling over at ten. They are counted where the retry
ladder turns rather than inferred by subtracting answered from sent — those two figures are kept on
different scopes, one per pass and one per host since the process started, so their difference is
mostly in-flight requests rather than retries.

### The retry ladder

`fetchPage` and `fetchHead` make up to five attempts. A transport error, a deadline, a `5xx`, a `429`
that is not a refusal aimed at us, and — for a listing — a success whose body is not a listing are
tried again, after a full-jitter exponential wait (500 ms doubling, capped at 30 s) so that lanes
backing off together do not come back together. A `Retry-After` is obeyed exactly as sent instead,
never shortened, with a log line every minute it lasts. Every other status is an answer and is not
retried: a `404` or a `403`, and a refusal aimed at us least of all.

## Carrying requests

**Archive requests are sent from worker threads.** One thread decides what to ask and writes
what comes back to the catalog, and SQLite has to stay on it: a transaction belongs to one connection,
and one connection to one thread. A request is a question in and an answer out with nothing shared,
so it is the part that moves. Measured 2026-09-30 with every venue backfilling, the main thread ran at
96% or more with a fifth of it on sockets, TLS and reading listings.

**One worker per 1,000 requests the machine may have in flight**, so raising
`PROSPECTOR_CONCURRENCY` brings the workers to carry it. What loads a worker is requests a second: a
probe takes ~0.25–0.3 s, so 1,000 in flight is ~3,300–4,000 a second, and one worker carried ~2,300 a
second alongside every other venue's walk on under half a core (2026-09-30). Requests are dealt to
the workers in turn; each keeps its own connections. A worker that exits fails what it held, as a
transport error the ladder retries, and is replaced after a wait that doubles from a second to a
minute while replacements keep dying young; after five such exits in a row its slot is left empty. A
request with no worker to take it is carried on the main thread, as it is wherever the worker file
is not built.

**Open files are not a limit; opening connections is.** What fails is opening HTTP/1.1 connections in
bulk: measured 2026-10-01, past ~1,250 opened at once from this machine connects timed out and the
open ones were lost with them, and on loopback, with no network involved, 3,000 lanes opening at once
missed their deadlines by the hundred and reopened by the thousand — every one a TLS handshake on one
thread. Over HTTP/1.1 every request in flight is a connection, so `PROSPECTOR_CONCURRENCY` has to be
set below that figure (nothing enforces it), and the pool opens gradually — see *[on pace and
parallelism](#on-pace-and-parallelism)* — so nothing ever asks for its whole width at once.

**Idle connections are kept, all of them.** HTTP/1.1 `HEAD`s go through agents that keep every idle
connection (`maxFreeSockets: Infinity`). Node's default keeps 256 per host, and a host with more lanes
than that would close and reopen connections between requests, each costing a TLS handshake. The
venue closes a connection it no longer wants.

**Names are looked up once per host, not once per connection.** Node keeps no answers of its own, and
inside the container every lookup goes to Docker's resolver on a pool of four threads: measured
2026-10-01, 40 lookups at once took 0.3 s and 1,000 took 5.4 s — and a connection's deadline counts its
lookup. So each thread answers lookups from memory for a minute, with one real lookup per host at a
time; a failed refresh keeps the last answer. A host's addresses are handed out in turn within the
family the resolver put first, since the container has no IPv6 route and one host answers with one
IPv4 address and eight IPv6 ones.

**Only the transfer moves.** Whether a request may go, what its status means, whether it is retried
and whether a venue is refusing us are decided on the main thread, because they read and change state
every venue shares — see *[Pacing](#pacing-one-gate-per-venue-per-host)*. The worker opens
connections, sends, and reads a body to its end or drops it; a slot is held until it has. **A listing
page is read there too**, into its keys and directories, so what crosses back is the reading and not
the megabytes it came from. Requests cross in batches, sent the moment the task that decided them ends
rather than on the next turn of the loop — on a thread this busy a turn is long, and a request waiting
for it waits that long before it has left.

**A `HEAD` goes over HTTP/2 wherever the host speaks it.** Node's HTTP/1.1 client does not keep a
connection after a `HEAD` reply that states neither a length nor chunking, and that is how three hosts
answer a key they do not have — bitget, kucoin and bybit's order-book host. A probe for a missing file
therefore costs a connection and a TLS handshake: measured on bitget at 250 in flight, 9,000 sockets
were closing at once and a probe took 285–907 ms at the median. Over HTTP/2 a probe is a stream on a
connection that stays, and the same probes took ~235 ms, the venue's own time to say no. Whether a
host speaks it is asked once, by the TLS handshake. A server caps the streams one connection carries
— CloudFront at 128 — so each takes at most 100, and more are opened as needed. A stream the server
refuses was never processed, which HTTP/2 guarantees, so it is asked again at once on another
connection rather than through the retry ladder. A stream nobody answers in time takes its connection
out of use, since a connection can die without either end being told.

**Everything else is HTTP/1.1.** S3's own endpoints do not offer HTTP/2; a `HEAD` there goes over a
kept connection, never through `fetch`, which opens a new one after every `HEAD` — measured
2026-09-29, ~800 ms a probe against one round trip's ~270. A listing is a `GET` through `fetch`,
whose 15-second deadline is on the answer and whose body may take as long as it takes, so long as it
does not go silent for 10 seconds.

**Happy eyeballs is off in both threads.** Node's default gives each resolved address 250 ms before
trying the next. The endpoint binance and gate are listed at, `s3-ap-northeast-1.amazonaws.com`, is
~260 ms away and answers with eight addresses, so every new connection there abandoned seven attempts just short of
their reply and took ~2 s; with it off, a new connection takes one round trip. The default is per
thread, so the worker sets it too.

**A limit binance's bucket has and nobody has reached would show as slowness.** No throttling answer
has been seen from it (see [BINANCE.md](../venues/BINANCE.md#rate-limits)). S3 asks for a slower pace
with a `503`, which the ladder retries with backoff, so a pass would slow down rather than lose
anything; a refusal naming no key would stand the venue down like any other.

## What it deliberately does not do

- **It fetches no archive data.** It reads listings and metadata, never contents.
- **It decides no venue for itself.** *Whether* a venue is surveyed is somebody's decision, recorded
  in `survey`; a deployment nobody has asked anything of collects nothing, for ever. What it does
  keep is the one schedule that is not a judgement — how often an enrolled venue is re-read, which
  is a day, because that is the grain the archives move at.
- **It does not distinguish a backfill from a refresh.** Both are jobs, and the difference is only
  whether a predecessor's rows were thrown away first.
- **It does not select.** Everything a venue publishes is catalogued, whether or not anyone has a
  use for it. A catalog that only holds what someone already wanted cannot answer what else is
  there.
- **It does not interpret what a file contains.** `market`, `dataset` and `variant` are recorded so
  a consumer can ask by them, but nothing here rules on whether a 50-level book is the same data as
  a 5000-level one, or which of two renderings of a month is the better one. It records that both
  exist and leaves the choice where the use is.
- **It makes no claim about a calendar month.** A listing is ordered by key, not by date, so what a
  survey can establish is a whole prefix — never a month part-way through one. What that implies
  for anything reading the catalog is the reader's business.

## Known gaps

Not plans, and not defects that break anything today — things worth knowing before trusting a
reading, recorded here so nobody has to rediscover them.

### A seed's symbols are a superset, and only probing settles which are real

A seed crosses every symbol a venue has ever been seen to name with every pattern of its markets,
because binding a symbol to a shape beforehand is exactly the judgement that loses series: an
instrument recorded in one market may publish in the other, and a spelling the venue no longer lists
may be the one its files sit under. So a seed names many times the series the archive turns out to
hold.

The excess is not waste in the record, only in the asking. A series the archive answers for keeps
what it measured; one it never answers for is deleted by the reconciliation after the first completed
pass, and recreated by the next preamble only while the venue lists the symbol on a live shape. What
the catalog ends up holding is what the venue turned out to serve.

### `pattern.retired_at` governs creation *and* bounds generation

Retirement says the venue stopped writing that shape, and **on what day**. The day is the point: it
is a ceiling on generation, not merely a fact about creation.

It does two things, and a bare flag could only do the first:

- **A newly listed instrument gets no series on a dead shape.** `patternsOf` offers only live ones,
  so an instrument listed tomorrow is created on the offered tree and nowhere else.
- **Generation for the series already there stops at that date** rather than at yesterday. The
  archive under a dead naming is still there to be read — but only up to the day it stopped.

A shape with no date is asked for every day from its floor to yesterday, once each, by the pass that
discovers it. On a venue that has renamed its trees more than once, that is millions of keys every
one of which is certain to answer that it is not there.

Retirement still closes nothing by itself. A series stops being generated for when its own tip
reaches that ceiling, which is the ordinary rule and not a second one.

**Nothing can infer the date, so it is declared.** A missing file and a tree that has ended are the
same answer from the archive, and no amount of asking separates them. So it arrives with the shape,
from the seed that carries it — `seeds/<venue>/pattern.csv`, one column, and a date somebody
measured rather than assumed.

That is also why a *walked* venue can have a seed. Discovering patterns by reading an archive is
what a walk does well; noticing that a tree has **stopped** is what it cannot do at all, so a venue
that is otherwise fully walked may still seed nothing but its dead shapes and their dates.

A venue merely *moving* a URL is two patterns as well, and the old one carries the day it stopped
rather than leaving its series to time out.

Nothing infers any of it. The aggregate signal that might justify doing so is the one described under
*[nothing notices a pattern that moves](#nothing-notices-a-pattern-that-moves)*, and it cannot
separate a template that moved from a venue that went quiet.

### Nothing notices a pattern that moves

**A single `404` cannot say which kind of wrong it is.** *Nothing was published that day* and *the
template moved* are identical per request, and no amount of retrying separates them.

What would separate them is **shape**, which `pattern` makes computable: one instrument going quiet
under a pattern its siblings are still publishing to is a delisting, while *every* instrument of a
pattern going quiet at once is the template having moved. Nothing aggregates that today, so **a whole
branch of a venue can disappear from one day to the next and no alarm fires** — the update simply
generates keys nobody answers, sets them down, and retires them a month later.

**It bites during an update, not a walk.** An indexed venue re-walking from empty, or refreshed,
reads whatever the venue now serves and catalogues the new shape as a new pattern — so a full run
recovers on its own. It is the venues that only ever update, and the long stretches between full
runs, where a moved template is invisible.

Nothing models *when a file is expected*, so nothing can tell a file that is merely late from one that
will never come except `OVERDUE_DAYS` — see
[below](#overdue_days-is-a-decision-not-a-measurement).

### A derived archive spelling can be wrong, and only a log says so

Where a venue's keys spell an instrument differently from its listing, `urlSymbolFor` answers with
the archive's spelling — derived by rule, or asked of the venue. A spelling that comes out wrong is
not an error anything can catch: the keys it builds are well-formed and the venue answers that they
are not there, which is what a quiet instrument looks like too.

The symptom is the same series **created by the preamble and removed by reconciliation on every
pass**, with no file ever recorded for it — visible as steady preamble `created` and reconciliation
`removed` counts for the venue. One of those is ordinarily an instrument that launched days ago and
has published nothing yet, and it resolves itself; a cohort of them that never resolves is a spelling
nobody serves. It surfaces as counts in log lines and nothing else reads them.

### `OVERDUE_DAYS` is a decision, not a measurement

Nothing established 15 days. It is where we decided to stop believing a file is merely late.

The longest wait any venue here documents is a week: binance publishes a month's files on the first
Monday of the next, which can be as late as the 7th, and gate generates a month of 7-day candles on
the 7th of the next (see [BINANCE.md](../venues/BINANCE.md#publication) and
[GATE.md](../venues/GATE.md#candlesticks-intervals-and-cadence-differ-per-market)). Fifteen is twice
the worst promise and still short enough that ordinary lateness is never read as absence.

**It fails cheaply in the direction it fails.** A file arriving on the sixteenth day of a listable
venue is found by its next walk, which reads the keyspace and owes nothing to any tip. Waiting longer
instead costs a probe per gap per pass, on every series that has one, for as long as the wait lasts.

Nothing models when a file is expected: the one number stands for every venue and every dataset.

### A hole older than the window is walked past, not filled

Reconciliation lifts every tip without knowing what it steps over — a real hole, a miss that would
have settled on the next pass, and the dead range below a newly listed instrument's true start go the
same way ([what a completed pass is worth](#what-a-completed-pass-is-worth)) — so anything unanswered
below the tip is never asked about again. That is the deliberate half of `OVERDUE_DAYS`, the price of
not re-probing every gap for ever. What recovers it is a full re-walk, which reads the keyspace and
owes nothing to any tip. A venue that cannot be walked has no second chance, which is what makes a
lifted tip the one bound worth being careful with: too low costs requests, too high loses files
silently.

### A listed instrument that never publishes is asked about every pass

A series no file has ever been seen for has a NULL `last`, and `open` reads that as **open**: there is
no measurement to call it finished on. Each finished pass deletes it, since it holds no file, and the
next preamble creates it again from the covered floor while the venue still lists the instrument — so
the venue is asked about that window on every pass until something publishes.

Cheap at the scale of a real run, and the alternative is worse: closing on absence alone would put
the judgement exactly where the evidence is weakest — an instrument a venue lists but has not
published for yet is indistinguishable from one that never will. Every newly listed instrument is in
this state between its series being created and the archive's first file.

## Configuration

The environment variables, their defaults and what each accepts are in the
[service README](../../services/prospector/README.md#environment). Everything else is fixed inside
the container: the catalog lives at `/data/catalog`, where the compose file mounts the host's
`CATALOG_DIR`, and the API listens on `8080`.

`PROSPECTOR_VENUES` limits which venues this process will survey or resume, and starts nothing on its
own: whether a venue is surveyed is a request to the API, never a setting. `PROSPECTOR_CONCURRENCY`
is the machine's ceiling on requests in flight, and why it is the one pacing figure an environment
sets is below.

### On pace and parallelism

**A partition is a serial chain.** Each page's marker is the previous page's last key, so no amount
of concurrency makes one partition faster. Partitions are therefore the only unit of parallelism,
and they cut the keyspace exactly — disjoint, and together covering everything under the root.

**Cadence and concurrency are different things, and only one of them is a limit.**

`perSecond` is the cadence — the figure a venue would object to. It lives in the adapter beside the
evidence for it, and nothing in the environment can raise it.

`concurrency` is not a limit at all. It is how many requests may be in flight so that the cadence
can actually be reached: at one at a time, 100/s is unreachable whatever the gate allows, because a
request spends most of its life waiting. It cannot breach the cadence either, since every request
passes that gate regardless — which is why a venue's `concurrency` is a ceiling rather than a target,
and a venue yielding fewer partitions simply uses fewer lanes.

**So the figure that reaches a cadence is the cadence times how long one request takes**, and below
it the venue is held by concurrency rather than by its limit. The time that matters is a *missing*
key's, because that is most of what an update asks and it is the slow one wherever a CDN fronts the
bucket: a cached file answers from the edge, a missing one goes to the origin.

**A limit opens gradually rather than all at once.** `concurrency` is for keeping the pipe full
while answers are outstanding, not for arriving in a single instant: a host that serves 100/s
sustained can still refuse to be met with 100 sockets in the same millisecond, leaving every one
unanswered until it dies on its own deadline. So a fresh limiter allows a tenth of its figure in the
first second and a further tenth each second after, reaching the full number at nine. A limit of four
or fewer has no burst to guard against and opens whole.

The ramp starts again when a stand-down lifts, which is the moment it matters most: every lane held
by a pause wakes within an instant of the same moment, and the venue that just refused us is the
last one to meet with everything at once. While the limit is still opening, a waiting lane is woken
by the clock rather than by a departure — a rising limit moves on its own, and a lane parked on the
queue would otherwise sleep through every step until something happened to finish.

**Probing is not paced separately.** A probe and a listing are the same thing to a host — one
request, one socket, one ticket — and both pass the same gate, so the count a venue sees includes
both. That the link is shared and something else may need it is what the machine-wide pool below
answers, for every caller at once.

**How many lanes a venue gets follows from the same figure.** A lane holds one request at a time, so
more of them than the venue's own `concurrency` is not parallelism but queueing, with a partition
held open behind each one. The count is therefore the adapter's number, capped by
`PROSPECTOR_CONCURRENCY` (`lanesFor` in `pace.ts`) — and it is also what the archive is split for, so
a venue is partitioned for the lanes it will actually have.

**Imbalance sets the wall clock, not the total.** If one partition holds most of the keys, its chain
decides when the survey ends however quickly the others finish, and more lanes do not help because
the work is not divisible. A partition carrying too much is split while the survey runs — see
*[Partitions split themselves](#partitions-split-themselves)*.

The limit on concurrency is therefore our own resources rather than the venue's: S3 documents 5,500
GET/HEAD per second per prefix, which nothing here approaches.

**But our own resources are shared, and no adapter can see that.** Every venue's figure can be
individually right while their sum is wrong: each adapter declares its cadence and concurrency beside
its evidence, and the sum of those concurrencies is more than one machine can hold open at once.
Summed, they come back as connect timeouts on venues doing nothing unusual, at the moment the others
are busiest. A limit that lives in an adapter cannot catch this, because the number that is wrong is
one no adapter knows.

`PROSPECTOR_CONCURRENCY` is that number. It is a **pool of tickets**, not an allocation: a
request takes one before going out and returns it when it is answered, and the pool neither knows
nor cares which venue is asking. There is nothing to divide up and nothing to recompute when a
venue starts or finishes.

**The pool opens gradually, by work done.** It starts at 100 and grows by 100 for every 1,000
requests answered until it reaches `PROSPECTOR_CONCURRENCY`, and starts over from 100 whenever the
network gate lets go of what it held. A start or a release sends every venue at once, and every
request over HTTP/1.1 is a connection and a TLS handshake on a transport worker's one thread; a
worker opening hundreds at once falls far enough behind that bodies already arriving read as silent
(measured 2026-10-01). Growing only as earlier requests are answered opens connections as fast as the
venues can serve them. Each venue's own limit still opens by the clock as well.

The two limits compose without either knowing about the other:

- a venue at **its own** `concurrency` does not ask for a ticket at all, so it never sits on one
  while waiting for itself
- a venue that wants more waits in one **first come, first served** queue with everyone else
- a venue surveying **alone** is bounded only by its own figure, because nothing else is holding
  tickets

Order matters and is the same everywhere: the venue's slot is taken first, the ticket second. The
other way round, a lane blocked on its own venue would be sitting on the scarcer of the two for the
sake of the looser one. A ticket is held across the cadence wait rather than surrendered, because
lanes released together would otherwise fire together — which is the burst `perSecond` exists to
prevent.

None of that trades correctness or politeness for speed: what is retried, and what is an answer, is
*[the retry ladder](#the-retry-ladder)*.

### The network gate is tuned for this service, not taken as it comes

`@devvir/netgate` watches the network on its own and holds every archive request while it is
unusable, so that an outage is established once instead of being rediscovered by each of hundreds of
lanes through its own retry budget. `send` waits on it before the venue's own gate; a request held there
spends no attempt. Its defaults assume a probe answers quickly because the caller's own requests do.

**That assumption does not hold here, and the defaults would make the gate measure this service
rather than the network.** A venue is walked on hundreds of lanes at once; at a thousand in flight,
throughput settles near 300 a second, which is a mean above three seconds per request — for the
requests that *succeed*. Against the library's three-second deadline the gate's own probes time out
while the link is carrying everything else without a stutter: what it measures then is the contention
this service creates. It is the same effect as the summed per-venue limits above: the number that is
wrong is one no component can see alone.

So the deadline is set past what this service's own traffic costs, and the evidence widened to
match — a probe here has to answer whether the network is *unusable*, and slower than a browser is
not that (`configure` in `index.ts`):

| setting | here | library default |
|---|---|---|
| `timeoutMs` | `10000` | `3000` |
| `window` | `12` | `6` |
| `degradeAt` | `3` | `2` |
| `closeAt` | `6` | `4` |

The gate samples every five seconds, so twelve samples are a minute: two failures in thirty seconds,
which the defaults act on, is a blip here, and three in a minute is a pattern. The higher deadline costs nothing in detection speed because the probes are asked
together rather than in turn — a sample is one round trip however long the list is. When the gate
lets go of what it held, the ticket pool opens gradually again.

## The API

**Private to the archives module.** Prospector publishes no port: it is reachable only on the
module's network, on `8080`. It starts, pauses and reports on surveys, settles reports of what became
of listed files, and stores lenses. What the catalog holds is served by the catalog service — see
[CATALOG-API.md](../modules/CATALOG-API.md).

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
[enrolment](#enrolment-and-what-a-restart-means).

**A named venue is checked against the registry** — the venues with an adapter and a scanner,
narrowed by `PROSPECTOR_VENUES` — never against the `venue` table, whose rows are shipped data a database built
without it does not have. An unknown name is a `404` naming it and listing the venues there are.

| modifier | |
|---|---|
| `refresh: true` | Throw the progress away and walk it all again. |
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
work is happening rather than refusing it.

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

A pause keeps every cursor, which is why there is no matching resume verb: starting a paused venue *is*
resuming it, to what the pause interrupted. It is **permanent until then** and survives a restart,
because the pause is a row rather than a flag in memory. A venue with nothing running is answered
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
| `established` | the earliest of its hosts' [established](#asking-what-is-established) times at the root. `null` where none has one |
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
has the rule to say so. A reported mismatch is confirmed the same way, below.

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
not own; how lenses are read is the catalog's (see [CATALOG-LENSES.md](../modules/CATALOG-LENSES.md)).

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

SQLite, in WAL mode, with `STRICT` tables — SQLite is otherwise dynamically typed, and a declared
`INTEGER` column will happily hold a string, which surfaces later as a query that silently matches
nothing.

The schema lives in `src/database/schema.ts`, with the migrations beside it in
`src/database/migrations/`; the queries are in `src/catalog/`. **Prospector creates and migrates the
file, and is the only thing that writes it — every row of every table, lenses included.** Two writers
on one SQLite file wait on each other's locks, and the one that waits longest fails; with one writer,
the survey's writes take their turn in one queue, the serial write queue (`slice` in
`catalog/serial.ts`), and nothing waits on a lock at all.

Sixteen tables. `venue`, `file`, `wip` and `revision` are what a venue serves and what became of
it, `revision` holding each file's previous versions; `instrument` is what it trades; `slice` and
`partition` are what it publishes, cut the way it is handled; `pattern`, `series` and `transform` are
where it publishes it, and how it spells an instrument the pattern cannot; `run` is how far each pass
has read and `survey` whether this deployment reads it at all; `exclusion` and `unreadable` are the
two lists of things ruled out and not yet read; and `lens` and `lens_member` are the lenses stored
through the private API, and what each lets through.

**A slice is one lengthwise cut of a venue's data, and a partition is one month of it.** A slice is
a dataset of a market narrowed by its variant, its grain and its bundle, under the venue's *name* —
whichever of its servers publishes it. **A pattern belongs to a slice**: its market, dataset, variant
and grain are the slice's, not columns of its own, and one URL shape publishing into two slices — a
venue-wide file and a file per instrument, say — is two patterns. The one statement `SLICE_OF` in
`schema.ts` finds a pattern's slice or creates it, for a survey and a seed alike.

**Every file belongs to one partition**, its series' slice at the month of its date, and says so in
`file.partition_id`, which is indexed: every file of a partition is one range read. A partition's
row exists once a file does.

**A partition carries its own counts and its version**, moved in the same transaction as the file
rows they describe — `catalog/cache/partitions.ts`. The counts are files, bytes, what is still to
download and what the venue has withdrawn, so a venue's totals and a lens's size are sums over a few
thousand rows and never a scan of `file`. **The version is a sum too**: each confirmed file is a
64-bit number hashed from its ETag, and the version is their sum, wrapped at 64 bits
and written as sixteen hex digits. A file arriving adds its number, one withdrawn subtracts it, one
that changed does both — so no file is read to state it, the order files arrived in does not matter,
and the same files give the same version in a catalog rebuilt from nothing. **A file's path is no
part of its number**: the version says what a partition holds, not where the venue keeps it, so a
venue that moves or renames files without changing their bytes leaves every version where it was. The
sum is done in this service, since SQLite turns an overflowing integer sum into a float. `updated_at`
moves when the version does and at no other time: a download changes what is pending and nothing
else.

**An instrument is a row of its own**, `(venue, market, symbol)`, and a series is one shape it is
published in. What is true of the instrument is stated once, there, and every series of it reads it:
today that is `state` — whether the venue's listing still names it — since a venue lists or delists
an instrument, never one of its shapes. The venue is its *name* rather than a `venue` row: those
are servers, and an instrument published from two of them is one instrument.

**A series holds no symbol: it holds its instrument**, and its name is read from there. Whoever
creates a series — a survey or a seed — asks for the instrument first, through the one statement
`INSTRUMENT_OF` in `schema.ts`, which creates it where it is new and reads its venue and market off
the pattern's slice, and its kind off the pattern. A venue-wide bucket has no instrument: it holds every instrument of a market,
which share nothing, and `@` is how a series without one is spelled wherever a symbol is expected.

**What makes two series one** is the shape, the instrument and the name its keys carry. One
instrument's files under two names at once are two series of the one instrument.

**A chain is an instrument too**, of `kind` `chain`: a family whose files carry every one of its
expiries under the family's name, as okx's `…-futureschain-…` files do. Its members differ in expiry
alone, so everything else true of them is true of the chain, and it stands as one instrument; the
members themselves are only ever seen inside the files. What makes an instrument a chain is its
shape — `pattern.holds` says what one file of a pattern holds, `instrument` or `chain`.

**A series carries its place in the catalog's listing**, `series.prefix`
(`venue/market/dataset[,variant]/F/symbol/`, or `…/@/` for the venue-wide file), indexed, which is what lets a page of the listing be one
query in key order. It is written by a trigger as the series is created, so no writer — a survey or a
seed — has to know the listing's layout, and the expression is the one `PREFIX_OF` in `schema.ts`. A
symbol that cannot be a folder name, empty or holding a `/`, has none.

**Migrations run automatically, once, on open — on every database, including a fresh one.**
Versioning uses SQLite's own `user_version`, so a database that has never heard of migrations reports
0 and needs no bookkeeping table. Each migration runs in its own transaction with its version bump,
so a failure leaves the file where it was rather than half-migrated, and a catalog from a *newer*
build is refused rather than written to by an older one.

The chain is six steps: the schema with the venue rows and the shipped exclusions (gate's two
zero-byte upload tests, gate's 85 spot files at futures URLs, bybit's one misfiled `DOTUSDT` day),
then htx's retirement dates, then okx's series, then bitget's, then the shapes gate filed under a
month they do not belong to, retired at the one day each holds, then the shapes binance stopped
writing. **A seed is a migration and not a startup hook**, because a fresh catalog is exactly the
database that would otherwise pay for rediscovering it. A caller that wants the shape without the
findings — a test fixture, mostly — declines them with `seedData: false`, which still advances the
version so nothing is retried behind its back.

**One file per migration**, in `database/migrations/`, named for the version it produces and listed in
order by that directory's `index.ts`. **The chain describes the catalog as it is, not how it got
there**; how a change to it is made is in the `index.ts` docblock.

That is the only thing startup does to an existing file: no repair, no rebuild, no inference about
what it ought to contain.

One setting cannot be fixed retroactively — `auto_vacuum = INCREMENTAL` is applied **at creation**,
and enabling it later requires a full rebuild of the file.

WAL gives many concurrent readers alongside one writer; readers never block the writer and the
writer never blocks readers. A WAL *reader* still writes the `-shm` sidecar, so mounting the catalog
read-only does not make it safe to share — it makes even a `SELECT` fail. Who writes is a code
boundary, and cannot be delegated to the filesystem.

Startup therefore **proves it can write** before a survey begins, by setting `user_version` to the
value it already holds: a write transaction that changes nothing. Nothing cheaper answers the
question — opening a read-only file succeeds, and so does asking for WAL on a database already in
it — and finding out hours into a walk instead is the alternative.

## Venues

The registry is `src/venues.ts` and each adapter is one file beside it. **What a venue publishes
belongs in [docs/venues/](../venues/)**, one document each, and how this service handles each venue is
[venue by venue](#venue-by-venue); what belongs here is the shape of the problem those adapters exist
to solve, and the hooks the core grew to let them solve it.

| | |
|---|---|
| **a server, not a venue** | an adapter is one host. A venue serving its books from a second machine is two adapters sharing a name, with two limiters and two sets of run rows |
| **addressed where it answers, not where it serves** | a CDN in front of a bucket may answer a listing plausibly and wrongly — a cached reply is indistinguishable from a broken venue except by `x-cache` and `age`. Where the bucket itself answers, the venue's one address is the bucket, and the CDN is not used at all |
| **surveyed from the bucket root** | wherever the venue allows it. Descent guarantees nothing *above* where it starts, so a declared prefix reintroduces one level up exactly the omission that discovering prefixes exists to prevent — and it has hidden real datasets at three of the servers here, each absent from the tree the venue's own site presents |
| **offered against merely reachable** | a tree nobody advertises is still that venue's data, and being unadvertised is a reason to take it *sooner* — it may be withdrawn without notice |

### The hooks exist because a venue could not be described without them

Every optional hook in [the model](#the-model) is a place where a general mechanism admits a specific
answer, rather than a place where one venue's behaviour was written into the core. An adapter that
grows control flow has taken on work that belongs to a scanner; an adapter that needs a hook nobody
else uses has found something real about its venue, and the hook is how that stays out of everything
else.

Two consequences worth stating, because they are what keep the arrangement honest:

- **No scanner ever sees an adapter.** It is handed a context the adapter assembled, so it cannot
  come to depend on anything else there — and it never sees a database.
- **A hook answers; it does not act.** `refusesUs` says who answered a refusal, `ruleOnFailure` says
  what it means for the key, `expandParts` says which parts the period has. What to *do* about any of
  those — stand the venue down, drop the row, park the key — stays in one place for every venue.

#### `getContext` and the occasion

| occasion | what it is for |
|---|---|
| `'full'` | a walk |
| `'partial'` | an update: what has appeared since. Discovering new instruments is not the context's job — that is [the preamble](#the-preamble-asking-the-venue-what-it-lists), which runs before the update generates anything |
| `'lookup'` | **reach nothing.** What an HTTP handler passes to confirm one key inside a request, where fetching would turn a confirmation into an unbounded call |

No adapter's `getContext` reaches its venue: every context is the venue's address and the adapter's
own functions, assembled in memory. Which kind of pass runs is decided in `sync.ts` (`passFor`) — see
[a scanner is handed a context](#a-scanner-is-handed-a-context-never-an-adapter). The scanner never sees a database: it receives
what the adapter assembled, as data.

### Bounds arrive from outside, and this service does not ask how

A venue that constructs its keys must know where to construct them *between*, and establishing that
is research rather than scanning — a venue's download portal, its instrument APIs, whatever mixture
that one turned out to need. So it happens beside the adapter and lands in the catalog as rows, which
this service then reads exactly as it reads any others. See
[a seed is research before it is data](#a-seed-is-research-before-it-is-data).

**Unbounded, construction is hopeless**: every period the archive could hold, for every instrument,
almost all of them misses. Bounded, it is one request per candidate that could exist.

**A series with no tip generates nothing.** It is skipped and logged (`Series with no known start
skipped`). A series with a tip and no `first` — every one the preamble creates — generates from the
period after its tip.

**A dataset's venue-wide file is not an instrument.** Where a venue publishes one file a period
carrying every instrument at once, there is nothing per-instrument to measure and no series to keep
per symbol. The file is the market bundle (`@`) series, which has no instrument, and it is generated
from its own tip like any other series.

### `state`: what the venue lists

`state` belongs to the instrument (`instrument.state`), and every series of that instrument reads it:

| state | what it means |
|---|---|
| `active` | the venue lists it today |
| `delisted` | the venue listed it once and does not now |

Neither says where the files stop: an archive can outlive a listing, and a listed instrument can go
quiet. [The preamble](#the-preamble-asking-the-venue-what-it-lists) writes `state` from the venue's
listing; whether a series is still generated for is [`open`](#open-when-keys-are-still-generated)'s
question, which reads `state` beside the bounds. A venue-wide file has no instrument, so nothing can
delist it and it is always `active`.

There is no third state for "never published": reconciliation deletes such a series — see [what a
completed pass is worth](#what-a-completed-pass-is-worth). That is the one place a series row is
removed.

### A constructed-key venue is still a scanner, and must behave like one

Nothing is fetched to produce a constructed venue's keys — they come out of arithmetic over the
bounds. That is an implementation detail and **must not leak into how the survey is structured**: the same scopes, the
same partitions, the same cursors committed page by page, the same job that stays open until every
scope is exhausted. A generator that ignored all that would still produce the right URLs and would
lose everything the run table is for.

The reason is the cost asymmetry between the two kinds of venue, which is easy to state and easy to
forget:

- **A listing venue's walk carries metadata.** Size, ETag and last-modified arrive with every key, so
  re-walking a prefix is a no-op for every file that has not changed — `putFiles` compares and writes
  nothing. A refresh is cheap by construction.
- **A constructed-key venue's walk carries nothing.** Every key it emits is a candidate, and every
  candidate that is not already settled lands in `wip` for the probe to ask about. A file already
  catalogued is not disturbed — a bare sighting writes nothing — but everything else means a
  `HEAD`, and there are millions of them.

**A scanner that does no I/O must hand the event loop back.** A listing scanner yields as a side
effect of awaiting a socket; a constructed-key one is pure arithmetic behind an `async` signature, so
awaiting its pages resolves on the microtask queue and the process never reaches its I/O phase. Left
alone, one venue holds everything: its own log lines are produced and never flushed, and every other
venue's sockets go unserviced — a service running flat out that is indistinguishable from a wedged
one. The walk yields between pages for exactly this reason, at a cost of one turn per thousand keys.

So **a refresh is hours of probing and a resume must never become one**. What keeps them apart is
exactly the run table: a resume reads the open partitions and continues from their cursors, so it
emits only what is ahead of them and re-parks nothing. Regenerating the whole keyspace "because it is
cheap to generate" would be true about the generation and catastrophic about what follows it.

Nothing about `pattern` or `series` belongs to the venues that cannot be listed. Every venue publishes series of files that differ only
by a date, and every file belongs to one; what differs is only how the rows get there — an indexed
venue records them as its walk confirms files, and one that cannot be listed has them declared and
its bounds measured.

`market` is whatever that venue calls an instrument type and `dataset` whatever it calls a kind of
data — both stored, never parsed, exactly as `tag` is.

**Two tables because they change at different rates.** A venue adds symbols weekly and changes the
shape of a URL once in years, so `pattern` holds the shapes — tens of rows, effectively frozen — and
`series` holds one row per instrument per shape, with its bounds and its tip, in the tens of
thousands.
Holding both in one table made adding a symbol something only code that knew how to build that
venue's URLs could do, which is knowledge an adapter then carries for ever.

**A pattern's slots are a calendar, an instrument and a part** — `{YYYY}` `{MM}` `{DD}` `{HH}`
`{MI}`, `{SYMBOL}` and `{PART}` — and everything else in it is literal, because a different value of
it is a different shape. So building a key is substitution and nothing else, whoever does it.

**The grain is read off the shape rather than recorded twice**: the finest calendar slot a pattern
carries is how often it publishes, so a pattern with `{DD}` is daily and one without is monthly. A
slot declares its grain by *ending* in it, which is what lets a venue invent one without the catalog
having to be told its cadence separately.

**`{PART}` is not a calendar slot and does not touch the grain.** It is where a period's own files
are told apart, and what goes in it is the venue's to say — see
[a period published in parts](#a-period-published-in-parts). A day published as twenty-four files is
still a day: the grain is what a consumer asks for, not how many objects the answer arrived in.

**Where a venue's paths are not a calendar, the adapter renders them**, through a `slotsFor` hook
that is handed the stamp and returns the slots to fill. One venue needs it, and it would otherwise
have forced a shape on every other venue:

| venue | slot | why |
|---|---|---|
| bybit | `{MONTH_LAST_DAY}` | `kline_for_metatrader4` names a whole month by both its ends, and February stops the second one being a literal |

That is the division throughout: the shared code carries what most venues do, and a venue's oddity
costs that venue's adapter a function rather than costing everyone a vocabulary.

**A directory that names another period stays literal, and its shape is seeded retired.** A pattern
is built by replacing the file's own date with slots, so where a directory names a different month
from the filename, that month stays in the pattern as written and the shape can only ever hold the one
period it was found with. Left live, such a shape costs far more than its files: every series on it
asks for every day between its tip and yesterday on every pass, and nothing can ever answer. So it is
seeded with `retired_at` at the day it holds, generation stops there, and the files stay.

gate is the case. Its 21 literal-month shapes are in `seeds/gate/pattern.csv`, seeded by migration
`005-gate`: three `orderbooks/202212/` shapes holding 2022-11-30 hour 23, and eighteen
`candlesticks_{30s,1m,5m}/2024{07..12}/` shapes, each holding the last day of the month before.
Measured on 2026-09-27 with those shapes live, they held 63,506 series and produced 312,336 of gate's
323,229 nightly probes. The rest of gate's misfiled files are refused rather than catalogued: its
`accepts` refuses a path whose directory and filename name different months (`gateMisfiled` in
`adapters/gate/misfiled.ts`), except the hourly books, whose misfiled hour is the only copy, and 108
instrument-days of klines with no correctly filed twin. Nothing in a path tells those from the
duplicates, so `misfiled.ts` keeps them as a closed list. What gate misfiled is in
[GATE.md](../venues/GATE.md).

### Every path is parsed, or it goes on the worklist

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

**A decoration around the symbol belongs in the pattern, not beside it.** Where a venue writes a
constant around every name under one shape — a family suffix distinguishing a futures chain from the
spot pair of the same name — that constant is determined by the shape and not by the instrument.
Measured across the whole catalog: **not one pattern spells two of its symbols differently**. A
constant determined by the shape is what a pattern is *for*, so it goes into the template:

```
…/{YYYY}{MM}{DD}/{SYMBOL}-futureschain-L2orderbook-…
```

Generating a key is then substitution of the venue's own name, and the canonical symbol stays the one
its listing uses rather than one decorated to match a path.

**What does not belong in the pattern is a difference between two instruments under one shape** —
that is `url_symbol` on the series, or a `{TRANSFORM:…}` slot where one key needs two different
strings.

**A chain is one file**, whatever is open inside it: `BTC-USD` has eight live contracts and one file
a day, and asking for a contract's own file answers 404. So a new expiry under a family the catalog
already holds creates no series and needs no discovery.

**`url_symbol` is how the archive spells the instrument, and NULL means "exactly as the venue does".**
It carries the transformation a pattern cannot express because it happens *inside* the name — a venue
writing `BTC/USDT` as `BTC_USDT`, or lowercasing — and the case where one instrument's files move to a
different name partway through its life, or appear under two names at once. A constant written
*around* the symbol is part of the shape and belongs in the pattern, where every series of that
pattern gets it for free. Nullable rather than blank: these rows are held in memory, and a null costs
nothing where a copy of the symbol costs a string each.

**A series is one shape and the name its keys carry** — `url_symbol` where there is one, otherwise
the symbol. Two series of one shape that resolve to the same name would generate the same URLs, so
the registry (`identity()` in `catalog/series.ts`) refuses the second before it is written. The symbol
alone cannot serve, because an instrument whose archive name changes mid-life is two series that
agree about everything except that name, and both must be able to exist under the symbol a consumer
asks for. The table's own unique index (`series_key`) is narrower: pattern, instrument (none for a
venue-wide file) and `url_symbol` with NULL as `''`. Writers therefore store NULL, never a copy of the
symbol, where the archive spells the instrument as the venue does.

Reading a path back is the one place the decoration still matters, and it is evidence rather than
spelling: okx's flat namespace puts a spot pair and a futures family under names differing by nothing
else, so the suffix in the *path* is what says which market it is — and the market then picks the
pattern.

### The three bounds a series carries

Every series carries `first`, `last` and `tip`, and between them they decide everything an update
does.

| | |
|---|---|
| **`first`** | the date of the oldest file the catalog holds for this series. NULL means no file has been seen. A **floor** on generation: nothing was published before a series began, so a tip sitting under its start does not license asking about the gap |
| **`last`** | the date of the newest file the catalog holds for this series. NULL means no file has been seen. Never a ceiling on generation |
| **`tip`** | *nothing at or below this period will ever be asked about again.* Generation starts at the period after it. A one-way ratchet: nothing lowers it |

`first` and `last` are **measurements**. A sighting widens them (`sawFile`), and a finished pass
resets both to what `file` holds (`reconcile`), which is how a withdrawal narrows them — see [a
sighting states the bounds](#a-sighting-states-the-bounds-a-finished-pass-checks-them). Neither is a
claim about the venue — `first` is "first in the archive", not "first ever published", because a
rolling-window archive has an early bound that moves; and `last` says where the archive has got to,
not that it has stopped.

So the generation range reads only the calendar and the two ends of the ratchet (`update.ts`), with
`lag` the adapter's `probingLag` (one where it declares none, which is yesterday for a daily shape):

```
START := max(tip + 1, first)                              first ignored where NULL
END   := min(lastClosed(now - (lag - 1) days), retired_at)   retired_at ignored where NULL
```

The lags each venue declares are in [how far behind today a probing update
asks](#how-far-behind-today-a-probing-update-asks). **`first` clamps `START`**, which matters for a
seed that states one floor per dataset rather than per series: every series then starts below its own
start, and without the clamp each would spend the gap asking about days known to hold nothing.

**One span may be skipped from the middle.** On a venue that cannot be listed, until a pass has
completed there, generation leaves out `[last + 1, lastSettled(seededAt)]` for a series with a
`last`: the pass that built the seed went on looking up to its own date, so that span is measured
absence (`Rules.seededAt`).

**`last` does not bound generation.** *Whether* to generate is a separate question with a single
answer, `open`.

**These three are what anything reasons about a series with**, and that is a deliberate property of
the schema rather than a convenience. `series` holds tens of thousands of rows per venue where `file`
holds hundreds of millions, so "when does this series start, where has it got to, is it still
running" is answered from three columns rather than from a group-by over the largest table in the
catalog. Querying `file` for a range is a thing to do while *establishing* a venue — see
[a seed is research before it is data](#a-seed-is-research-before-it-is-data) — and not something the
ordinary path should ever need.

**A seed states a floor, not a `first`.** The first pass measures where each series starts, and
reconciliation replaces whatever a seed could have said about it; the seed format is in the [seeds
README](../../services/prospector/src/database/migrations/seeds/README.md).

### `open`: when keys are still generated

**A series is open when this catalog still expects files for it, and keys are generated for exactly
the series it still expects files for.** One function, `open` in `catalog/series.ts`, read wherever
generation decides what to ask about.

| | |
|---|---|
| **listed, on a live shape** | open. The venue still trades it and still writes this shape, which outweighs any quiet spell |
| **nothing seen yet** | open. There is no measurement to call it finished on — every newly listed instrument is here between its series being created and the archive's first file |
| **never asked about** | closed. A row with a `last` and no tip has been asked nothing, so there is no window to judge its silence in |
| **otherwise** | open while its newest file is inside the patience window, closed once it falls out |

**A gap below `last` is never an ending**, and that is what the last row turns on. A delisted series
stays open while its tip is under the newest file ever witnessed, because every period beneath that
date is proven to exist and is still owed — whatever runs of absence lie between. It matters most
during a backfill, where the walk is years in the past and `state` describes only today: a fortnight
of silence back then may be an instrument that was listed and simply did not trade, or one between a
delisting and a relisting, and nothing in the row can tell those apart. The patience window only
speaks above `last`, where nothing is proven.

**The shape has to be live, not just the instrument.** A retired naming era holds series whose
instruments are alive and whose shapes are
finished. Reading the instrument alone would keep every one of them generating to yesterday for ever
— which is the whole reason a retired pattern is recorded.

**The patience is measured from the tip, so `open` needs no clock.** The tip is how far the venue has
actually been asked, which is the only thing a silence can be judged against; a wall clock would call
a series closed over a fortnight nobody spent asking, which is a statement about this service rather
than about the venue. Reconciliation lifts the tip to at least `OVERDUE_DAYS` before the pass began,
so the window comes out at about two of them — a month for a daily shape, a month and a half for a
monthly one. That figure is arbitrary and deliberately so.

### A sighting states the bounds; a finished pass checks them

**A walk is the source of truth, so it reads none of the three to decide anything.** It never skips a
period, stops early, or refuses a file because of a `first`, a `last` or a `tip`. It reads the index
and states what is there. The file that creates a series is also the first thing known about it, so
the bounds are written by the same call that writes the row (`walkSeries`): `first` and `last` at the
file's date, and a tip at the walk's settled edge, `lastSettled(grain, START)` with `START` the walk's
own start — or at the file's period where that is newer, though never above the last period closed
when the walk began. Generation refuses a series with no tip, so a series the walk creates has one
from its first moment.

Two rules, applied per sighting, with `d` the file's date. A series that does not exist yet is not a
third case — it is the same rules with nothing to coalesce against:

```
first := min(first, d)
last  := max(last, d)
```

**A probe that found a file is a sighting as good as a listing's**, so `sawFile` applies the same two
rules for every file a probe or a backfill settles. That is why a venue with no index arrives at the
same bounds as a walked one. Writing `first` from a probed file strands nothing below it: `first`
floors *generation*, and the keys below it are already parked in `wip`, on disk, surviving a restart;
they go on being probed whatever the column says, and anything they find lowers it again.

**Both rules only widen.** So nothing depends on meeting a series' files in date order — which an
index does not guarantee across hours and partitions — and a file the venue *withdraws* narrows
nothing when it goes. A pass that finished reads both bounds back from `file` and replaces any the
files do not bear out: see [what a completed pass is worth](#what-a-completed-pass-is-worth).

**`last` is the newest date seen, and it is the whole of what a sighting says.** Nothing concludes an
ending from it — that judgement lives in `open`, and it needs the instrument's listing and the shape's
state as well, neither of which a sighting knows.

**A tip is not a per-file claim, so no sighting moves it.** It says a whole range was asked about,
which no single file is evidence of. Once a series has a tip, two things lift it and nothing lowers
it: reconciliation after a pass that finished, and the preamble reviving a relisted instrument, which
raises a tip below the floor the venue was covered to.

**Generation never touches a tip.** A generated key is a question, and a tip moved over it would
claim an answer nobody has given: nothing at or below a tip is generated again.

### Bounds are buffered, and flushed before a cursor moves

Bounds are held in memory and written in batches, on a full buffer or a quiet interval. **A walk
flushes before its cursor advances**, and that ordering is the whole guarantee: a page whose files are
committed and whose cursor moves on, while the bounds derived from them sit in the buffer and are
then lost, leaves a series whose `first` is quietly later than the truth — and nothing afterwards
re-reads the page that would have corrected it.

Within that ordering the buffering is free. A buffer lost between page boundaries costs nothing,
because the page is re-listed from its cursor and rewritten.

### What ends a key: absence, confirmed

**Absence is the only answer that takes a key off the list**, and the core takes it only once the
venue has given it more than once — unless the adapter's rule answers `'drop'`, which sets the key
down on that answer. A single 404 is a moment, not a fact: a key probed the instant before it was
published answers truthfully and is wrong about the archive, and a pass that took the first miss as
final would let reconciliation retire the whole period without ever asking again.

**How many attempts depends on who said the key was there** — the `existence` the row was parked
with, never the pass doing the asking:

| parked as | attempts | why |
|---|---|---|
| `confirmed` | 30 | a listing named it, so absence contradicts evidence. A venue mid-write or having a bad minute looks identical from here, and being slow to write a key off costs requests where being quick costs the file |
| `assumed` | 2 | built from a pattern and a date. Absence is the ordinary answer to a guess, and confirming it thirty times spends thirty requests proving what the first already said — on keyspaces that are mostly empty |

How a venue *spells* absence is the adapter's to say. In the probe, absence is a `404` or a `'drop'`
and nothing else. Where a status also means *we* are being turned away, the two separate by headers
rather than by code, through `refusesUs` and `ruleOnFailure`. An adapter may also name further
absence statuses in **`notFoundCodes`**, and none does: such a status is counted as a miss rather than
a refusal, and a report's confirmation of a single file reads it as absence, but the probe sets a key
down only on a `404` or a `'drop'`.

Each non-settling answer is put to the adapter's `ruleOnFailure` first:

| verdict | meaning |
|---|---|
| `null` | as you were — a `404` is absence, confirmed as the table above says; anything else is not |
| `'drop'` | absent now: the row is spent on this answer, with no confirmation count |
| `'keep'` | not absence, whatever the status says |

**A rule can ask which pass it is in**, through `surveying(adapter)`. bybit/secondary uses it to keep
a key its index named through up to 100 `404`s while a walk is running — more than the core's 30 for
confirmed rows, because its CDN has bad minutes (see [BYBIT.md](../venues/BYBIT.md)). Outside a walk
it defers to the core.

The helper is ambient rather than an argument because the question is: an adapter rule is handed one
answer about one key and cannot be told which pass it belongs to without threading a parameter through
every caller in between. It is keyed per venue, since one process surveys all of them at once, and
scoped so that no ending — a throw, a pause, a venue blocking us — leaves a venue looking like it is
still walking. It does not follow a row: walked keys an update inherits from an undrained backlog get
the core's 30 attempts, not bybit's 100.

**Bitget's bucket grants `GetObject` without `ListBucket`**, so every object it has never held answers
`403 AccessDenied` — the same status as being turned away, separable only by the headers. Its
`ruleOnFailure` answers `'drop'` for an S3-served `403`, so a missing key is set down on its first
answer and asked again by the next update while its period is above the tip. okx's rule answers
`'drop'` on every `404`, so its missing keys are set down on the first answer too (see
[docs/planning/CATALOG.md](../planning/CATALOG.md)).

**Everything else keeps its row, for as long as the service runs.** A 429, a 5xx, a reaped connection
say nothing whatever about the file, so there is nothing to conclude and no count to run down. The row
stays in `wip` and the drain keeps asking — there is no give-up rule and no round limit.

So the pass simply does not finish: nothing is reconciled, and the venue does not move on to the next
day's keys until somebody looks. That is the intended shape rather than a gap. Every venue here is S3,
OSS or a known CDN in front of one, and one answering with something that is not an answer is a venue
to go and fix, not one to design around. It says so every round, as an `error` naming the venue and
what is left.

**Leaving `wip` is not a claim about the archive.** A row that is given up on is deleted, never
marked: a ruling of `absent` is a statement that a venue withdrew something it published, and it
belongs to `file`. The next update generates the key again, and what eventually retires the period is
reconciliation, not a count and not a clock.

So **every row in `wip` is outstanding**, which is what makes the backlog a `count(*)` rather than a
filtered scan of tens of millions of rows per venue.

**Probing settles nothing by the clock.** Where a clock does decide — *is this late, or is it
never?* — it is `OVERDUE_DAYS`, read through `lastSettled` in `dates.ts` by every reader alike:
reconciliation lifts each tip to that edge over a pass that finished (see
[what a completed pass is worth](#what-a-completed-pass-is-worth)); a walk starts the tip of a series
it creates there; the preamble and the backfill start a new or relisted series that far below the
newest date the last completed update covered; a first pass over a seeded venue skips the span its
seed proved empty up to that far below the day the seed was built; and `open` keeps a delisted series,
or one of a retired shape, generating while its `last` is within that distance of its tip.

### Asking a venue about itself

An archive is a bucket that answers a key. A venue's API is a web service with its own limits, its own
throttling, and its own habit of returning a refusal inside a `200` — okx does exactly that. It also
sits outside the pace gate the archive's host is held to, because it is not that host.

So there is one hardened fetcher for it, shared. It carries two clocks — one bounding the wait for a
reply, dropped the moment headers arrive, and one bounding *silence* once a body has started, so a
megabyte of instruments is welcome to take its time while a stopped download fails promptly. It
retries transport faults, reads the body inside the retry so a truncated one is retried rather than
thrown, and lets a venue say what a refusal-inside-a-success looks like.

It is `fetchJson` in `metadata.ts`, and every adapter's instrument listing goes through it.
`metadataGap`, a second and a half, is there for an adapter to space consecutive calls with. bitget's archive-name
search is a `POST`, which `fetchJson` does not speak, and is a bare `fetch` with a timeout. None of
these passes the pace gate, a ticket or a transport worker: they run on the main thread, and they are
not counted in a job's `asked` or `sent`.

### The preamble: asking the venue what it lists

Probing can only ask about series that already exist, so nothing an update does will ever find a
symbol listed since the last full pass. A walk finds one by reading the index and a seed by having
been built; between those there is only this. Without it, a venue that lists a hundred pairs a month
quietly stops being current, one pair at a time, until somebody re-walks it.

**It runs at the start of every update pass that is not a resume** (`sync.ts`), for every adapter
with an `instruments` hook — all eight, listing venues included. A walk does not run it: it discovers
by reading the index. A resumed update skips it: its scopes are already planned, and asking the venue
again would spend its API calls to learn nothing.

**It runs to completion before generation starts**, which is the one ordering that matters: the
update's scopes are built from the series that exist when its job opens, so a series created after
that would wait for the next pass.

An adapter answers with every instrument it lists, across every market, **already spelled the way the
archive spells it**. That is the same translation `inspectUrl` does for paths, at the same boundary —
the catalog's `symbol` is defined by the files, so an API answering `btcusdt` against an archive
writing `BTC-USDT` is the adapter's to translate. How many calls it takes is the adapter's business:
binance needs four hosts, htx four endpoints.

`live` is stated rather than inferred. Some venues publish their dead — listing offline symbols
beside online ones, or answering a closed status on request — and taking "absent from the list" as
the only signal would read those as alive. Where a venue lists only what it trades,
everything omitted is not live, which the step works out for itself.

Then, in order:

1. **Tips first.** Every series of the venue with a `first` and no tip is given the period below its
   `first`. One with neither is logged (`Series with no known start; they will not be checked`) and
   left alone.
2. **The listing is checked before anything is written.** An empty listing, or one that fails [the
   agreement test](#it-refuses-rather-than-guessing), changes nothing.
3. **Each live instrument with no active series** has its series revived, or gets new ones. Series on
   retired patterns count as neither: a retired shape is finished whatever the instrument does.
   - **It has series**: they are revived — `state` back to `active`, the tip raised to the covered
     floor where it is below it, `last` untouched. The venue listing it again is new information, and
     those are the series that would carry anything it now writes.
   - **It has none**: it gets one series per live pattern of its market that names a symbol and whose
     keyspace can carry it, with its transforms recorded first, its archive spelling from
     `urlSymbolFor` where the adapter has one, and a tip at the covered floor.
4. **`state` is written for what the listing spoke about**: `active` where the instrument is listed
   live, `delisted` otherwise. Only in markets the venue answered about — a list covering spot and
   silent on options is not a statement that the options are gone, and most venues split their API
   across endpoints. Never on a retired pattern, and never for a pattern with no `{SYMBOL}`, which no
   listing can name.
5. **Backfill** runs for every created or revived series with no `first`.

**The covered floor** is `lastSettled(grain, covered)`, with `covered` the newest tip the venue held
before the preamble touched anything (the clock, where it held none). A pass that has not run for
three weeks covered up to three weeks ago, and a series discovered now starts where that pass stopped
rather than where today is.

**It records no end.** `state` says whether the venue lists an instrument, not where its files stop:
whether a quiet or delisted series is still generated for is [`open`](#open-when-keys-are-still-generated)'s
decision, made from bounds the files wrote.

#### The backfill reaches below the tip without ever moving it

A series created here is given its tip **up front**, at the covered floor, and `backfill` then probes
*downward* from the floor for as long as the venue keeps answering. Each period it finds is written
straight into `file` as settled — a `HEAD` carries size, checksum and last-modified, which is the
whole of a file row — so history under the floor is reached without anything below the tip ever
being generated for. It stops at the first period that does not answer, or, logged as an error, at
the oldest date the catalog holds for the venue.

**The tip does not reverse, here or anywhere.** The files below it are there because they were
recorded, not because the range is still open: nothing re-reads that range later.

It runs only for series with no `first` — one request where the instrument is as new as it looks, and
the only thing that ever recovers history at a venue with no index. A series that already has a start
is skipped: the archive below it has been read, and asking again re-probes years to re-find files the
catalog holds.

#### A shape with no symbol cannot be branched by symbol

This step exists to discover instruments and give each one its series, so a pattern that never spells
a symbol has nothing for it to branch on: **every instrument handed one generates the identical
sequence of keys**, and the series are the same series wearing different names. Venue-wide files are
the case — one object per period carrying every instrument of a market at once — and there the
dataset *is* the file. The market bundle (`@`) series carries it, made by a walk or a seed. So a
pattern with no `{SYMBOL}` slot is never offered to an instrument.

**What allowing it costs is not a duplicate, it is a scramble.** `file` is unique on
`(venue_id, path)` and settles with `DO NOTHING`, so such series never collide — they *partition* the
dataset, each period landing on whichever asked first, and none of them ever holding all of it. Every
one of them then re-asks the same key for ever.

Measured on okx, where four series shared `allswap-fundingrates`: between them they held 1,693
distinct dates and **not one date twice**. The `@` series had 11 of them; a perp listed weeks earlier
had 1,660, and so appeared to have five years of funding history it had never had — which is what
being handed a venue-wide file looks like from the outside.

#### One market can be more than one archive

**A canonical market is not always one keyspace.** Binance's perpetual swaps are two products —
USDⓈ-margined at `fapi` writing to `data/futures/um/`, coin-margined at `dapi` writing to
`data/futures/cm/` — and both are `perp` here, because both are perpetual swaps and a consumer asking
for `perp` wants both. That collapse belongs to *answering* questions. Creating series is the other
direction, and there they are separate: a contract is domiciled in one of the two and can never hold
a key in the other.

So an adapter may name the category a pattern's keyspace serves (`categoryOf`), a listing carries the
category it was found under (`Instrument.category`), and a pattern is offered only where the two
agree. **Both sides have to say something or nothing is refused** — a venue with one archive per
market names neither and every pattern is offered.

Nothing is derived from the symbol. The endpoint that listed a contract *is* its domicile, known at
the moment it is read; re-deriving it from a ticker is guesswork that happens to work until a venue
names a stablecoin BUSD. See [BINANCE.md](../venues/BINANCE.md) for the measurements behind that.

#### It refuses rather than guessing

Before anything is created or delisted, the step compares what the venue lists against what the
catalog holds. **A spelling that disagrees is the one failure that is silent and total**: every
instrument reads as new, so it would create a parallel set of series *and* mark every real one
delisted, with nothing to show it had happened.

The test is "most of what the venue lists live, we have already seen" — never the reverse, since an
archive holds thousands of symbols a venue stopped listing years ago and a small overlap in that
direction is correct. Below half it logs the counts and an example and does nothing at all: a venue
does not relist itself overnight, so anything near a clean split is drift rather than new listings.
A catalog that holds nothing for the venue yet has nothing to disagree with, and passes.

### What a completed pass is worth

A pass is complete when it **generated every URL it owed and, where it probes, drained `wip`**. For an
update that is the equivalent of a walk having read the whole index: a transient failure would still
be in the queue, so a drained queue means everything left in the record is an answer.

Only then does reconciliation run — `reconcile` in `catalog/series.ts`, once per venue, after a walk
and after an update alike. It works **as of the pass's start, not the clock**: a pass that ran for two
days asked about the archive as it stood when it began, and reconciling against `now` would claim the
days it spent running. The start is read off the pass's own run rows, so a resumed pass reconciles as
of when it first began. Per series, with `START` that start:

```
1.  floor := lastSettled(grain, START)                                 START - OVERDUE_DAYS
    tip   := max(tip, floor, min(last, lastClosed(grain, START)))      the min left out where last is NULL
2.  no file other than an absent one:
        nothing in file or wip refers to the series  →  the series is deleted
        otherwise                                     →  left as it stands
3.  otherwise:  first, last := the oldest and newest non-absent file dates
```

The three are counted as `lifted`, `removed` and `corrected` on the `Update finished` or `Walk
finished` log line.

**Step 1 retires an absence for good**, without anyone having tracked which series had a gap:
everything at or below the floor was asked and waited for, so a real hole, a transient miss that
settled later, and the dead range below a newly listed instrument's true start all go the same way.
**A file is proof, and proof outranks patience**: where a series' newest file is above the floor
there is nothing left to wait for below it, so the tip goes to that file — but never past a period
that has not closed, since a file in an open period proves that file and not the period. The tip
never lowers. Step 1 reads `last` as it stood before step 3, so a newest file withdrawn on this pass
can still lift the tip. After it, a series that found something has its tip at its newest closed
file or at the floor, whichever is higher, and one that found nothing sits *exactly* at the floor.

**Step 2: a series with no files is not a measurement.** A finished pass asked every period the series
covers and the archive answered for none of them, so the row has nothing to say, and keeping it costs
`OVERDUE_DAYS` of keys a day. **The listing has no bearing on it**: an instrument the venue lists
today that has never published is exactly as empty as one it has forgotten, and a retired shape will
never produce a first file for either. **Deleting is self-correcting**: a symbol still listed on a
live shape is created again by the next preamble and backfilled — find files and they stay, find none
and it goes again, until the day something publishes. A symbol that is gone, or a shape that is
retired, is not recreated (`patternsOf` offers no retired pattern), which is what stops a dead branch
being probed for ever.

**The delete asks the file table, not `first`**: the file table is authoritative about whether a
series holds anything, and the column is not trusted for a removal. A series whose files the venue
withdrew, or with a key still parked, keeps its row, since deleting it would orphan what refers to it.

**Step 3: the bounds are set to what the files hold, not widened to it.** Everywhere else a bound only
moves outward, because the evidence is one file; here it is the whole series, so a bound that
disagrees with it is replaced — the only way a withdrawal narrows one. Each series costs two ordered
lookups on the `file_series` index, one at each end. `corrected` is expected to be zero.

**Nothing is delisted here.** A quiet series is not a delisted one, and when to stop asking is
[`open`](#open-when-keys-are-still-generated)'s question, answered from the row each time.

**It yields to the event loop every 1,000 series** (`YIELD_EVERY`), each stretch between yields one
transaction, so a venue's few hundred thousand series do not hold the process — `/status` included —
for the length of the loop.

**A pass that did not finish reconciles nothing.** Blocked, paused, a partition that could not be
read, a venue answering nonsense — all of them return normally and none has checked anything. Lifting
their tips would assert the last `OVERDUE_DAYS` were asked about when they were not, permanently,
since a tip does not come back. The pass logs `Pass unfinished` (unless it was paused), stays open,
and is reconciled by whichever run of it finishes.

### A period published in parts

**A period is what a consumer asks for; a part is one of the files it arrived in.** Some archives
publish a day as one file and some as several — bitget cuts a day's trades every hundred thousand
rows into `_001`, `_002` and on; gate writes a day of books as twenty-four hourly files. The
consumer's question is the same in both cases, so the *grain* stays the day and the pattern says
where the difference goes, with a `{PART}` slot:

```
trades/{TRANSFORM:marginToken:UMCBL}/{SYMBOL}/{SYMBOL}_{YYYY}{MM}{DD}_{PART}.zip
spot/orderbooks/{YYYY}{MM}/{SYMBOL}-{YYYY}{MM}{DD}{PART}.csv.gz
```

**The venue names its own parts**, through `expandParts`. It is told the series, the period, whether
the last part turned out to be there, and whatever token it asked to have handed back — and it names
what to ask for next. Tokens, never paths: putting one into a pattern is the core's job, and knowing
which tokens exist is the venue's.

| it returns | meaning |
|---|---|
| `null` | the period is finished, or was never there |
| `{ parts, next }` | ask about these, and come back to me with `next` when one settles |
| `{ parts }` | ask about these; they are the last word on the period |

**`next` is the only state, and the core never reads it.** It is the adapter's note to itself, stored
on each key it names and handed back unread. So an adapter that needs no token to know what follows —
gate knows a period's parts from the period alone — puts a mark there meaning nothing but *ask me
again*, and reads its own mark when it comes back. Nothing is remembered anywhere else, and nothing
about the arrangement is a convention the core has to honour.

That covers both shapes with one hook. A venue that cannot know how many parts there are names them
one at a time and reads each answer — bitget's chain ends where the archive does, at the first miss.

gate names a period's parts from the period alone: a day's 24 hours, or a snapshot tree's epoch
stamps across a month (an hour apart in `spot_index`, a minute apart in `options_ticker`). For a
series with no `first` it asks about all of them at once, since an instrument's first day begins
mid-period. Otherwise it asks about the first part and, only if that is there, all the rest in one
reply — gate publishes a day of books whole or not at all (over 40 hourly series, 753 of 769 middle
days carried all 24 hours and 767 carried hour 00, while none of forty first days carried hour 00),
so a quiet day costs one request rather than 24.

**A size threshold was the obvious alternative for bitget and is the wrong shape.** It would guess
where the venue states: one request saved against a silently truncated day.

#### What the two callers do with it

**Generation follows the chain in memory first.** Before a single request, it walks the parts the
catalog already holds, reporting each back to the hook as present, and emits only the ones it does
not have. That is what lets an update finish a day a walk left half-catalogued: a chain that stopped
at the first file it already had would never reach the rest of the period. A token it has already
seen ends the period — the core cannot read a token, so it cannot tell a cycle from progress by
looking, only refuse to go round twice.

**The probe carries it on from there, on settlement and only on settlement.** A part reports back
when its fate is final: catalogued, or set down as absent — see [what ends a
key](#what-ends-a-key-absence-confirmed). A `404` the core will ask about again is still an open
question, and a `503` is not an answer at all — put either to the hook and the same period is
expanded once per attempt. That is also what makes the answer a boolean rather than a status: by the
time it is asked, there is nothing left to interpret.

What the hook names is parked before the row that revealed it settles, so a crash between the two
costs a repeated probe rather than the keys. And because a pass finishes only once `wip` is drained,
no tip moves over a period while one of its parts is still outstanding — the rule tips already
follow, needing nothing part-specific.

**A row with no token is never brought back.** That is how a reply without `next` ends a period, and
it is stored rather than derived: the token is already inside the key, but taking it back out would
mean inverting a pattern's substitution and guessing where the slot ended. One nullable column against
an extraction that can be wrong.

**A period is only ever asked about once it has closed**, like any other, so naming every part of it
is a statement about a period that is over rather than a guess about the future.

#### What `ruleOnSuccess` is for

A probe that settles is still put to the adapter, through `ruleOnSuccess(row, size)`, for the
unrelated case of an archive whose published key is not the file:

| it returns | meaning |
|---|---|
| nothing | the ordinary case, and every venue today |
| `action: 'accept'` | settle the file as usual |
| `action: 'replace'` | discard it — it never reaches `file`. For an archive whose key names a manifest rather than the data |
| `next` | keys to park in `wip`, inheriting this row's series and period |

## Venue by venue

How this service handles each venue: which adapters it has, what they refuse and why, how the
venue's instruments are read, and where a general mechanism above is this venue's case. **What the
venue publishes, and the evidence for every figure, is its doc** under [docs/venues/](../venues/).
Each adapter's `pacing` and `probingLag` are declared beside it in `src/adapters/`; the lags are
tabled in [how far behind today](#how-far-behind-today-a-probing-update-asks).

### binance

One adapter, listed at the bucket (`s3-ap-northeast-1.amazonaws.com/data.binance.vision`) with an
empty key root. The CDN in front of it, `data.binance.vision`, is recorded in `alternative_hosts` and
never asked. Facts: [BINANCE.md](../venues/BINANCE.md).

**Surveyed from the bucket root, so nothing is stripped.** `data3/liquidationSnapshot/`, the only
USDⓈ-margined liquidation snapshots, sits beside `data/` rather than under it, and descent finds
nothing above where it starts. Paths therefore keep their leading `data/` or `data3/`, and a URL is
`base` + `/` + path.

**`accepts` refuses four things the root also reaches**, and each refusal is a cost avoided:

- `data2/`, a staging area of copies.
- A bare key directly under `data3/`: only that tree's subdirectories hold data.
- The tree whose keys begin with `/`: a frozen snapshot of the spot archive holding strictly less
  than `data/spot/monthly/`, file for file. It is historical data, and the one refusal of that kind:
  earned by reading both renderings and finding one to be the other with less in it.
- The `1w`, `3d` and `1mo` intervals, as a path segment, on every interval dataset and both trees.
  Each is an aggregate of the `1m` variant the catalog holds, and they publish irregularly, so their
  series' tips sit behind the frontier and re-ask every open day. On a catalog that holds them they
  are 51 patterns and 22,155 series, and some 55% of binance's nightly update.

**`um` and `cm` are one canonical market and two keyspaces.** The instruments hook records which
futures service listed a contract (`um` from `fapi`, `cm` from `dapi`) as its `category`, and
`categoryOf` reads the same segment out of a pattern, so a newly listed contract is given only its own
service's shapes — see [one market can be more than one archive](#one-market-can-be-more-than-one-archive).
Unfiltered, a newly listed perpetual would get a series under both trees, half of them describing
keys the venue never writes, each a request a day.

**Dated contracts and options are read from the same listings.** A contract whose type is not
perpetual is a `future`; options are listed by underlying, one instrument each, from `eapi`.

**Shapes binance stopped writing are seeded retired**, by migration `006-binance`: `bookTicker` and
`liquidationSnapshot` of both futures services and the options `EOHSummary`, eight shapes, each at
the date it stopped. The files stay catalogued; only generation stops, since an instrument binance still
lists would otherwise keep its dead shapes open.

No throttling answer has been seen from the bucket; how the client reaches it, and what a limit
nobody has reached would look like, is in [carrying requests](#carrying-requests).

### bitget

One adapter, on the `probed` scanner: the bucket grants no listing, so `listable` is false and every
pass is an update over series declared by migration `004-bitget` from `seeds/bitget/` (see the
[seeds README](../../services/prospector/src/database/migrations/seeds/README.md#the-bitget-seed)).
Facts: [BITGET.md](../venues/BITGET.md).

**Discovery reads the v3 instruments listing, for `SPOT`, `USDT-FUTURES`, `COIN-FUTURES` and
`USDC-FUTURES` only**, one request a category (`bitgetInstruments`). Everything it names is live. What
only the v2 listings name — the classic coin-margined line, v2 delivery contracts, the demo product
types — is not discovered, and neither is an instrument bitget no longer lists: those are reached only
where the seed holds them. The two APIs list different instruments
([BITGET.md](../venues/BITGET.md#the-two-rest-apis-are-two-account-systems)).

**Non-crypto instruments are refused at discovery**, before anything else is asked about them.
`marketOf` (`adapters/bitget/shapes.ts`) calls them `tradfi`, and `tradfi` is dropped: on spot,
anything whose `symbolType` is not `crypto`; on futures, anything flagged `isRwa: YES`. Those are the
flags that separate the two ([BITGET.md](../venues/BITGET.md#two-fifths-of-what-bitget-lists-is-not-crypto)).
They are refused rather than catalogued because the venue's naming is at its most irregular there —
reused tickers, shortened names colliding with other instruments, directories reassigned — and none
of it has to be modelled for instruments that are never admitted.

**A new instrument's archive spelling is asked of the venue.** For each name the catalog has never
met, the trading platform's search is asked once (`archiveNamesOf`), and its `symbolCode` is the
spelling the files use; where it does not answer, the rules in `adapters/bitget/symbols.ts` give one.
`urlSymbolFor` hands the spelling to the preamble per pattern.

**The margin token comes with the listing.** A futures contract's trades are filed under `UMCBL`,
`DMCBL` or `CMCBL`, and nothing in the symbol says which. The token is the one the search's
`symbolId` carries, or else the one the listing category maps to (`tokenOf`), and it is written as a
`marginToken` transform before the contract's series are — none where it is the patterns' default,
`UMCBL`. A wrong token builds keys the bucket answers with its `403`, which here is absence, so the
contract would read as one that publishes nothing.

**A `403` from the bucket is absence; anything not served by `AmazonS3` is a refusal aimed at us.**
`ruleOnFailure` answers `'drop'` for the first and `refusesUs` names the second — see
[what ends a key](#what-ends-a-key-absence-confirmed). A day's trades are numbered parts, followed to
the first miss ([a period published in parts](#a-period-published-in-parts)).

Paced at 2,500 requests a second with 500 in flight, under the edge's measured limit. Its bucket
answers a missing key in a way that makes a probe over HTTP/1.1 cost a connection, which is why
probes go over HTTP/2 ([carrying requests](#carrying-requests)).

### bybit

Two adapters sharing the name, one per server. Facts: [BYBIT.md](../venues/BYBIT.md).

**`bybit/primary` is the main archive, listed at its bucket** (`s3.ap-southeast-1.amazonaws.com/public.bybit.com`)
and never at the CDN in front of it, which bans at rates the bucket takes without a refusal — the
pacing reasoning is in [pacing](#pacing-one-gate-per-venue-per-host). Its listing carries size, ETag
and last-modified, so a walk probes nothing. `accepts` refuses `backup/` (a copy of files served
under `trading/` too), every key at the bucket root (the browsing UI), and the four 2021 expiries
under `trading/` — fragments of contracts rather than series of them, absent from bybit's own
download form. One misfiled `DOTUSDT` day is a row in the `exclusion` table. `slotsFor` renders
`{MONTH_LAST_DAY}` for the MetaTrader klines (see [the slot table](#a-constructed-key-venue-is-still-a-scanner-and-must-behave-like-one)).

**`bybit/secondary` is the order books**, on `quote-saver.bycsi.com` under the key root `orderbook/`,
read from browsable indexes with `html.ts`. The index names files and says nothing else, so every
key is probed. A key an index named is kept through up to 100 `404`s while a walk is running; on an
update it is the core's ordinary guess — see [what ends a key](#what-ends-a-key-absence-confirmed).

**Both read the same listing**: spot, `linear` and `inverse` (both perpetuals), and options by
underlying. bybit lists no underlyings, so the ones asked about are those the catalog already holds,
and an underlying is live while any of its contracts trades.

### gate

One adapter, listed at the bucket (`s3-ap-northeast-1.amazonaws.com/gateio-public-data`); the CDN,
`download.gatedata.org`, is recorded in `alternative_hosts` and never asked, since its own listing
ignores what it is asked. Facts: [GATE.md](../venues/GATE.md).

**`accepts` keeps seven trees and refuses the rest**: `spot`, `futures_usdt`, `futures_btc`,
`tradfi`, `delivery_usdt`, `spot_index` and `options_ticker`. The others are dead, not market data,
or not gate's: `hk/` and `malta/` are separate order books, so their `BTC_USDT` is not gate.com's,
and were either wanted it would be a venue row of its own rather than a prefix of this one. Within
the seven, `accepts` also refuses:

- a key at the wrong depth: what sits directly below a tree is a month for the two snapshot trees and
  a dataset name for every other;
- an `s3deals/` directory directly inside a dataset month;
- a file whose directory and filename name different months (`gateMisfiled`), except hourly books,
  whose misfiled hour is the only copy, and the closed list of klines with no correctly filed twin
  (`adapters/gate/misfiled.ts`);
- a file under `futures_btc/` whose instrument is not a `*_USD` (`gateWrongTree`).

The two zero-byte uploads and the 85 spot files served at futures URLs for 2021-07 are rows in the
`exclusion` table: there is no shape to describe.

**The misfiled files that are kept sit on literal-month shapes, seeded retired** by migration
`005-gate` — see [a directory that names another period stays literal](#a-constructed-key-venue-is-still-a-scanner-and-must-behave-like-one),
which also has what those shapes cost while live. Its books and snapshot trees are periods published
in parts: [a period published in parts](#a-period-published-in-parts) has how gate names them.

**Tradfi's `status` is not read.** `/api/v4/tradfi/symbols` reports the exchange session, which is
closed for every symbol outside US market hours, so read as listing state it would delist the whole
market on any pass that ran out of hours and revive it on the next. Every symbol the list names is
live, and a symbol leaving the list is a delisting. Spot reads `trade_status` (`untradable` is not
live) and contracts read `in_delisting`, which do carry listing state.

gate declares no `probingLag`, so it takes the default of one day.

### htx

One adapter, listed at the bucket (`huobi-service-data.s3.amazonaws.com`) with an empty key root, so
both of its trees, `historical_data/` and `data/`, are walked; the CDN, `www.htx.com/data`, is never
asked. Facts: [HTX.md](../venues/HTX.md).

**`accepts` refuses** the browsing UI's `assets/`, the scratch directory `test/`, each dataset's
`remark.txt` (field descriptions with no date, which nothing would place in a series), and every
`data/` key dated 2026-02-01 or later.

**The two trees overlap, and each instrument-day is catalogued once.** From 2026-02-01 to 2026-08-04
both publish the same instrument-days under different schemas. Catalogued twice, one unit would
arrive from two shapes with nothing to say which is the data, and a day would read as covered or
missing depending on the tree asked. So the cut is one date, decided from the path alone and holding
for keys nobody has listed yet: `historical_data/` throughout, and `data/` before **2026-02-01**
(`MIGRATED` in `adapters/htx.ts`). That date is where `historical_data/` begins, and every day
`data/` holds from it on is also in `historical_data/`, with the two exceptions below — so an earlier
cut would lose `data/` days the new tree lacks, and a later one would catalogue days twice. It is the better branch on its merits too: `data/` is the tree with holes in it
during the overlap.

**Two things are knowingly given up, and are refused with everything else**: the nine perpetuals
`historical_data/` never carried, all stopped by 2026-08-03, and one day of `indexPrice` for nine
coin-margined perpetuals. Both are sparse tails on near-dead instruments, `data/` still serves them,
and a rule carrying symbol-level exceptions costs more than they are worth.

**The end of `data/` is catalog state.** Migration `002-htx` seeds the 90 `data/` patterns with
`retired_at` 2026-08-04, the day the tree was last written, so no newly listed instrument gets a
series on them and generation stops at that day; `accepts` refuses the overlap wherever a key
arrives, listed by a walk or generated by an update. Neither date can be found by reading the
archive, which is why both are declared.

**One instrument, two spellings.** The catalog names an instrument the way `historical_data/` does,
dashed, without the `-PERP` its perpetual shapes carry in the pattern, and a `data/` series carries
the old tree's spelling as its `url_symbol`.

### kucoin

One adapter, listed where the files are served (`historical-data.kucoin.com`) under the key root
`data/`. Facts: [KUCOIN.md](../venues/KUCOIN.md).

**`accepts` refuses futures klines at `1d`**, published with five fields under a six-field header, so
the bar has no volume ([KUCOIN.md](../venues/KUCOIN.md#futures-klines-at-1d-are-published-broken)).
Nothing is lost: a day is an aggregate, and the `1m` series covers the same range.

**The catalog names an instrument as kucoin's API does**, and a series carries the archive's spelling
as its `url_symbol` where it differs: spot klines and trades drop the dash (the dash is put back from
the quote currency when a path is read), and bitcoin contracts the API names `XBT` are filed `BTC`
(perpetuals everywhere, dated contracts only under books). `inspectUrl` reads a path into the API's
name, and `urlSymbolFor` is its inverse.

**Every futures instrument is a `perp`**, the few quarterly contracts among them included. Spot is
read from `/api/v2/symbols` (`enableTrading`) and futures from `/api/v1/contracts/active`
(`status: Open`).

### okx

One adapter, on the `probed` scanner: nothing can be listed, so `listable` is false and every pass is
an update over series declared by migration `003-okx` from `seeds/okx/`. Facts:
[OKX.md](../venues/OKX.md).

**The venue-wide files are `@` series, seeded one per bucket pattern.** `allspot`, `allswap`,
`allfutures`, `alloption` and `allmargin` name no instrument, so their ten patterns carry no
`{SYMBOL}`; the preamble never gives such a pattern to an instrument and never delists it — see
[a shape with no symbol](#a-shape-with-no-symbol-cannot-be-branched-by-symbol). A dated chain's
`futureschain` or `optionchain` belongs to its pattern, so an instrument is named by its family.

**Instruments are read from the v5 instruments listing**, a market at a time and options an
underlying at a time. A family is the instrument, live while any of its contracts is. **A `preopen`
instrument is listed as not live**, so no series is created for it, though it counts in `listed`.
**Test pairs are refused** by their base (`isTestPair` in `adapters/okx/shapes.ts`), since okx's
`state` does not mark them.

**A `404` settles a key, and a `403` is a refusal aimed at us.** okx never answers one for the other,
so `ruleOnFailure` answers `'drop'` on the first `404` — see
[what ends a key](#what-ends-a-key-absence-confirmed). Paced at 100 requests a second with 100 in
flight: its CDN is clean at 100 and refuses at 200.
