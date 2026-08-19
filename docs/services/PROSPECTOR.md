# Prospector

## The goal

**Every venue publishes its history as files, and no two of them agree about anything else.**

The trees differ, and so do the names inside them. One venue exposes a complete index; another
indexes part of its bucket and leaves the rest reachable but unlisted; another has no index at all
and expects a human at a download form, or a third-party service that already knows where to look.
The vocabulary differs too: one writes `candlesticks_1m` where another writes `klines/1h`, one calls
a perpetual `futures_usdt` and another `SWAP` and another `linear`, one files a month and another
files each day of it, and the date sits wherever that venue happened to put it.

**The catalog exists so that nothing else in the monorepo ever learns any of that.**

It is the one place that knows where a venue's files are and what each one is. Everything downstream
asks in one vocabulary and is answered with URLs that work:

> *1h klines for this venue, monthly files, in this range, for these instruments.*

Markets, datasets, bar lengths, book depths and dates are canonical — `perp`, `klines`, `1h`,
`202406` — whatever the venue calls them. The consumer never learns which tree, which spelling, or
which of the venue's two renderings of a month it is holding, because it asked for the one it wanted
and got that.

**Prospector is the service that owns the catalog.** It orchestrates discovery — establishing what
each venue publishes and keeping that current — and it serves the listing. Nothing else opens the
database.

## What it produces

A SQLite database — one row per file a venue publishes, carrying the path, the date it covers, its
size, its checksum, and the **series** it belongs to: which market, which dataset, which variant,
which instrument. Alongside it, a record of which parts of each archive have been established and
how far each series has been read.

That turns questions which otherwise cost network requests — or a consumer that knew how to read
every venue's paths — into questions that cost a query: what does this venue publish, over what
period, how many files, how large, where is a given file, what is that file *of*, and has this part
of the archive been established or not.

## Why it is a service of its own

**Discovery and downloading are separate problems.** Both are full of per-venue nuance and the
nuances have nothing to do with each other. Discovery is about how a venue exposes its keyspace —
what can be listed, how it paginates, which trees it hides, where a date sits in a path. Downloading
is about reading a response — whether a 403 means "never published" or "you are blocked", whether a
404 can be trusted, when to back off. Held in one service, every venue's quirks in either half land
in the same place and it has to know both. Held apart, the surveyor never learns how to fetch,
unpack or normalise anything, and the downloader never learns how to enumerate: it reads a table.

**The pipeline stages decouple, in space as well as in time.** The catalog is a file, so surveying
need not happen where downloading happens. A machine with bandwidth and little disk can survey a
venue; a machine with storage downloads from the resulting catalog, imported whenever it suits.
Refreshing decouples the same way — a newer catalog can be built on one host while a downloader
keeps working from the one it already has.

**The whole picture arrives in hours instead of months.** A survey answers *how much is there* before
anything is fetched: this venue publishes this many files, taking this much space, over these
periods. Provisioning becomes a decision made up front rather than a wall hit two months into a
download, and "1w or 1mo klines", "this symbol or that one", "is this dataset worth collecting at
all" each carry a real number before anything is committed to.

The catalog is worth persisting because **an archive is stable**: historical files do not change and
new ones only ever appear at one end, so what a survey establishes stays true and there is no reason
to re-derive it on demand.

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
honouring `prefix` and `marker`, so they share `s3.ts` between them. A second reads browsable HTML
directory indexes — the page a plain file server renders when there is no `index.html`. A third,
`probed.ts`, is the description of a venue that cannot be listed at all: it has no keyspace to walk,
so it answers one question only, which is what a `HEAD` says about a single key. Each is named after
the shape of the thing rather than after a venue, which is why it survives the venue that prompted
it — `probed` was written for okx and bitget arrived needing nothing new.

Bybit needs both, and that is what makes the split concrete. Its main archive was surveyed through
the indexes until the bucket behind that CDN turned out to be publicly listable, and moved to `s3.ts`
when it did. Its **order books** live on a different server entirely, `quote-saver.bycsi.com`, which
answers no listing API — so that half is still an index walk, and it is the venue on `html.ts` today.
One venue, two servers, two scanners, and neither adapter knows the other exists.

**Where descent stops is not a wire format**, so the rule lives in one place and each scanner only
supplies a way to read one level. Paging is where the two genuinely differ: an S3 partition is a
straight line resumed by a marker, while an index directory answers in full and a walk is a tree
traversal resumed by the directory it last read.

```
src/scanners/descend.ts     where descent stops, and what counts as a file — written once
src/scanners/s3.ts          XML listings: prefix, marker, IsTruncated
src/scanners/html.ts        directory indexes: links, and a depth-first walk
src/scanners/probed.ts      no listing anywhere: nothing to walk, one HEAD per key
src/scanners/none.ts        the null scanner: a venue registered before it can be read
src/survey.ts               map, resume, commit, record — written once
src/update.ts               the other way to make a page: dates substituted into a pattern
src/probe.ts                settle metadata a listing could not carry — written once
src/sync.ts                 one server's life: walk it, drain its backlog, stop
src/pace.ts                 one gate per host, and the machine-wide ticket pool
src/http.ts                 the single fetch every request passes through, retries included
src/paths.ts                the string rules the catalog and every scanner must agree on
src/dates.ts                periods, grains, and what "the last complete one" means
src/database/               opening, schema, migrations, and the seed data they insert
src/catalog/                the domain: series, queries, keys, the rollup
src/api/routes.ts           the catalog, as everyone else reaches it
src/venues.ts               the registry: which adapters exist, and addressing them at startup
src/adapters/<venue>.ts     one server: its addresses, its date rule, its policy, its hooks
src/adapters/<venue>/        the strategy an adapter should not become — what a venue lists,
                            how its archive spells an instrument, which shapes it uses
src/preamble.ts             asking a venue what it lists, before anything is generated
src/backfill.ts             where a series nobody has read starts, by probing down from the floor
src/context.ts              the shared context every listing venue hands its scanner
```

An adapter answers a handful of questions and holds no control flow:

| | |
|---|---|
| `root` | where descent starts, and what is stripped from a stored path. Empty means the whole bucket, stripping nothing |
| `dateOf(path)` | the period a path covers, or null — the one thing no generic rule recovers, since every venue puts the stamp somewhere else |
| `inspectUrl(path)` | what a path **is**: market, dataset, variant, instrument, canonically. Only ever asked on a walk — a generated key carries its series instead, so a venue that cannot be listed needs none at all |
| `tagOf(path)` | a discriminator where a venue publishes the same period twice; opaque, never parsed here |
| `accepts(path)` | **policy**: whether a path belongs in the catalog at all. Asked of prefixes as well as keys, so a refused directory is never descended into |
| `listable` | whether the archive can be listed. False means it never walks: its series are declared and every pass is an update |
| `probes` | whether a `HEAD` is needed. True for two opposite reasons — a listing that names files and nothing else, and a venue with no listing at all |
| `pacing` | what this host tolerates, beside the evidence for the number. Never configurable: what a venue tolerates is a fact about that venue |
| `getContext(db, occasion)` | everything its scanner needs, assembled before the walk. The **occasion** says how much reaching out is allowed |
| `slotsFor(at)` | a slot a calendar cannot spell — a month named by both its ends, a file named for the instant it covers |
| `categoryOf(pattern)` | which keyspace a shape serves, where one canonical market is two archives and a contract domiciled in one can never hold a key in the other |
| `urlSymbolFor(found)` | how the archive spells an instrument. A listing has no path to read it off, so without this a newly listed instrument generates URLs under a name the archive does not use |
| `instruments(db)` | what the venue lists today — the only way any venue hears about a symbol listed since its backfill |
| `refusesUs(status, headers)` | whether a refusal is aimed at **us** or at one key, where the core's reading is wrong. A bucket that answers `403` for every object it never held looks, by status alone, exactly like a ban |
| `ruleOnFailure(status, headers, tries)` | what a probe that did **not** settle means here — for that same venue a `403` is its `404`, and re-confirming those absences would spend millions of requests to learn what the first answer said |
| `ruleOnSuccess(path, size)` | what a probe that **did** settle implies about the next key — see [when one key implies another](#when-one-key-implies-another) |

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
outrun a cadence or log as the wrong venue. One factory in `context.ts` builds it for all of them.

**`occasion` says how much an adapter may do to build it**, and it has three values. `'full'` and
`'partial'` both reach the venue: reconciling against its instrument listing is the only way a new
symbol is ever discovered, and probing can only ask about series it already knows — so an update that
skipped it would never find an instrument listed since.

`'lookup'` is the one that reaches nothing. It is what an HTTP handler passes to confirm a single key
inside a request, where an adapter that fetched would turn one confirmation into an unbounded call in
a request handler.

**Which of the first two is decided by where the venue has got to**, never by what a caller asked
for — see `phaseOf`. A venue that has been complete updates for ever after, and one that cannot be
listed at all never walks even once.

### One run, two ways of making its scopes

A survey is one run in one of five phases, and every phase is read off the run rows rather than
recorded: **not run**, **planned**, **running**, **complete**, **updating**. Reaching complete once
is permanent — a venue never goes back to walking scopes it has already exhausted.

What differs between a walk and an update is only **where the scopes come from**:

| | walking | updating |
|---|---|---|
| scopes | the archive, mapped by the scanner | one per series, read off the table |
| a page | a listing request | dates substituted into a pattern, no request at all |
| splitting | a fat prefix is refined into its children | nothing to split: a series is already the smallest unit |
| withdrawal | a range walked to exhaustion can say a file has gone | claims nothing: it only ever asked for what it generated |
| probing | only where the scanner carries no metadata | always, because nothing generated carries any |

Everything after the scopes exist is the same code — the same cursors committed page by page, the
same job that stays open until each is exhausted — which is what makes both stoppable and resumable
by the same machinery.

**A venue that cannot be listed never walks.** okx and bitget both declare `listable: false`: there
is no keyspace to read, their series arrive by declaration, and their very first pass is an update
over them.

**A seed is what a walk would have produced.** The two are not different designs. A catalog starts
from a search space - the patterns, a series for every instrument that ever occupied one, the floor
each shape starts at - and every pass after that generates keys from it and records what answers. A
walk produces that search space as a by-product of reading an index once; a seed states it directly.
Discard everything a walk learned except those three and hand them over as a seed, and the first
update rediscovers the files and arrives at the same catalog. What a seeded venue is owed is
therefore not a different kind of pass, it is the backfill a walk would have done for free - and the
work of establishing its search space, which for an unlisted venue is research rather than reading.

**Neither kind discovers a pattern on an update.** Only a walk creates one, from a path handed to it
by an index; an update generates keys from patterns already held and can never meet a shape it has
no pattern for. So a venue that changes its naming convention costs a listed venue a re-walk and an
unlisted one another round of research.

**What only a seed can supply is narrower than it looks**, and being precise about it is what stops
the next reader over-crediting the file:

| | where it comes from |
|---|---|
| **a pattern** | the seed, and nothing else. An update generates from shapes it already holds and can never meet one it has no pattern for, so at an unlisted venue a shape absent from the seed is invisible for ever |
| **a series for an instrument the venue still lists** | the seed *or* the preamble. A listing names it and the preamble gives it a series per shape of its market, exactly as at any other venue |
| **a series for an instrument nothing lists any more** | the seed, and nothing else. No API names a delisted symbol, and its files are in the archive all the same |
| **a floor** | the seed. Generation starts above a tip and a tip only ratchets forward, so history below a seeded floor is asked about by nothing afterwards |

**So discovery is not what separates the two kinds of venue.** Every venue, listed or not, discovers
new instruments the same way once its backfill is behind it: the preamble asks the venue's instrument
listing. What differs is only how the backfill itself happened — a listed venue found its patterns,
its series and its files in one walk, while an unlisted one was handed patterns and series and then
guessed keys and confirmed them. After that both are in the same steady state, and a full re-walk is
a refresh rather than a mode.

### A seed is research before it is data

**Writing one is a project, and the service is the instrument for it.** The shapes, the canonical
names, which spelling the archive uses for each of them, which series should exist at all — none of
that is visible from the ordinary flow, and establishing it means hitting a venue's download portal,
its internal search, its several listing APIs: endpoints prospector will never touch while surveying.

The way that work converges is to run prospector against a **deliberately wrong** seed. Floors go far
below where any file can be, series are declared for combinations nobody expects to exist, and the
pass is allowed to ask about all of it. What comes back is the measurement: the `file` table then
says which series are real and where each one truly begins and ends, and the permanent seed is
written from that. A separate script could do the same crawl, and would be re-implementing generation,
probing, pacing and resumability to do it.

So a seed on disk is in one of two states, and they read almost alike:

- **research** — floors per dataset rather than per series, series the pass is expected to delete,
  bounds taken from whatever the venue's own index claimed. It exists to be replaced.
- **permanent** — floors that are each series' measured start, and only the series the archive
  answered for. This is what okx ships today, arrived at exactly this way.

A venue holding a permanent seed finds its whole history as surely as a listed venue walks to its
own, which is the point of paying for the research once.

**`first` is a measurement, and any sighting makes it.** It is the earliest file the catalog has
seen, so it is written by the first one that answers and lowered by any earlier one — whether that
answer came from an index or from a probe. `sawFile` is the only thing that moves it, from the file
in front of it, which is why a venue with no index arrives at the same bound as a walked one.

**`last` is not maintained at all.** It says nothing more will ever be published, which no sighting
can establish — it is a measurement something made deliberately, or it is nothing. Detecting it is an open
question rather than a gap. Neither has a generator of its own — generating dates inside known bounds is what every
venue's update does, in `update.ts`.

**Bootstrapping is the adapter's, not the scanner's.** A venue with no listing has to know its own
bounds before it can build a single key, and finding them is hours of probing. That is not scanning,
so it lives beside the adapter in `src/adapters/<venue>/`, and leaves its results in the catalog
where generation reads them. The scanner never sees a database.

**The `series` table itself belongs to the core**, in `catalog/series.ts`, which is the only thing
that reads or writes those rows — every file a venue publishes belongs to one, so it cannot be a
structure some adapters opt into. What stays with an adapter is the *reading*: how a URL resolves
into market, symbol, dataset, period and pattern, and which of those a given venue can answer at
all.

`dateOf` says what a path *is*; `accepts` says what we have *decided about it*.

### What gets excluded, and from where

Only things that are **not proper historical data**: a bucket's web assets, a venue's staging area,
temporary files, and files served with corrupt or wrong contents. Not data that is merely
unannounced, unreliable or superseded — an abandoned earlier generation of a month is still that
month, and whether it is worth using is the consumer's call. A catalog that has already decided
cannot be asked.

The split is whether the thing can be *described* or only *listed*:

| | where it lives | who maintains it |
|---|---|---|
| **A pattern**, holding for keys not yet published | the adapter's `accepts` | prospector — it is code |
| **An enumeration** of specific known-bad files, growing as more are found | the `exclusion` table | anyone, by hand |

The second exists so that finding a bad file costs a row rather than a rebuild and a redeploy. Gate's
2021-07 futures trades — 85 symbols whose files are truncated copies of *spot* data, and re-fetching
returns the same bytes — are the case in hand.

**A walk only reads the table.** Its rows are loaded into memory when a job starts and checked before
the adapter is asked; nothing in the survey path writes them or reasons about where they came from.
They are maintained over the API instead — `POST /venues/:venue/exclusions` with a path and a reason,
`DELETE` by the key the listing hands back — so ruling against a file costs a request rather than a
rebuild and a redeploy, which is the whole reason this is a table and not a list in code.

An exclusion applies to **every server of the venue**, so a caller never learns that one of them is
served from two machines: a path that exists on only one is harmless on the other, since these match
exactly. And nothing already catalogued is removed — this says what must not be *fetched* again,
while what a venue once published stays on record.

Adding an S3 venue is one file and one line in the registry. Adding a venue on a new platform adds
one file in `venues/` and one in `scanners/`, and changes nothing that already exists.

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
4. the walk completes, and from then on it updates.

**An unindexed venue** — okx, bitget — has no index to walk, so it has no way to map itself that way:

1. its series are declared up front, shipped as a migration;
2. it updates.

There is no splitting and no backfill from an index, because there is nothing to read. **Its heavy
lifting happens as the update step**, which for a fresh catalog means generating every key inside
every series' bounds — the same code path an indexed venue reaches later, doing more work the first
time round.

So the two converge: whatever a venue's scanner is, **once its series are known it updates by
probing**, generating the dates missing between each series' tip and today. That is why probing is a
property of the phase and not of the adapter.

Two things this shorthand gets wrong if it is compressed any further:

- **"Unindexed venues need a migration" is not true, and would block adding one.** A seed is an
  optimization: it saves re-paying for bounds already measured. A venue with no seed builds its
  series the way a seeded venue builds one for a symbol that lists tomorrow — instrument listing for
  the universe, probing for the bounds.
- **"Unindexed venues don't discover series" is not true either.** Nothing discovers by probing; an
  update asks the venue's instrument API. An indexed venue needs exactly the same thing the moment
  its walk is behind it, so discovery-by-API is what *updating* requires, not what *being unindexed*
  requires.

And what neither path covers: a **new dataset or a new pattern**. Probing cannot see one and the
instrument API does not name one. That is what an occasional full walk, or a cheap delimiter-map of
the tree, is for.

## The state flow

Everything is determined by the run's own entries. Nothing needs to be recorded separately.

| state | what it means | how it is recognised |
|---|---|---|
| **not run** | nothing exists yet | no scopes |
| **planned** | default scopes created, no progress — a brief phase while getting ready | scopes, none with progress |
| **running** | walking; scopes refine themselves, spawning children and retiring | at least one scope open |
| **complete** | got as far as the data allowed | every scope exhausted |
| **updating** | finding files added since | every scope exhausted, and it has been complete before |

**Complete is transient.** It means the run reached the end of what existed at that moment, and new
data makes it incomplete again within a day. What is *not* transient is the consequence: once a run
has been complete, its resuming mode changes permanently to updating. It never goes back to walking
scopes it has already exhausted.

**Withdrawal falls out of this rather than needing a flag.** Marking a file the venue pulled requires
having walked a scope to exhaustion in the index, so it belongs to the walking phase and simply does
not arise while updating — an update's scopes are constructed, not read from a listing, and claim
nothing about what is no longer there.

**A venue that cannot be walked has these phases too.** `phaseOf` reads whichever kind of run the
venue actually does: `walk` where there is a keyspace to read, `update` where there is not. Reading
only the `walk` rows answered **not run** for okx and bitget for ever, however much they had
established — which is a different state entirely from a venue nobody has surveyed yet, and the two
have to be told apart. Nothing there names a venue; the rows say which kind it is.

**A reset is not a kind of run.** It is the step before one: `refresh: true` drops the venue's run
rows, so the next pass maps the archive again from nothing. Series and files are untouched — what a
venue published is a measurement and stays true; what is discarded is only the record of how far this
service had read.

## Why updating exists

**A full walk costs hours, grows with every venue added, and 99% of it re-finds what it already
found.** The asymmetry is structural: walking costs *history × venues*, and history grows every day
and is never interesting twice, while updating costs only the live edge of each series. One gets
worse for ever and the other converges, which is what makes asking for an update often cheap.

What makes it safe is that **published files rarely change**. Venues do occasionally publish
something invalid, corrupt or incomplete, but it is rare and never urgent.

So the losses an update accepts are all small:

| what it misses | consequence |
|---|---|
| a file changed that we had downloaded | corrected by the next refresh-and-walk |
| a file changed that we had not downloaded | we fetch the new one and tell the catalog; it heals itself |
| a file was deleted | pure bookkeeping. Downloaded or not, there is nothing to be done now |

**One loss is not purely bookkeeping.** A file that arrives *late* is a **new** file *below* the tip,
so no constructed range asks for it and only a walk ever finds it. `month.state` reads `closed` when
nothing is pending among the files the catalog holds, which stays true — but it is a statement about
known files, not a guarantee that the month is whole.

**A new instrument is the loss an update cannot cover on a listing venue** — see
[where new instruments come from](#where-new-instruments-come-from).

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
calendar cannot spell, and `ruleOnSuccess` says what one answer implies about the next key.
Everything else is substitution over rows, so a venue that needs neither adds no code to this path at
all.

**Nothing here discovers.** Generating can only extend series that already exist, so an instrument
listed this morning arrives some other way — see [where new instruments come from](#where-new-instruments-come-from).

### Where new instruments come from

**A pattern has the instrument as a slot; a series is one instrument's occupancy of it.** So a venue
listing a new symbol needs new **series** rows — one against each pattern of its market — and no new
pattern at all. A new *pattern* means something else entirely: the venue changed the shape of a URL.

Those series arrive two ways, and which one a venue uses follows from whether it can be listed:

**A venue with no listing reconciles, on every pass.** It has to — nothing else could ever tell okx
or bitget that an instrument exists, since probing can only ask about series already known. So
before its context is built it fetches the venue's active instruments, inserts what is new as
`active` with no bounds, flips departed ones to `delisted`, and probes for the bounds that are still
missing. See [a series has a life](#a-series-has-a-life-and-the-preamble-is-what-moves-it-along).

**A venue with a listing discovers by walking, and only by walking.** It has no reconciliation step,
so once its walk is behind it, a symbol listed since is not found until the next full refresh.

**That is a decision, not an omission.** Giving the listing venues a reconciliation step would mean
inventing series from an instrument listing rather than reading them out of the archive — which is
exactly where it can be wrong: guessing the archive's spelling of a symbol where it differs from the
venue's own, or attaching a new instrument to a pattern the venue has since retired. A walk cannot
make either mistake, because it reads what is actually served. Since a refresh corrects both for
free, the trade is a new instrument arriving late against a class of quietly wrong rows, and late is
much cheaper.

So a listing venue's eventual consistency comes from being re-walked periodically — a full refresh
every month or so — rather than from a discovery path of its own. What that costs is stated in
[why updating exists](#why-updating-exists); what it buys is that no series of a listing venue is
ever invented.

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
agree or be wrong, and being wrong is silent — it once filed one instrument under another. So the
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
substituting a date and a symbol into the pattern the series carries. The date is the one thing still read from the path, by `dateOf`,
which stays the single authority on it — a second source for the same fact is a second thing that can
disagree.

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
with nothing naming any of them.

**Asking the tree, not the symbols.** A listing describes a whole subtree at once, so the archive is
mapped in a handful of requests and read in `total keys ÷ 1000` pages. Asking per symbol instead
costs `symbols × periods` requests — a single symbol's klines alone are ~17, one delimiter listing
plus a paged walk of each interval directory — for the same answer.

**Splitting stops when there is work for every lane**, and for no other reason. Every venue nests
differently, so a rule that knows what a level *means* breaks on the next venue — and one that
infers size from shape breaks on the venue after that. So the mapping expands one prefix at a time
until it holds `CONCURRENCY` partitions, and treats a prefix as terminal when either of two things
is true:

| condition | why |
|---|---|
| **catalogable** files sit directly under it | replacing it with its children would silently drop them |
| it has no children | nothing to split |

**It only has to be roughly right.** A partition that turns out to carry a disproportionate share of
the archive is split again while the survey runs — see *[Partitions split themselves](#partitions-split-themselves)*
— so a poor first guess costs a few listings rather than the whole pass.

That is what let the old rules go. Descent used to stop at a prefix with more than `FANOUT` children,
on the theory that a wide directory is the symbol level and symbol levels are small. Binance's
`data/spot/daily/klines/` is wide *and* branching — 3,694 symbols each holding 13 interval
directories — so the guess put **29,150 pages behind one worker** while nineteen idled. Gate's
`spot/orderbooks/` is wide and genuinely terminal, and each of its 62 month directories holds about
153,000 files, so "terminal means small" failed the other way. **Shape was never size**, and no
parameter could have made it one.

**A level is read to `IsTruncated`, not to the first page.** A `delimiter=/` reply is capped like any
other, with child directories and keys sharing the 1000-entry budget, so a level wider than a page
arrives cut off. The answer that loses data is whether files sit here: a dated key sorting past the
cut reads as "no files here", the prefix is replaced by its children, and that key belongs to no
partition at all. S3 states outright whether it held anything back, so it is asked.

Reading *every* page matters twice over, because splitting reuses this reader. A truncated child
list once closed a partition holding nothing — 1,000 of binance's 3,694 symbols read, a cursor
already past all of them, every child skipped as done — and the job then declared the venue
established over keyspace nobody had walked.

**"Catalogable" is load-bearing in the first rule.** It asks whether a key here would become a row —
the same `accepts` and `dateOf` questions the recording step asks — not whether any key exists. A
bucket root serves `index.html` and `favicon.ico`, and treating those as files to protect makes the
entire bucket one terminal scope walked as a single serial chain — one worker at roughly 900 pages
an hour while the other nineteen have nothing to claim. Descending past keys the adapter already
declines loses nothing, because they were never going to be recorded.

It also makes the rule hard to trip by accident, in two layers. A stray `.log`, `.tmp` or `README`
carries no date, so `dateOf` declines it and the prefix stays splittable. And where a venue leaves
something that *does* look like a dated file, one `exclusion` row settles it — which quietly makes
the exclusion table a partitioning lever as well as a cataloguing one.

**A refused directory is not descended into at all** — it is ignored as though it were not there.
Filtering keys at the recording step is enough to keep the catalog correct, but the walk still
happens first: binance's `data2/data/spot/klines/` cost 655 pages and 43 minutes of a worker to
store nothing, while another venue sat at half its concurrency.

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

- **A prefix holding a catalogable file of its own is never split.** A parent covers every key
  beneath it; its children cover only their subtrees, so a key sitting directly there would belong
  to none of them.
- **A split that would produce no children leaves the run open.** Every child sorting behind the
  cursor means the prefix is genuinely finished — but so does a child list that came back short, and
  the two are indistinguishable from here. Leaving it open costs one more pass; closing it wrongly
  loses the keyspace in silence. That is not hypothetical: a truncated list once closed binance's
  spot klines holding nothing, and the job then declared the venue established over 3,600 symbol
  directories nobody had walked.

**It terminates** because every path shrinks the problem: a split replaces a prefix with strictly
longer ones over a finite tree, and a prefix that cannot be split is remembered so it is never
examined twice. When everything running is terminal, refinement is over and idle workers become a
fact to accept rather than a condition to retry.

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
every walk, and a silent sighting of a catalogued file moves `last_seen` and nothing else), a
withdrawal reaches `wip` too, and arriving is first discovery rather than a revision.

**Rows carry who named them.** A listing cannot name a key that is not there, so a walk's findings
land as `existence = 'confirmed'`; keys an update built from a pattern and a date land as
`'assumed'`, because nothing has seen them. That is a property of the candidate rather than of the
pass that parked it, which is what lets an update drain a walk's leftover backlog without treating
its keys as guesses — a distinction the pass kind alone gets wrong after a restart.

## What is excluded, and why

**Everything a venue publishes is catalogued except what is listed here.** Nothing is skipped for
being hard to parse: a path that survives these rules and cannot be parsed is written to
**`unreadable`** rather than passed over, because a file nobody parses is a series nobody tracks.

Each rule below was established from the venue's own files, and the venue docs carry the evidence.
**Before removing one, read the linked section** — and before adding one, pick the tier by what the
rule *is*, not by what is convenient:

| tier | for | lives in | changing it costs |
|---|---|---|---|
| `excludedAnywhere` | files no venue should ever catalogue | `src/paths.ts` | a deploy |
| an adapter's `accepts` | one venue's shapes, trees and prefixes — a **rule**, holding for keys nobody has published yet | that adapter | a deploy |
| the `exclusion` table | **specific** known-bad files, by exact path, where there is no shape to describe | a row, plus a migration | nothing; the row applies on the next job |

`accepts` is asked about **prefixes as well as keys**, so a refused directory is never descended
into — that is where the saving is, and why a rule that can be described belongs there rather than
as five hundred rows. The `exclusion` table is the opposite case: a handful of files a venue serves
wrongly, which no expression predicts. A row added by hand applies at once; the same row ships as a
migration so a rebuilt catalog still has it.

### Excluded at every venue

Three suffixes, in `excludedAnywhere`. None of them is one venue's quirk:

| suffix | what it is |
|---|---|
| `.CHECKSUM` | a checksum beside an archive — half of every page [binance](../venues/BINANCE.md) and KuCoin serve |
| `index.html` | a directory listing page; [bybit](../venues/BYBIT.md) writes one into every folder it has |
| a trailing `/` | a directory marker — S3 lists a zero-byte key for a folder created rather than implied, so `data3/` arrives beside the keys beneath it |
| `.csv` | an **uncompressed** stray. Archival data is published compressed, and none of the 6.37 M files ever collected is a bare CSV. Gate's are the case that settles it: a `.csv` covering **one day of a month**, for pairs its own download form does not offer, sitting in a directory whose real series is monthly |

### Refused by a venue's `accepts`

| venue | refused | why |
|---|---|---|
| binance | `data2/` | staging, not archive — [BINANCE.md](../venues/BINANCE.md#prefixes-outside-data--one-of-them-holds-data-that-exists-nowhere-else) |
| binance | a bare key directly under `data3/` | only that tree's subdirectories hold data, and `data3/liquidationSnapshot/` is real and unique |
| bybit | `backup/` | a copy of one symbol's `trading/` files, served correctly under `trading/` too — [BYBIT.md](../venues/BYBIT.md) |
| bybit | any key with no `/` | the bucket root, which serves the browsing UI |
| bybit | `trading/(BTC\|ETH)USD[UZ]21/` | the four 2021 expiries: abandoned rather than archived, absent from bybit's own download form, and two of them hold a single day — [BYBIT.md](../venues/BYBIT.md#the-2021-expiries-are-abandoned-and-are-refused) |
| htx | `assets/`, `test/` | the browsing UI's own files, and a scratch directory — [HTX.md](../venues/HTX.md) |
| htx | `remark.txt` at the root of each `data/` dataset and market | thirteen of them, the field descriptions the newer tree shows in a dialog instead. Documentation, and dateless, so nothing would place it in a series |
| htx | any `data/` key dated `2026-02-01` or later | **the whole overlap between its two trees.** Both published the same instrument-day for six months under different schemas; the offered tree is taken from the day it opens and the old one below it, so each unit is catalogued once — [HTX.md](../venues/HTX.md#where-to-stop-reading-data) |
| kucoin | `futures/daily/klines/<SYMBOL>/1d/` | **published broken**: the header declares six fields and every row writes five, so the bar has no volume. A fresh fetch matches KuCoin's own MD5, so it is theirs, and it is the interval rather than the venue — every other interval is six and six. Nothing is lost: a day is an aggregate, and the 1m series is complete over the same range |
| gate | any tree but `spot`, `futures_usdt`, `futures_btc`, `tradfi`, `delivery_usdt`, `spot_index`, `options_ticker` | dead, or not gate's — see below |
| gate | a bare month where a dataset name belongs, in the three trees that have a dataset level | 571 keys, each the size of its canonical twin **to the byte** with a different ETag and an earlier mtime: the same content under an abandoned layout, re-uploaded correctly hours later — [GATE.md](../venues/GATE.md#571-keys-are-filed-one-level-too-high) |
| gate | an `s3deals/` directory inside a dataset month | spot deals misfiled inside another dataset's tree |

Gate's refused trees, each of which is a decision rather than an oversight —
[GATE.md](../venues/GATE.md#what-is-in-the-bucket-and-what-is-dead) has the spans and the evidence:

- **`hk/`, `malta/`** — separate Gate entities with their **own order books**, so their `BTC_USDT`
  is not gate.com's. If either is ever wanted it is a venue row of its own, never a prefix of this
  one, or two unrelated books merge under one symbol with nothing said.
- **`v2/`** — two months, 202211–202212, then abandoned.
- **`future_usdt/`** — the misspelling of the live `futures_usdt/`: 16 files, three symbols, all
  written on one afternoon in 2022-11 and never touched again.
- **`futures_usd/`** — five months to 202212.
- **`gatepay/`** — two spreadsheet templates.

### Named in the `exclusion` table

| venue | files | why |
|---|---|---|
| gate | 85 × `futures_usdt/trades/202107/<SYMBOL>-202107.csv.gz` | **spot data served at the futures URL** for that one month. Gate publishes those bytes — five columns where futures has four, and a re-fetch returns the same md5 — so read as futures the file "works" and every trade appears to be a buy. [GATE.md](../venues/GATE.md#2021-07-spot-data-served-at-the-futures-url) |
| gate | `futures_usdt/candlesticks_10s/202107/123`, `futures_btc/mark_prices/202107/hello/123` | zero bytes, uploaded four minutes apart on 2021-08-11 |

Both ship as migrations, so a catalog rebuilt from scratch has them. **A walk of that month
re-fetches the 85 unless something refuses them**, which is why they cannot live only in collection
bookkeeping — that is disposable by design.

### Not an exclusion: the venue root

`root` is where a walk **starts**, not a filter. binance has none, so `data/` is simply part of every
catalog path; kucoin's is `data/`, okx's `cdn/`, bybit's second host `orderbook/`, and the catalog
stores paths relative to it. Everything beneath is walked.

## Jobs: resuming and refreshing

One pass over a venue is a **job**, and it is the only unit here. A job is a row at the empty scope
plus one row per partition, written together:

```sql
run(venue_id, kind, scope, cursor, requests, found, started, completed)
```

`kind` is `walk` for a listing pass, `update` for a generated one and `probe` for a settling sweep,
and they are kept in separate rows so that neither can be mistaken for the other — an update's scopes
say nothing about the keyspace a walk covers, and `establishedAt` asks only about walks.

**A first pass is not a special case.** It is a job with no predecessor, which is all "a backfill was
never subject to a cadence" ever meant. Same rows, same walk, same code. The only decision anywhere
is whether to build a new set of partitions or continue the open one:

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

A consequence worth stating: **a resumed job does not re-map the archive**, so a directory that
appeared after the job began waits for the next job. That costs nothing. The guarantee was only ever
*present when the job started and still there when it finished*, and something that appeared midway
was never inside it.

Every row in a job shares one `started`, so a partition walked hours later still claims the archive
as it was when the job began — the conservative direction, and the one the cascade wants. A job
begun on Monday and finished on Friday is a Monday snapshot; dating it Friday would claim four days
it never looked at.

### A job closes only when every partition did

A partition that cannot be walked keeps its row and its cursor, and the job **stays open**. That is
not bookkeeping fussiness: the job sits at the empty scope, which is every prefix's first ancestor,
so closing it around a failure would answer "established" for the whole venue — including the
prefix nobody has read.

Leaving it open instead means the next turn of the loop finds a job to resume and retries exactly
the partitions that failed, half a minute later, **for as long as the service runs**. Nothing counts
attempts and nothing gives up.

That is safe because there is no per-partition failure that stays failed. A prefix that no longer
exists answers `200` with an empty listing — a successful walk of an empty scope, not an error. A
given page is a fixed URL, so it cannot deterministically fail while its neighbours succeed. What is
left is transient (a 5xx, a 429, a reaped connection), venue-wide (a bucket whose policy changed,
which fails descent first), or local — and every one of those is cured by asking again later.

The retry is also cheap, because a resume does not re-map: one listing request per remaining
partition. So the cost of being wrong about all this is a warning every thirty seconds naming the
partition, while its siblings finish and go quiet — loud enough to find without any bookkeeping to
support it.

### An update's rows are its progress, and reconciliation deletes them

A walk's job closes when its last partition does: the keyspace has been read, the bounds are on disk,
and that closed job is what `phaseOf` and `establishedAt` read.

**An update's does not, and that difference is the whole of resuming one.** Every partition finishing
means *generation* is done — the keys are in `wip` and mostly unasked, and probing them is where the
hours go. Measured on htx: generation finished at 19:17 with **185,280 keys still queued**. Closing
the record at that moment is what made a restart during the drain find nothing open and plan the pass
again, discarding a per-series completion record for all 39,295 series it had already finished.

So the shape is:

| | |
|---|---|
| **a row per series, written when the pass is planned** | closed as that series' keys are written |
| **rows existing at all** | the last pass did not reach reconciliation |
| **`wip`** | the whole of probing's progress; nothing else records it |
| **reconciliation's last act** | delete the per-series rows, close the job row |

Resuming therefore means: no preamble, no re-planning, no series generated twice, and every series
the interrupted pass had not reached still generated. Once per series — not zero, not twice. Probing
needs no equivalent because a key is on the list until it is answered, so a restart picks up exactly
what is left, `tries` intact.

**A resume is a resume, whatever its age.** Nothing decides that an interrupted pass has been sitting
too long. An open job with nothing working it is what a killed container leaves and what a pause
leaves, and both continue from their cursors — stopped at 3am and restarted a fortnight later resumes
exactly as one restarted at 8pm does. Judging a paused walk stale is a person's call, and `refresh`
is how they make it. Code guessing at it means a venue quietly restarting a multi-day walk because a
deployment sat idle over a weekend: the expensive outcome, chosen by nobody. Scopes planned against
tips that have moved since cost one pass of a narrower range, and the next pass widens it; discarding
the pass costs everything it had already read.

**`run` is a progress table, not a log.** A finished htx pass leaves **one row, not 39,296**: the job
row, closed, carrying the pass's start, end and totals. It cannot be mistaken for outstanding work,
because progress is read from the partitions. If a history of passes is ever wanted it is an
append-only file, not rows in the table that decides what to do next.

### Refreshing

A refresh is a **full re-walk** of every partition. It has to be: new keys are appended within each
symbol group rather than globally, so a new month for `AAVEUSDT` lands at `A…`, behind any cursor
already past it. No marker finds it.

### Nothing starts unasked, and nothing stops on its own either

A survey begins when something asks for one, over the API. From then on that venue **keeps itself
current** — across any number of restarts — until it is paused or refreshed:

```
[ walk ] → sleep → update → sleep → update → …
```

**A venue is never finished, only current.** The archives grow every day, so reaching the end of one
is not a state to stop in — it is the point at which the cheap half becomes possible. The first pass
is a walk where there is a keyspace to read and an update where there is not; every pass after it is
an update, because by then the walk is complete by definition. Nothing chooses: `phaseOf` reads where
the venue has got to and the pass works out what that means today.

**A day, and measured from the start of a pass.** Every venue here publishes at most one file per
series per day, so asking more often is asking the same question twice. Measuring from the start
rather than the end is what stops a venue whose walk runs longer than a day drifting a day later on
every turn: a pass that took thirty hours goes straight round again.

**The start is read from the pass's own run row, never from a clock**, because a pass this process
*resumed* began before this process did. Timed from the moment it was picked up, a restart changed the
venue's cadence — the one thing this rule exists to prevent. Gate's walk began 2026-08-30 09:44 and
ran 26.6 hours, so its next update fell due two hours *before* the walk finished; timed from the
resumption it would have slept another 22. A walk and an update alike leave their `scope = ''` row
behind, closed, which is what reconciliation deliberately keeps — and it is the same field `dueFor`
reads when a venue is picked up on startup, so the two paths cannot disagree.

**Two different questions, and only one of them is ours.** *Whether* a venue should be surveyed at
all depends on what somebody is waiting for and what the disk can take, neither of which is visible
from in here — so it is asked for over the API. *How often a venue already being surveyed needs
re-reading* is not that question: the archives move once a day, so the answer is a day, and it is not
worth asking anybody.

The endpoints are in [CATALOG-API.md](../modules/CATALOG-API.md).

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
passes waits out the remainder of its interval, and a paused one stays paused. A venue nobody
enrolled is untouched for ever, which makes **read-only a real state** rather than a convention: an
instance that serves the catalog and collects nothing is one where nobody started a survey.

**Resumption is per host, because the passes are.** Bybit's two servers keep separate run rows and
separate cursors, and one being mid-walk says nothing about the other — so each is picked up from its
own state, and a venue with one host walking and one waiting is exactly that. Only the *reporting* in
`GET /status` collapses the pair into one word for the venue.

**The interval runs from the start of a pass, not its end**, here as everywhere else — so a restart
cannot change a venue's cadence. A venue updated an hour before its container was replaced is not
owed another update, and starting one would make a deployment's schedule a function of how often it
is restarted. Completing a walk is the end of an update, not a prelude to a special first one: the
walk *is* the pass, and the next is due an interval after the walk began, which for a walk that ran
longer than the interval means immediately.

**One verb, because where a venue has got to is not a caller's decision.** `POST /surveys` is the
whole of it. A venue with nothing starts, one with work outstanding continues from its cursors, one
that has been complete finds what has appeared since — all read off the run rows, none of it a
decision a caller should have to make. Venues are unrelated hosts already surveyed concurrently, so
naming none of them, and meaning all, is the ordinary request. A named venue is checked against the
adapter registry rather than the catalog's `venue` table: that table ships with the venues migration,
but validating a *survey* against catalog state is the habit that made a first pass impossible.

**The request places the order and answers; it does not carry it out.** A survey claims its venue
synchronously — that claim is what stops a second request starting the same one twice — and then
hands the passes themselves to the next turn of the loop. Without that the caller paid for the whole
synchronous prologue of every venue named: the series registry loaded, a phase read and a probe
opened, all before the reply it had already decided could be written, and the venues' first log
lines arriving in the same burst as the response because nothing could flush until the loop came
back. What a caller is owed is the order and the state each venue was in, both of which are known
immediately.

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
therefore *is* resuming it.

**The probe stops on the same flag, and reads it where it has a boundary of its own.** Its unit is
the batch, not the pass: a pass ends when the backlog empties, which on a venue whose keys are
constructed is a week's work, so a flag read once per pass is one that lands long after anybody cares.
It is therefore read each time a batch of `wip` rows is loaded — after the previous batch has settled
what it settled, recorded its attempts and moved the cursor, and before the next is asked for. What
that costs is the seconds one batch takes; what it buys is that nothing is cancelled mid-flight and no
row is asked twice. The pass says `stopped` rather than leaving the drain to infer it from counts,
which is the same reason it says `abandoned` — the two end in the same place and mean opposite things
about whether the venue should start itself again.

**The pause is written down before the loop is touched**, because it has to outlive the process. Held
only in memory it was forgotten by the next start, and a deployment that resumes what it finds open
would then have restarted a venue somebody had deliberately halted. Two separate things: the row in
`survey` is what keeps a venue stopped, and an in-memory set is how a *running* loop is told to stop
now — deliberately forgotten on a restart, since there is no loop left to stop. `GET /status` reports
the second as `stopping`, the moment between asking and the loop noticing.

**Only a person's decision writes the row.** A refresh and a forced update both have to stop a running
loop before they can do their own work, and neither is anybody deciding the venue should be stopped —
so both take the in-memory half alone (`halt`), never `pause`. Routed through the persisted pause,
a forced update wrote `paused_at` and cleared it a moment later, and a status polled in between
reported the venue as **paused**: the one word meaning a person stopped it, shown for work a person
had just asked for. `stopping` is what is true during that gap, and it is what is now shown.

**A walk ends when the job closes, not when a pass returns.** A partition that could not be read
keeps its cursor and leaves the job open, so the next turn retries exactly that partition at one
listing request rather than re-mapping anything.

**Unprobed files are outstanding work, and belong to no job.** A probe's subjects are rows rather
than keyspace, so they outlive the walk that discovered them: bybit's books carry no metadata in
their index, and a completed walk leaves hundreds of thousands of names still owed. That is why a
venue counts as busy until its probe drains, and why `GET /status` reports `wip` beside the job.

**A restart loses nothing, and starts only what was already going.** An interrupted job stays open
with its cursors and is picked up where it stopped. Whether anything is *currently* walking a venue
is still a different question from whether work is outstanding, and `GET /status` answers both —
`state` for where the venue stands, `surveying` for whether this process has a loop alive. Open and
not surveying is what a killed container leaves behind between one start and the next, and the one
state worth acting on.

### Settling metadata a listing could not carry

A walk establishes **what is there**; a probe establishes **what it is**. On a listing venue the two
arrive together, because a listing states size and checksum. On an index venue it states neither, so
the catalog holds paths and dates until something asks — and "how much disk does this cost, and how
long will it last" is unanswerable from paths alone.

So a venue whose adapter says `probes` gets a **second loop** beside its walk, settling files a HEAD
at a time. Neither waits on the other while there is work: a file found in the first minute should
not sit unestablished until the last partition closes, so during a backfill the probe runs for hours
behind the walk.

**A probe is the second half of a walk, and ends with it.** While indexing is under way an empty
backlog means *not yet*, so the loop waits and asks again. Once the walk's job closes nothing more is
coming, and the probe is draining: it keeps taking rounds until the backlog is empty and then
announces the venue synced — the same *Survey complete* a walk-only venue announces when its job
closes. A pass that finishes generating while a probe still owes therefore says **indexed**, not
complete: half a million names nobody has established are not a surveyed venue.

**Whether a pass owes a probe is a property of the pass, not of the adapter.** An update always
probes, whatever the venue is, because it generates keys rather than reading them — so a listing
venue that never probes while walking starts probing the moment it stops. Read off `adapter.probes`
alone, the announcement was wrong for every update on a listing venue: binance said *Survey complete*
with 8,312 rows still in `wip` and went on probing for twenty-seven minutes. The pass itself was
never affected — reconciliation waits on the drain — but the sentence about it was, so both now read
the same expression.

Two things end a drain, and only one of them is finishing. A round that settles or retires nothing
while rows remain will not do better on the next one — what is left is rows the venue will not settle
and the adapter will not retire — so it stops and says how many, rather than asking for ever and
never reporting. A refusal or a fault is neither: the rows are still owed and the venue is simply not
answering, so those wait and try again.

**A round follows the one before it as soon as there is work.** Only an empty backlog on a venue
still indexing waits at all, and then for thirty seconds — long enough not to spin, short enough that
a walk running hours ahead of the probe is never what is holding the probe up. The attempts that are
supposed to be spread over time are spread by the *update* schedule, a pass a day, not by pausing
inside one pass.

Until the probe stops, the venue counts as running: `POST /surveys` skips it rather than
starting a second loop against the same host.

**The work list is a query, so there is no state to keep.** A pass asks for the files that still have
no checksum and settles them; a row leaves that list by being settled, so the query *is* the cursor
and a restart resumes by asking again. Nothing is written down because nothing needs to be.

**In the order the rows were parked, which is `wip.id`.** Whoever produced the work chose the order —
a walk offers a venue's keys in the venue's order, generation emits a series ascending by date — and
the probe imposes nothing of its own on top.

Ordering by *date* was the obvious thing and it was wrong, because the two halves of a pass run at the
same time. Generation is still parking keys while the sweep reads them, so a row written for a date
the cursor has already passed is invisible until the next round however old it is; a sweep that had
reached 2023 had **not** asked about everything below 2023. That is not a lost row but it is an
unbounded delay, and it made the one thing the backlog is supposed to say — everything before here has
been asked — true only of a pass that ran to exhaustion. An id only ever grows, so a key parked
mid-sweep always lands ahead of the cursor and is asked in the pass that produced it.

Which is why the column is `AUTOINCREMENT` and not a plain rowid. This table's *highest* rows are
the ones deleted, constantly, as they settle; with `max(rowid) + 1` the counter would run backwards
after every drain and reintroduce exactly the hole it was there to close.

The consequence worth knowing: generation walks its series sequentially, so probing now completes one
series at a time rather than advancing every series' date together. A pass cut short has answered
whole series rather than a slice of all of them.

The cursor is a **value**, one integer, rather than an open statement. SQLite will let a query step
while the same connection rewrites the rows it is walking, and what happens then depends on which
index the planner chose: rows visited twice, or skipped, with nothing said. A keyset cannot be wrong
that way, and it moves past rows that did *not* settle, so one stubborn file cannot hold the rest of
an archive behind it. A pass ends when the query comes back empty; the next starts from the
beginning, which is what picks up files a walk has found since.

**A 404 takes the key off the list without recording anything about it.** The venue has answered, so
there is nothing more to ask this pass — but "not there now" is not a claim about what was ever
published, so no row is written as absent and the next update asks again. Once somebody *does* rule a
file absent, the query stops offering it.

**A first settling is not a revision.** Learning a size for the first time is not the file changing,
so the trail is appended to only when something known differs — otherwise every probed file would land
in `revision` on its first sighting and "what changed since I last looked" would answer "everything,
once".

### Asking what is established

`establishedAt(prefix)` answers from the completed runs covering it — the prefix itself or any
ancestor, since a walk of `spot/` settles everything beneath it. Where several qualify the answer is
the **latest**: each is a true statement about the prefix, so the strongest one wins. Taking the
shortest instead would let a venue-wide pass from last month shadow a walk of that very prefix from
an hour ago.

## Pacing: one gate per host

**A venue counts requests from an address, so the limit is counted per address and nowhere else.**
The walk, the archive mapping and the probe are three callers of one host, and a limiter belonging to
any one of them caps a fraction of the traffic while the host meters all of it. So there is exactly
one `Pace` per hostname, held for the life of the process, and every request passes it.

**Keyed on the hostname rather than on the venue**, because our names for venues are not what the
other end counts. Binance and gate publish to the same bucket service —
`s3-ap-northeast-1.amazonaws.com` — so a limiter per venue handed each a full budget against one
machine, which then saw the sum of two gates that each believed they were alone and answered with
refusals and connect timeouts.

The rule reads correctly in both directions once it follows the address. One venue on two hosts gets
two budgets, because they are two machines — bybit's books have always needed that. And a venue that
lists from one address while serving files from another, as binance and okx both do, is paced
separately on each, which is what those hosts would each want.

**The gate is inside the fetch.** `send` in `http.ts` is the single function every request goes
through, which makes it the only place a limit can be complete. Putting it there also brings the
retry ladder inside the count: a call that retries five times is five requests the venue sees, and a
gate wrapped around the call instead of inside it would let those go out at five times the cap — at
exactly the moment a venue is already unhappy.

**The rate is the part that matters.** A venue budgets requests per second; concurrency sets a rate
only by accident, multiplied by whatever latency happens to be that day. So the rate is capped
directly, and the pool widths above merely bound how many requests may be queued behind it.

The counter is a **sliding second**: the times requests went out, with anything older dropped. A
request goes when fewer than `perSecond` of them fall inside the last second, and otherwise waits
exactly as long as it takes the oldest to fall out. The check and the claim happen in the same tick,
so two lanes cannot both see one free slot and both take it.

**A refusal aimed at us stops the venue; a refusal aimed at a key does not.** S3 declines one object
and says so — an `x-amz-error-code`, and `AmazonS3` as the server. A CDN turning us away serves its
own error page naming no key. The second means the address is blocked, and such a ban lapses only
while nothing is asking, so slowing down is not a remedy. `send` latches the venue's gate the moment
it sees one, which stops every caller at once, including the ones already waiting for a slot —
nobody has to be told, and nobody gets to keep asking. It is also not retried: the ladder would spend
four more requests confirming what the first established. Anything refusing without naming a key is
read as a block, because that is the direction where being wrong is cheap — a stood-down venue costs
minutes, a banned address costs the venue.

The first stand-down is the venue's `standDownMs` and each repeat doubles it up to `ceilingMs`, one
pause per round rather than one per refusal: every lane in flight fails at roughly the same instant,
so counting each of them would reach the ceiling in milliseconds before the venue had any chance to
answer differently.

**The rate at the moment of a block is logged, because nothing else measures it.** No venue publishes
a rate-limit header, so the only evidence about where a limit sits is what was going out when it was
hit — and a per-pass average is the wrong number for that by construction, since it counts every
second spent paused. The gate reports the last second, the last five and ten, the busiest second so
far, what is in flight and the lifetime total, and those go into the block warning and the walk's
refusal line.

**A steady pass is read on different numbers, so the probe heartbeat carries different ones.** Ten
seconds says where the window landed rather than how the survey is going: on a venue that stands
down, it reads as a collapse whenever a pause falls inside the window and as full speed whenever one
does not. A survey running for days is judged over a minute and an hour instead — counted in a ring
of per-second and per-minute buckets, because an hour of timestamps at these rates is millions of
numbers held to answer one log line, and averaged over the time actually elapsed so that a process
two minutes old does not report an hourly rate a thirtieth of the truth.

Retries are reported there as a **share of everything sent**, not a count: five hundred is a healthy
afternoon at a thousand a second and a venue falling over at ten. They are counted where the retry
ladder turns rather than inferred by subtracting answered from sent — those two figures are kept on
different scopes, one per pass and one per host since the process started, so their difference is
mostly in-flight requests rather than retries.

**Cadence layers**: a built-in default of 100 per second, then the venue's adapter, where the
evidence for a real number is written down. The default suits a public bucket that does not meter its
readers, and a server that needs less says so — bybit's primary earned its 30 by refusing us above
it, at a measured 39 to 40 per second. Its books host carries the same 30 for the opposite reason:
nothing there is measured, the tree is small enough that finding the limit would buy nothing, and a
ban is what guessing wrong costs. A server still on the default is one nobody has had a reason to
measure, not one that was measured and found generous.

**The rate is not configurable, deliberately.** What a venue tolerates is a fact about that venue and
does not change because the client moved to a host with more bandwidth, so it belongs beside the
evidence for it rather than in an environment file. What *is* local is how many sockets this machine
will hold open — and that cannot outrun the venue's rate, only fail to reach it.

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
pass, and nothing recreates it. What the catalog ends up holding is what the venue turned out to
serve.

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

Encoding *when a file is expected* would pay twice — nothing asked for before it is due, and silence
that becomes suspicious on a schedule — but it needs a per-venue leniency (bybit publishes monthly
files on the first Monday) and none of it exists yet.

### A derived archive spelling can be wrong, and only a log says so

Where a venue's keys spell an instrument differently from its listing, `urlSymbolFor` answers with
the archive's spelling — derived by rule, or asked of the venue. A spelling that comes out wrong is
not an error anything can catch: the keys it builds are well-formed and the venue answers that they
are not there, which is what a quiet instrument looks like too.

The symptom is a **series that never finds a start** — listed as active, generated for every pass,
and never answered. One of those is ordinarily an instrument that launched days ago and has
published nothing yet, and it resolves itself; a cohort of them that never resolves is a spelling
nobody serves. It surfaces as a count in a log line and nothing else reads it.

### Four venues' rates have never been measured

`perSecond` and `concurrency` bound requests per host. Where a figure came from a measurement it says
so in the adapter; these did not:

| | |
|---|---|
| binance, gate | 30/s with 15 in flight — inherited, never measured. If timeouts appear, `concurrency` is the number to move |
| htx | no pacing declared; it takes the default. Now addressed at its S3 bucket rather than the Akamai edge that fronted it, which was refusing and blackholing long before the bucket would — see `docs/venues/HTX.md` |
| kucoin | 20 in flight, lowered from the default on timeouts; the rate is left at the default, since nothing observed says it is too high |
| okx | measured at 100/s, but timeouts seen during a long run were never explained |

Bitget's figure *is* measured, and recently: 29,000 `HEAD`s to 258/s with no refusal on either the
found or the absent path. What looked like rate limiting there was the probe miscounting absence —
see `probe.ts`.

### `OVERDUE_DAYS` is a decision, not a measurement

Nothing established 15 days. It is where we decided to stop believing a file is merely late.

The longest wait any venue here documents is gate's — a month's files on the first Monday of the
next — and the lags actually measured are hours for dailies and days for monthlies. Fifteen is twice
the worst promise and still short enough that ordinary lateness is never read as absence.

**It fails cheaply in the direction it fails.** A file arriving on the sixteenth day is found by the
next full refresh, which re-reads the keyspace and owes nothing to any tip. Waiting longer instead
costs a probe per gap per pass, on every series that has one, for as long as the wait lasts.

The evidence to replace it accumulates on its own — a `file` row records when the catalog first saw
a file and its key records the period it covers, and the difference is that venue's publishing lag,
measured. With a few months of it the constant becomes a per-venue, per-dataset distribution.

### A hole older than the window is walked past, not filled

Reconciliation lifts every tip to the floor, and does so **without knowing what it is stepping
over**: a real hole in the archive, a miss that would have settled on the next pass, and the dead
range below a newly listed instrument's true start are indistinguishable from here, so all three are
treated the same way. Anything unanswered below the floor is therefore never asked about again.

That is the deliberate half of `OVERDUE_DAYS` — the price of not re-probing every gap for ever. What
recovers it is a full re-walk, which reads the keyspace and owes nothing to any tip. A venue that
cannot be walked has no second chance, which is what makes a lifted tip the one bound worth being
careful with: too low costs requests, too high loses files silently.

### A series that never publishes is never closed

`last` is NULL for a series no file has ever been seen for, and `open` reads that as **open**: there
is no measurement to call it finished on. It stays in generation, asking for the window between its
tip and today on every pass.

Cheap at the scale of a real run, and the alternative is worse: closing on absence alone would put
the judgement exactly where the evidence is weakest — an instrument a venue lists but has not
published for yet is indistinguishable from one that never will. Every newly listed instrument is in
this state between its series being created and the archive's first file.

The one case that *is* decided without a file is a series with **no files at all**, which
reconciliation deletes rather than records — see *[an empty series is deleted, not
flagged](#an-empty-series-is-deleted-not-flagged)*.

## Configuration

Everything is fixed inside the container; the host directory behind it is the compose mount's
business.

| variable | default | |
|---|---|---|
| `PROSPECTOR_VENUES` | all | comma-separated subset: `binance,bybit,htx,kucoin` |
| `PROSPECTOR_CONCURRENCY` | `200` | requests in flight at once **across every venue** |
| `CATALOG_TOKEN` | — | the shared secret every API request carries. **Empty turns the check off**, which is what makes the read endpoints reachable from a browser — a convenience for a machine nobody else can reach, warned about at startup |

`CATALOG_DIR` on the host is mounted at `/data/catalog`. There is no environment variable to move
it inside the container.

### On pace and parallelism

**A partition is a serial chain.** Each page's marker is the previous page's last key, so no amount
of concurrency makes one partition faster. Partitions are therefore the only unit of parallelism,
and they cut the keyspace exactly — disjoint, and together covering everything under the root.

**Cadence and concurrency are different things, and only one of them is a limit.**

`perSecond` is the cadence — the figure a venue would object to. It lives in the adapter beside the
evidence for it, and nothing in the environment can raise it. Bybit's 30 was earned by being turned
away.

`concurrency` is not a limit at all. It is how many requests may be in flight so that the cadence
can actually be reached: at one at a time, 100/s is unreachable whatever the gate allows, because a
request spends most of its life waiting. It cannot breach the cadence either, since every request
passes that gate regardless — which is why `CONCURRENCY` is a ceiling rather than a target, and a
venue yielding fewer partitions simply uses fewer workers.

**A limit opens gradually rather than all at once.** `concurrency` is for keeping the pipe full
while answers are outstanding, not for arriving in a single instant: a host that serves 100/s
sustained can still refuse to be met with 100 sockets in the same millisecond, and htx did exactly
that — a hundred connections from a standing start, none answered, every one dying on its own
deadline having never been replied to. So a fresh limiter allows a tenth of its figure in the first
second and a further tenth each second after, reaching the full number at nine. Below a handful of
connections there is no burst to guard against and the limit opens whole.

The ramp starts again when a stand-down lifts, which is the moment it matters most: every lane held
by a pause wakes within an instant of the same moment, and the venue that just refused us is the
last one to meet with everything at once. While the limit is still opening, a waiting lane is woken
by the clock rather than by a departure — a rising limit moves on its own, and a lane parked on the
queue would otherwise sleep through every step until something happened to finish.

**Probing is not paced separately, and no longer can be.** A probe and a listing are the same thing
to a host — one request, one socket, one ticket — and both pass the same gate, which is why the
count a venue sees has always included them. The concern a separate probe figure used to serve, that
this link is shared and something else may need it, is exactly what the machine-wide pool answers
now, for every caller at once.

**How many workers a venue gets follows from the same figure.** A worker holds one request at a
time, so more of them than the venue's own `concurrency` is not parallelism but queueing, with a
partition held open behind each one. The count is therefore the adapter's number, capped by the
machine's — and it is also what the archive is split for, so a venue is partitioned for the workers
it will actually have rather than for a figure someone typed.

**Imbalance sets the wall clock, not the total.** If one partition holds most of the keys, its chain
decides when the survey ends however quickly the others finish, and more workers do not help because
the work is not divisible. That is no longer something to tune around: a partition carrying too much
is split while the survey runs — see *[Partitions split themselves](#partitions-split-themselves)*.

The limit on concurrency is therefore our own resources rather than the venue's: S3 documents 5,500
GET/HEAD per second per prefix, which nothing here approaches.

**But our own resources are shared, and no adapter can see that.** Every venue's figure can be
individually right while their sum is wrong. The eight servers surveyed today permit **430** requests
in flight between them — 100 for htx on the default, 20 for kucoin, 150 for bitget, 100 for okx, 20
and 10 for bybit's two, 15 each for binance and gate — and not one of those figures is unreasonable
on its own. What came back was connect timeouts, on venues that had done nothing unusual, at the
moment the others were busiest. A limit that lives in an adapter cannot catch this, because the
number that is wrong is one no adapter knows.

`PROSPECTOR_CONCURRENCY` is that number. It is a **pool of tickets**, not an allocation: a
request takes one before going out and returns it when it is answered, and the pool neither knows
nor cares which venue is asking. There is nothing to divide up and nothing to recompute when a
venue starts or finishes.

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

None of that is a reason to trade correctness or politeness for speed. Listings are retried on 5xx
and 429 with full-jitter exponential backoff, `Retry-After` is obeyed exactly where a venue sends
one, and a 403 or 404 is an answer rather than a hiccup, so it is not retried.

### The network gate is tuned for this service, not taken as it comes

`@devvir/netgate` watches the network on its own and holds every request while it is unusable, so
that an outage is established once instead of being rediscovered by each of hundreds of lanes
through its own retry budget. Its defaults assume a probe answers quickly because the caller's own
requests do.

**That assumption does not hold here, and taking the defaults made the gate measure this service
rather than the network.** A venue is walked on hundreds of lanes at once; at a thousand in flight,
throughput settles near 300 a second, which is a mean above three seconds per request — for the
requests that *succeed*. Against the library's three-second deadline the gate was timing out its own
probes and reporting a link that was carrying video and browsing without a stutter. It is the same
effect described above, where individually reasonable per-venue limits summed to connect timeouts on
venues that had done nothing unusual: the number that is wrong is one no component can see alone.

So the deadline is set past what this service's own traffic costs, and the evidence widened to
match — a probe here has to answer whether the network is *unusable*, and slower than a browser is
not that:

| setting | here | library default |
|---|---|---|
| `timeoutMs` | `10000` | `3000` |
| `window` | `12` | `6` |
| `degradeAt` | `3` | `2` |
| `closeAt` | `6` | `4` |

Two failures in thirty seconds is a blip; three in a minute is a pattern. The higher deadline costs
nothing in detection speed because the probes are asked together rather than in turn — a sample is
one round trip however long the list is.

## The API

Prospector is the only process that opens the catalog, so everything anyone else needs from it
arrives over HTTP — including from another machine, which is the point: surveying belongs where the
link is good, and that need not be where the downloading happens.

**Authenticated with a shared secret** in `x-catalog-token`. Not users or sessions — one string,
checked on the way in, because a port meant to be reachable from elsewhere should not answer a
stranger. **An empty `CATALOG_TOKEN` takes the door off entirely** and every request is let through:
there is no header to set, so a browser can read the catalog directly. That is a deployment's
decision and a loud one — config warns at startup, because "nobody set it" and "anyone is welcome"
must not look alike from outside. The server itself is service-kit's, so body parsing, request logging,
`/ping` and rate limiting come with it.

**Every endpoint, with its parameters and responses, is in
[CATALOG-API.md](../modules/CATALOG-API.md).** It is not repeated here: two descriptions of one
endpoint are two things to update, and the second one is always the one that gets forgotten. What
follows is why the API has the shape it has, which is this document's business rather than that
one's.

**A venue is a venue.** Bybit's second host appears in no path, parameter or response field — the
split into servers is this service's business. What identifies a file to a caller is an opaque
`key`, echoed back to say which file is meant; a path alone could not say which server it came from,
and making callers model that would put storage arrangements into everyone else's head.

**`pending` and `downloaded` are two collections**, disjoint and together covering every file, which
is why recording a download is a `POST` to one and a `DELETE` from the other. They are not a boolean
wearing a costume: across its history a file is genuinely in both.

**Urls are composed here**, from the venue's `base` and `root`. A downloader that built them would
have to be taught the rule and taught again whenever a venue moved.

### Naming what you want

**This is the listing the service exists for**, and every axis of it is a property of the *series*
rather than of the path:

**`variant` is the level below the dataset, whatever that level is for that
dataset.** Klines have a bar length, books have a depth and a mode, trades have an aggregation, and
the next dataset will have something else again — so it is one generic field holding a canonical
string, comma-separated where a dataset needs more than one level (`500,incremental`), rather than an
`interval` column beside a `depth` column beside whatever comes next. A dataset with no level below
it has no variant.

**A venue's word for a rendering is not a dataset.** Binance publishes trades twice and calls the
second `aggTrades`, but aggregation is a property of *those trades* exactly as depth is a property of
a book — so it is `trades` with `aggregation: aggregated`, and a consumer asking for trades finds
both renderings without learning one venue's word for one of them.

**The levels are named on the way out.** Stored, a variant is one string because a path is one
string; served, it is `{ depth: '400', mode: 'incremental' }`, so nothing downstream splits commas or
counts positions to find a depth. Where a level has a meaningful default the catalog reports it even
with nothing stored — trades at a venue that says nothing about aggregation answer
`{ aggregation: 'default' }`, which claims only *this is the one it publishes*, never that it is
raw.

| a caller names | answered from | note |
|---|---|---|
| `market` `dataset` `variant` | the `pattern` row | canonical, matched case-blind |
| `symbol` | the `series` row | the venue's own name, repeatable or comma-separated, case-blind |
| `grain` | read off the pattern's finest slot | which rendering — see below |
| `month`, or `from`/`to` | the `file` row's date | |
| `downloaded` | `file.downloaded_at` | `true`, `false`, or absent for either |

**Absent means *any*, and an explicit empty set means none.** No parameters at all is the whole
venue. Naming instruments that publish nothing is a filter that matched nothing, and is answered
with nothing — answering the whole venue there would hand back every dataset it has to a request
that asked for one nobody publishes.

**`grain` is the one that is easy to leave out and shouldn't be.** Many venues file the same data
both monthly and daily, and those are two renderings of one month: a caller asking for June trades
without saying which gets the monthly file *and* every day of June, holding the same trades twice.
Asking for both is legitimate — it is how a consumer discovers what a venue offers and decides which
to keep — so the filter is optional rather than defaulted, and a consumer that already knows says so.

**`GET /venues/:venue/shapes` is how a consumer decides what to want**, before asking for a file at
all: one row per `(market, dataset, variant, grain)` with how many instruments and venue-wide files
carry it and over what span. *Which bar lengths does this venue publish? Are its trades filed monthly
or daily? Does it have books, at what depths?* — all one request against patterns and series, which
are thousands of rows where files are millions.

**A shape says nothing about how a venue arranges its URLs**, and that is the point of the catalog
rather than an omission from it. Whether a dataset changed its path once or a thousand times is
prospector's business: where two shapes would be the same data twice, the catalog offers one of them
and consumers never learn there was a choice. What a shape may report is **different variants of a
dataset** — never the same data under two names.

**Its `last` is a maximum and its `open` is the claim.** `last` is the newest file anybody has seen of
the shape, accumulated as a plain maximum; `open` is true while any one of its series is still open,
which is the same question generation asks. One series still publishing leaves the whole shape open,
because the shape has not stopped while any of it is still being written.

They were one field, with `null` standing for "still publishing" — which threw the measurement away to
make the claim, so every shape reported no end at all. Split, they read: bybit's linear perp books are
`500,incremental` reaching `20250820` and **closed**, and `200,incremental` reaching yesterday and
**open** — one venue-wide changeover, and exactly what a consumer needs to fetch both sides of it.

**`GET /venues/:venue/files` is the general form**, over everything the catalog holds;
`GET /venues/:venue/pending` is the same handler with `downloaded=false` fixed, which is what a
downloader asks for every time and should not have to say. A listing that is not scoped to one state
carries `downloadedAt` per row, since otherwise the answer could not be read.

**A narrowed listing is a different query, not the same one with a filter.** Which series are a
venue's `perp` `klines` at `1h` is answered from the series registry in memory — series are counted
in thousands where files are counted in millions — so what is left is "the files of these series in
this range", which `file_series (series_id, date)` indexes directly, one seek per series.

Handing the same set to SQLite as a join instead lets it drive from `file_when` and test membership
per row, which scans every file the venue published that month whatever the narrowing asked for.
Measured on the real catalog, 200 series of one htx dataset over one month: **0.06 seconds as seeks
against 530 as a join.**

A narrowed page is therefore ordered by series, then by date within one — not globally by date. It
does not need to be: a caller narrows to one dataset and one month because that partition is the unit
it works in, and it finishes the whole of one before starting another. The cursor is
`(seriesId, date, path)`, so resuming is a seek rather than a skip.

**An empty series set is not "no filter"** — it is a filter that matched nothing, and answering the
whole venue there would hand back every dataset it has.

**`month` is the parameter that means what a caller wants**, and the only one that gets a whole month
right. `date` holds each series' own grain — `202506` monthly, `20250601` daily, `2025060113` hourly,
`202506011345` per minute — and every one of those sorts under the `202506` prefix, because a coarser
date is a prefix of the finer ones inside it. So a month is matched the way any prefix on a sorted key
is: `>= '202506'` and `< '202507'`, which is what `month` becomes. An inclusive `to` is simply the
wrong operator for a prefix, and would drop that month's finer files.

**Each item states what the file is**, so its reader never parses a path: canonical `market`,
`dataset` and `variant`, the venue's own `symbol`, the date, the extension, and which part where a
venue splits a period into several. `market`, `dataset`, `variant` and `symbol` are read off the
series — the same values a caller filters by, so what comes back is spelled the way it was asked
for — while `ext` and `part` are read from the path and the pattern by `catalog/shape.ts`. A row
whose series was never resolved answers blanks rather than being withheld, since the file is real
and still owed.

### When a download does not match

A downloader that fetches a file and finds different bytes has not hit an error — it has found that
the archive changed, and it is holding the new version. Discarding it would be absurd, and reporting
plain success would leave the catalog stating something untrue. So the report carries what was seen,
in `observed`.

**Prospector confirms before recording**, through the adapter — a listing venue asks for the one key
and reads the row back, an index venue sends a `HEAD`. It costs one request and fires almost never,
since an archive is insert-only unless somebody's engineering team erred. What it protects against is
a bug in a consumer writing nonsense into the catalog, which nothing would notice until the next full
survey.

**ETags are compared case-blind, because the case belongs to the server and not to the file.** OKX
serves the same order-book file from Alibaba OSS and from S3 — byte-identical, same length, the same
md5 in opposite cases. Kept as sent, that reads as a new version: a revision is appended and
`downloaded_at` cleared, so a file already on disk becomes one that is owed. Sightings are normalised
on the way in and both comparisons normalise again, which covers rows stored before that was true.
Nothing about a hex digest is case-bearing, so this cannot lose a distinction.

What prospector confirms is what gets written, not what it was told. Agreement makes the observed
version current, moves the displaced one into `revision` with the download state it had, and marks
the file held. Disagreement records what the venue says and leaves the file owed — whatever the
caller holds, it is demonstrably not what is being served — and logs loudly, because that means
either a client bug or a file that changed twice in a minute.

## Storage

SQLite, in WAL mode, with `STRICT` tables — SQLite is otherwise dynamically typed, and a declared
`INTEGER` column will happily hold a string, which surfaces later as a query that silently matches
nothing.

The schema lives in `src/catalog/`, alongside the queries. It was a shared package while a second
service was expected to open the file; prospector is the only thing that does, and everyone else
reaches it over the API, so a boundary with one thing on each side was costing without buying.

Ten tables. `venue`, `file`, `wip` and `revision` are what a venue serves and what became of it;
`pattern` and `series` are what it publishes and where; `run` is how far each pass has read; `month`
is the rollup that keeps a total from costing a scan; and `exclusion` and `unreadable` are the two
lists of things ruled out and not yet read.

**Migrations run automatically, once, on open — on every database, including a fresh one.**
Versioning uses SQLite's own `user_version`, so a database that has never heard of migrations reports
0 and needs no bookkeeping table. Each migration runs in its own transaction with its version bump,
so a failure leaves the file where it was rather than half-migrated, and a catalog from a *newer*
build is refused rather than written to by an older one.

The chain is four steps: the schema together with the venue rows and two lists of gate files that
are not what their URLs say, then htx's retirement dates, then okx's series, then bitget's. **A seed
is a migration and not a startup hook**, because a fresh catalog is
exactly the database that would otherwise pay for rediscovering it — which is what an earlier
arrangement got backwards, jumping new files straight to the head version and running the chain only
on old ones. A caller that wants the shape without the findings — a test fixture, mostly — declines
them with `seedData: false`, which still advances the version so nothing is retried behind its back.

**One file per migration**, in `database/migrations/`, named for the version it produces and listed in
order by that directory's `index.ts`. A migration is written once and then frozen, so the chain only
grows — and what grows with it is the prose, since the reason a step exists is the part worth
keeping. Adding one is a new file and a line in the list.

That is the only thing startup does to an existing file: no repair, no rebuild, no inference about
what it ought to contain.

One setting cannot be fixed retroactively — `auto_vacuum = INCREMENTAL` is applied **at creation**,
and enabling it later requires a full rebuild of the file.

WAL gives many concurrent readers alongside one writer; readers never block the writer and the
writer never blocks readers. Note that a WAL *reader* still writes the `-shm` sidecar, so mounting
the catalog read-only does not make it safe to share — it makes even a `SELECT` fail. Ownership
between services is a code boundary and cannot be delegated to the filesystem.

Startup therefore **proves it can write** before a survey begins, by setting `user_version` to the
value it already holds: a write transaction that changes nothing. Nothing cheaper answers the
question — opening a read-only file succeeds, and so does asking for WAL on a database already in
it — and finding out hours into a walk instead is the alternative.

## Venues

The registry is `src/venues.ts` and each adapter is one file beside it. **What is special about a
venue belongs in [docs/venues/](../venues/)**, one document each; what belongs here is the shape of
the problem those adapters exist to solve, and the hooks the core grew to let them solve it.

| | |
|---|---|
| **a server, not a venue** | an adapter is one host. A venue serving its books from a second machine is two adapters sharing a name, with two limiters and two sets of run rows |
| **listed where it answers, not where it serves** | a CDN in front of a bucket may answer a listing plausibly and wrongly — a cached reply is indistinguishable from a broken venue except by `x-cache` and `age`. Several venues are therefore listed at one address and downloaded from another |
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
  what it means for the key, `ruleOnSuccess` says what the next candidate is. What to *do* about any
  of those — stand the venue down, drop the row, park the key — stays in one place for every venue.

#### `getContext` and the occasion

| occasion | what an adapter may do |
|---|---|
| `'full'` | reach the venue and re-establish everything, however long it takes |
| `'partial'` | reach the venue too — reconciling is the only way a new symbol is ever discovered, since probing can only ask about series already known |
| `'lookup'` | **reach nothing.** What an HTTP handler passes to confirm one key inside a request, where fetching would turn a confirmation into an unbounded call |

**Which of the first two applies is read off where the venue has got to**, never off what a caller
asked for. The scanner never sees a database: it receives what the adapter assembled, as data.

### Bounds arrive from outside, and this service does not ask how

A venue that constructs its keys must know where to construct them *between*, and establishing that
is research rather than scanning — a venue's download portal, its instrument APIs, whatever mixture
that one turned out to need. So it happens beside the adapter and lands in the catalog as rows, which
this service then reads exactly as it reads any others. See
[a seed is research before it is data](#a-seed-is-research-before-it-is-data).

**Unbounded, construction is hopeless**: every period the archive could hold, for every instrument,
almost all of them misses. Bounded, it is one request per candidate that could exist.

**A series with no start produces no path, so the scanner never sees it.** Two different rows look
like that — one the venue publishes nothing for, ever, and one listed but not yet publishing — and
neither is recorded as an absence: a completed pass deletes the row either way, and the second is
created again by the next preamble. Which is which is the venue's to decide, not this table's.

**A dataset's venue-wide file is not an instrument.** Where a venue publishes one file a period
carrying every instrument at once, there is nothing per-instrument to measure and no series to keep
per symbol: it exists for as long as its dataset has, so it is generated from the earliest start that
dataset records through to the last complete period. Only where nothing per-instrument is bounded at
all does it need a floor of its own.

### A series has a life, and the preamble is what moves it along

`state` is where the instrument stands, and it is what decides whether either bound can still move:

| state | what it means | what is still open |
|---|---|---|
| `active` | the venue lists it today | the **start**, if it has none — listing and publishing are different events |
| `delisted` | listed once, not now | the **end**, if it has none — an archive can outlive the listing |

There is no third state for "never published". Such a row records an absence rather than a
measurement, so reconciliation **deletes** it — the one place a series row is ever removed. Every
other row is insert-and-update, because a row that has published something is a measurement and
measurements do not stop being true.

### An empty series is deleted, not flagged

Once a pass has **finished**, every period each of its series covers has been asked about. A series
the archive answered for none of them holds nothing: no start, therefore no end, and nothing the row
could say. Keeping it costs `OVERDUE_DAYS` of keys a day, for ever.

**The listing does not enter into it.** An instrument the venue lists today that has never published
is exactly as empty as one it has forgotten, and a shape that has been retired will never produce a
first file for either. Deleting is safe because it is reversible *by the venue*: a listed symbol on a
live shape is created again by the next preamble and backfilled — find files and they stay, find none
and it goes again, until the day something publishes. A symbol that is gone, or a shape that is
retired, is not recreated, which is what stops a dead branch being probed for ever.

**It asks the file table, not the `first` column.** `first` is filled in by reconciliation's own
third step, so reading the column here would delete a series on the very pass that was about to
measure its start. That was invisible while this flagged rather than deleted, because a flagged row
fell through and got its `first` anyway.

On every start, before the context is built, a constructed-key adapter reconciles the table against
the venue's own listing:

1. **fetch the active symbols**, dropping anything the venue calls `preopen` — announced but not
   trading, so no archive is possible and it is treated as though the venue had not named it
2. **insert what is new**, as `active` with no bounds
3. **flip to `delisted`** every `active` row the listing no longer carries
4. **for every dead row with no end** — from this pass or any earlier one — probe back from
   yesterday a day at a time until data answers; that day is the end. A row that answers nothing
   anywhere is deleted by the next reconciliation, having nothing to record
5. **for every active row with no start**, probe forward from the newest start the table records —
   snapshotted before the pass, so starts written during it cannot move the bar — and stop at the
   first hit

**Both probing steps key off the series' own emptiness, never off what changed today.** A symbol that
listed last week may not be publishing yet, and one delisted yesterday may keep publishing for days
— an archive can outlive a listing. So "changed state this pass" is the
wrong trigger in both directions; "has no start" and "has no end" are the right ones.

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
  catalogued is not disturbed — a bare sighting only moves `last_seen` — but everything else means a
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

**A pattern's slots are a calendar and an instrument** — `{YYYY}` `{MM}` `{DD}` `{HH}` `{MI}` and
`{SYMBOL}` — and everything else in it is literal, because a different value of it is a different
shape. So building a key is substitution and nothing else, whoever does it.

**The grain is read off the shape rather than recorded twice**: the finest slot a pattern carries
is how often it publishes, so a pattern with `{HH}` is hourly and one with neither `{HH}` nor `{DD}`
is monthly. A slot declares its grain by *ending* in it, which is what lets a venue invent one
without the catalog having to be told its cadence separately.

**Where a venue's paths are not a calendar, the adapter renders them**, through a `slotsFor` hook
that is handed the stamp and returns the slots to fill. Two venues need it, and both would otherwise
have forced a shape on every other venue:

| venue | slot | why |
|---|---|---|
| bybit | `{MONTH_LAST_DAY}` | `kline_for_metatrader4` names a whole month by both its ends, and February stops the second one being a literal |
| gate | `{EPOCH_HH}`, `{EPOCH_MI}` | its two snapshot trees name a file by the instant it covers, in Unix seconds |

That is the division throughout: the shared code carries what most venues do, and a venue's oddity
costs that venue's adapter a function rather than costing everyone a vocabulary.

### Every path is parsed, or it goes on the worklist

Reading paths exists to keep series and their tips current, so **a path nobody can parse is a series
nobody is tracking** — its tip never advances and the update that was the whole point quietly stops
extending it.

So nothing is passed over in silence. A path no adapter can place lands in `unreadable`, keyed by
path with a count, and the survey carries on:

```sql
unreadable(venue_id, path, reason, seen, first_seen, last_seen)
```

`reason` separates the two ways it can happen. **`unread`** is a shape no adapter recognises — the
common case, and the thing to fix. **`undated`** is one adapter contradicting itself: `inspectUrl`
placed the path in a series, so it found a date in it, and the same venue's `dateOf` then declined to
date it.

The file itself is still catalogued if it carries a date, so nothing is lost while a shape waits to
be read — it simply has no series against it. Counting rather than repeating is what makes the table
worth reading: one row seen 40,000 times is a dataset nobody parses, and one row seen once is a
stray key.

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

**A series is identified by its pattern and the name its keys actually carry** — `COALESCE(url_symbol,
symbol)`, not the symbol. Two series of one pattern that resolve to the same name are not two series:
they generate the same URLs, which is the definition of being one. The symbol alone cannot serve,
because an instrument whose archive name changes mid-life is two series that agree about everything
except that name, and both must be able to exist under the symbol a consumer asks for. SQLite
enforces this directly, as a unique index over the expression, which also settles the NULL convention:
a spelled-out `url_symbol` and an implicit one collide as they should.

Reading a path back is the one place the decoration still matters, and it is evidence rather than
spelling: okx's flat namespace puts a spot pair and a futures family under names differing by nothing
else, so the suffix in the *path* is what says which market it is — and the market then picks the
pattern.

### The three bounds a series carries

Every series carries `first`, `last` and `tip`, and between them they decide everything an update
does.

| | |
|---|---|
| **`first`** | the oldest date seen for this series. NULL means *unknown*, not *none*. A **floor** on generation: nothing was published before a series began, so a tip sitting under its start does not license asking about the gap |
| **`last`** | the **newest** date seen for this series. NULL means *nothing has ever been seen*, and nothing else. Monotonic, like the other two |
| **`tip`** | *nothing at or below this period will ever be asked about again.* Generation starts at the period after it. A one-way ratchet: nothing lowers it |

`first` and `last` are symmetrical and both are **measurements**: the oldest and newest dates anybody
has actually seen. Neither is a claim about the venue — `first` is "first in the archive", not "first
ever published", because a rolling-window archive has an early bound that moves; and `last` says
where the archive has got to, not that it has stopped.

So the generation range reads only the calendar and the two ends of the ratchet:

```
START := max(tip + 1, first)                 first ignored where NULL
END   := min(last complete period, retired_at)   yesterday, or last month for a monthly shape
```

**`last` does not bound generation.** It used to, and that was the only thing stopping a finished
series asking for ever — at the cost of the measurement itself, because the field then had to be left
NULL to mean "more is expected". So every shape in the catalog reported no end at all, and a variant
that stopped beside the one that replaced it was unreadable.

*Whether* to generate is now a separate question with a single answer, `open`.

**These three are what anything reasons about a series with**, and that is a deliberate property of
the schema rather than a convenience. `series` holds tens of thousands of rows per venue where `file`
holds hundreds of millions, so "when does this series start, where has it got to, is it still
running" is answered from three columns rather than from a group-by over the largest table in the
catalog. Querying `file` for a range is a thing to do while *establishing* a venue — see
[a seed is research before it is data](#a-seed-is-research-before-it-is-data) — and not something the
ordinary path should ever need.

**Which is why a seed states a floor and never a `first`.** Nothing raises a `first`: `sawFile`
lowers it and only lowers it. So a seeded start is uncorrectable the moment it is too low, and it
becomes too low as soon as a venue withdraws its earliest file — a lie in the one column everything
downstream trusts, with nothing in the system able to notice. A floor costs the backfill a few
requests and arrives at whatever is true today, in every case where the stated one would have been
right and in the one where it would not.

### `open`: one definition, for generating and for reporting

**A series is open when this catalog still expects files for it, and keys are generated for exactly
the series it still expects files for.** Those are one concept, so they are one function — `open` in
`catalog/series.ts` — read by generation and by the API alike. Stated twice they would drift, and
silently in both directions: a shape reported open that nothing asks about, or one reported closed
while requests go out for it every day.

| | |
|---|---|
| **listed, on a live shape** | open. The venue still trades it and still writes this shape, which outweighs any quiet spell |
| **nothing seen yet** | open. There is no measurement to call it finished on — every newly listed instrument is here between its series being created and the archive's first file |
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
than about the venue. Reconciliation keeps lifting the tip to `OVERDUE_DAYS` ago, so the window comes
out at about two of them — a month for a daily shape, a month and a half for a monthly one. That
figure is arbitrary and deliberately so.

The floor matters for the reverse case: a seed that states one floor per *dataset* rather than per
series starts every series years below its own start, and without the clamp each spends the gap
asking about days known to hold nothing.

### A sighting states the bounds; a finished pass checks them

**A walk is the source of truth, so it reads none of the three to decide anything.** It never skips a
period, stops early, or refuses a file because of a `first`, a `last` or a `tip`. It reads the index
and states what is there. The file that creates a series is also the first thing known about it, so
the bounds are written by the same call that writes the row — leaving them null for a later pass to
fill in is how a series ends up on disk claiming to have no start.

Two rules, applied per sighting, with `d` the file's date. A series that does not exist yet is not a
third case — it is the same rules with nothing to coalesce against:

```
first := min(first, d)
last  := max(last, d)
```

**Both of those only ever widen, which is why a pass reads them back at the end.** A sighting holds
one file, and one file can only extend a range — so nothing in the ordinary path can ever narrow a
bound, and a file the venue *withdraws* lowers none of them when it goes. The row would go on
claiming a date the catalog itself has marked absent.

So reconciliation, over a pass that finished, recomputes every bound from the files that justify it
and replaces any that cannot be justified — one ordered read of `file_bounds`, reported as
`corrected` and expected to be zero. It is the last thing a pass does rather than a second writer
beside the first, so the two never disagree about a series mid-pass.

**The tip is not among them, because it is not a per-file claim.** What a walk proves about a tip it
proves by reading its index to the end, not by meeting any particular file: every period at or below
`START - OVERDUE_DAYS` was offered and answered. That is one value for the whole walk, and it is
stated once, over every series of the venue, when the last partition closes — see `settleWalk`. A
series the walk never mentioned earns it exactly as much as one it mentioned a thousand times, because
a period the index never named was not published, whoever it would have belonged to.

The one exception is not an update but an initialisation: generation refuses a series with no tip at
all, so a series the walk *creates* starts at that same edge, or at its own file where that is newer.

**`last` is the newest date seen, and it is the whole of what a sighting says.** Nothing concludes an
ending from it — that judgement lives in `open`, and it needs the instrument's listing and the shape's
state as well, neither of which a sighting knows.

All three are monotonic, so nothing depends on meeting a series' files in date order — which an index
does not guarantee across hours and partitions.

**A sighting states both edges, because they are the same claim.** A file at a date proves the series
reached back at least that far and forward at least that far; which of the two it moves is arithmetic,
not different evidence. So `sawFile` writes `first` down and `last` up, and neither ever goes the
other way.

The old rule was that only a walk may say where a series begins — an update generated the key it is
holding, so writing `first` back from what it settled looked circular. What that missed is that a
start is not a wall. `first` floors *generation*, and the keys below it are already parked in `wip`,
on disk, surviving a restart; they go on being probed whatever the column says, and anything they find
lowers it again. What a start bounds is the asking that has not happened yet.

What the rule cost was concrete. A venue with no index has no walk, so `first` could only be filled by
a reconciliation at the end of a completed pass — and okx and bitget ran with files going back months
under a NULL start, on series whose `last` had been moving the whole time.

**A tip has exactly two writers, and neither of them is a file arriving.** `first` and `last` are
measurements of a file and are written by the sighting that saw it. A tip is a claim that a whole
*range* was asked about, which no single file is evidence of — so it is stated over a set of series at
once, by the two things that earn it:

- **a walk that closed every partition**, at `START - OVERDUE_DAYS` — `settleWalk`;
- **an update that generated everything it owed and drained `wip`**, at the settled edge —
  reconciliation.

Both lift and neither lowers, and both are gated on having finished: a walk that left a partition
unread offered part of a keyspace, an update that stopped mid-drain has questions outstanding, and
neither has proved anything about the range it did not reach. A tip does not come back.

**Nothing crawls a tip forward any more, and the machinery for doing it safely went with it.** A
per-file tip has to be contiguous or it buries gaps — answers arrive in whatever order the venue gave
them — so it could only advance on the period *immediately* above it, then walk up through whatever
else was already answered, and it had to stop below any period still holding a row in `wip`, since one
period can be several keys where a venue splits one into numbered parts, and the first of them
settling says nothing about the rest.

All of that existed to make a per-file tip safe, and none of it was load-bearing. Generation reads the
run's own cursor, not the tip, so a tip creeping forward mid-pass changed nothing about what was asked
for — and the pass that finishes lifts every tip to the settled edge regardless of where it crept to.
What is left is a `wip` read taken off the settle path entirely.

The reason a tip may not move on a key merely *generated* still stands, and it is why generation may
never touch one: a generated key is a question, and retiring a period nobody asked the venue about
loses it permanently. That was a real bug: with the tip advancing at generation, a pass left
thousands of series tipped at yesterday with a quarter of a million keys still unconfirmed beneath
them, and a `wip` row dropped without settling is never regenerated.

### Bounds are buffered, and flushed before a cursor moves

Bounds are held in memory and written in batches, on a full buffer or a quiet interval. **A walk
flushes before its cursor advances**, and that ordering is the whole guarantee: a page whose files are
committed and whose cursor moves on, while the bounds derived from them sit in the buffer and are
then lost, leaves a series whose `first` is quietly later than the truth — and nothing afterwards
re-reads the page that would have corrected it.

Within that ordering the buffering is free. A buffer lost between page boundaries costs nothing,
because the page is re-listed from its cursor and rewritten.


### What ends a key: absence, confirmed

**Absence is the only answer that takes a key off the list**, and only once the venue has given it
more than once. A single 404 is a moment, not a fact: a key probed the instant before it was published
answers truthfully and is wrong about the archive, and a pass that took the first miss as final would
let reconciliation retire the whole period without ever asking again.

**How many attempts depends on who said the key was there** — the `existence` the row was parked
with, never the pass doing the asking:

| parked as | attempts | why |
|---|---|---|
| `confirmed` | 30 | a listing named it, so absence contradicts evidence. A venue mid-write or having a bad minute looks identical from here, and being slow to write a key off costs requests where being quick costs the file |
| `assumed` | 2 | built from a pattern and a date. Absence is the ordinary answer to a guess, and confirming it thirty times spends thirty requests proving what the first already said — on keyspaces that are mostly empty |

How a venue *spells* absence is the adapter's to say. `404` is absence everywhere; a venue that
answers otherwise names its statuses in **`notFoundCodes`** — a bucket granting `GetObject` without
`ListBucket` says `403` rather than admit what it does not hold, and several CDNs do the same
deliberately. Where the same status also means *we* are being turned away the two separate by headers
rather than by code, and that is `refusesUs` and `ruleOnFailure` instead: listing such a status would
read a refusal as a missing file and record absence while being blocked.

Beyond that, each non-settling answer is put to the adapter first:

| verdict | meaning |
|---|---|
| `null` | as you were — a 404 is absence, anything else is not |
| `'drop'` | this status means absent at this venue, however it is spelled |
| `'keep'` | not absence, whatever the status says |

**A rule can ask which pass it is in**, through `surveying(adapter)`, and bybit/secondary is why. On a
walk its index has already said the file is there, so a `404` contradicts evidence — far more often a
CDN having a bad few minutes than a withdrawal — and giving up writes the file off for good, because
the key sits below the tip and only a full refresh would ever build it again. On an update nothing
promised anything: the key came from a pattern and a date, absence is the ordinary answer to a guess,
and confirming it a hundred times spends a hundred requests proving what one said. Same status, same
hook, opposite meanings, so the rule asks rather than treating them alike.

The helper is ambient rather than an argument because the question is: an adapter rule is handed one
answer about one key and cannot be told which pass it belongs to without threading a parameter through
every caller in between. It is keyed per venue, since one process surveys all of them at once, and
scoped so that no ending — a throw, a pause, a venue blocking us — leaves a venue looking like it is
still walking. What it cannot say is where a *row* came from: an update that inherited a walk's
undrained backlog judges those rows as an update would, which is the same trade the restart already
makes.

**Bitget overrules the meaning of a status**, and it has to: its bucket grants `GetObject` without
`ListBucket`, so every object it has never held answers `403 AccessDenied` — the same status as being
turned away, separable only by the headers. `ruleOnFailure` reads an S3-served `403` as this venue's
404. It still takes its three confirmations, because how many times a venue must repeat itself is not
a venue's business.

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

**Nothing is settled by a clock any more.** `OVERDUE_DAYS` acts exactly once, in reconciliation, over
a pass that finished — see below. The `abandoned` table went with the rule that filled it.

### Asking a venue about itself

An archive is a bucket that answers a key. A venue's API is a web service with its own limits, its own
throttling, and its own habit of returning a refusal inside a `200` — okx does exactly that. It also
sits outside the pace gate the archive's host is held to, because it is not that host.

So there is one hardened fetcher for it, shared. It carries two clocks — one bounding the wait for a
reply, dropped the moment headers arrive, and one bounding *silence* once a body has started, so a
megabyte of instruments is welcome to take its time while a stopped download fails promptly. It
retries transport faults, reads the body inside the retry so a truncated one is retried rather than
thrown, and lets a venue say what a refusal-inside-a-success looks like.

It began as one venue's and is now shared, which is the point: the preamble would have made
five more. One implementation, seven callers.

### The preamble: asking the venue what it lists

Probing can only ask about series that already exist, so nothing an update does will ever find a
symbol listed since the last full pass. A walk finds one by reading the index and a seed by having
been built; between those there is only this. Without it, a venue that lists a hundred pairs a month
quietly stops being current, one pair at a time, until somebody re-walks it.

**It runs to completion before generation starts**, which is the one ordering that matters: a series
created after the job opened would not be generated for until the pass after next.

An adapter answers with every instrument it lists, across every market, **already spelled the way the
archive spells it**. That is the same translation `inspectUrl` does for paths, at the same boundary —
the catalog's `symbol` is defined by the files, so an API answering `btcusdt` against an archive
writing `BTC-USDT` is the adapter's to reconcile. How many calls it takes is the adapter's business:
binance needs four hosts, htx four endpoints.

`live` is stated rather than inferred. Some venues publish their dead — listing offline symbols
beside online ones, or answering a closed status on request — and taking "absent from the list" as
the only signal would read those as alive. Where a venue lists only what it trades,
everything omitted is not live, which the step works out for itself.

Then three things happen and nothing else:

| | |
|---|---|
| **listed, no live series** | a series per *active* pattern of that market **that names a symbol and whose keyspace can carry it**, and a `backfill` to earn its tip |
| **listed, only dead series** | those series revived — `state` back to active — never duplicated. The venue listing it again is new information, and those are the series that would carry anything it now writes |
| **listed, only series on retired patterns** | current shapes created; the retired ones stay dead |
| **not listed, or listed as gone** | its series marked `delisted` |

#### The backfill reaches below the tip without ever moving it

A series created here is given its tip **up front**, at the floor the pass covered to, and `backfill`
then probes *downward* from there for as long as the venue keeps answering. Each period it finds is
written straight into `file` as settled — a `HEAD` carries size, checksum and last-modified, which is
the whole of a file row — so history under the floor is reached without anything below the tip ever
being generated for.

**The tip does not reverse, here or anywhere.** It is a one-way ratchet in every path, and the
backfill returns the floor it started from. Reading it as "the tip moves back for a new instrument"
is the right intuition about the *effect* and the wrong one about the mechanism, and the difference
shows up the moment somebody asks what re-reads that range later: nothing does. The files are there
because they were recorded, not because the range is still open.

It runs only for series with no `first` — one request where the instrument is as new as it looks, and
the only thing that ever recovers history at a venue with no index. A series that already has a start
is skipped: the archive below it has been read, and asking again re-probes years to re-find files the
catalog holds.

#### A shape with no symbol cannot be branched by symbol

This step exists to discover instruments and give each one its series, so a pattern that never spells
a symbol has nothing for it to branch on: **every instrument handed one generates the identical
sequence of keys**, and the series are the same series wearing different names. Venue-wide files are
the case — one object per period carrying every instrument of a market at once — and there the
dataset *is* the file. The market's `@` series carries it, made by a walk or a seed. So a pattern
with no `{SYMBOL}` slot is never offered to an instrument.

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
market names neither and every pattern is offered, exactly as before.

Nothing is derived from the symbol. The endpoint that listed a contract *is* its domicile, known at
the moment it is read; re-deriving it from a ticker is guesswork that happens to work until a venue
names a stablecoin BUSD. See [BINANCE.md](../venues/BINANCE.md) for the measurements behind that.

Without it, every newly listed binance perp got 130 series under a tree that has never held one of
its keys — and a series that has never published has no end to reach, so nothing ever retires it.

**The preamble is the only place a series is retired**, because it is the only place that knows both
halves of the question:

| the venue | its files | result |
|---|---|---|
| still lists it | anything | `active`, any end **cleared** |
| no longer lists it | still recent | `delisted`, end **cleared** |
| no longer lists it | stopped | `delisted`, **end recorded** — never generated for again |

Either half alone says nothing. an archive can outlive a listing, so a
delisting is not an ending; a listed instrument can go quiet for a fortnight and come back, so silence
is not one either.

"Stopped" means older than the tip by `OVERDUE_DAYS` — and since reconciliation has just lifted that
tip to `OVERDUE_DAYS` ago, the patience is two windows, about a month. Arbitrary, deliberate, and paid
once per instrument rather than every pass.

**Only markets the venue answered about.** A list covering spot and silent on options is not a
statement that the options are gone, and most venues split their API across endpoints — so silence
retires nothing.

#### It refuses rather than guessing

Before anything is created or retired, the step compares what the venue lists against what the
catalog holds. **A spelling that disagrees is the one failure that is silent and total**: every
instrument reads as new, so it would create a parallel set of series *and* mark every real one
delisted, with nothing to show it had happened.

The test is "most of what the venue lists, we have already seen" — never the reverse, since an archive
holds thousands of symbols a venue stopped listing years ago and a small overlap in that direction is
correct. Below half it logs the counts and an example and does nothing at all: a venue does not
relist itself overnight, so anything near a clean split is drift rather than new listings.

### What a completed update pass is worth

A pass is complete when it **generated every URL it owed and drained `wip`**. That is the update's
equivalent of a walk having read the whole index: a transient failure would still be in the queue, so
a drained queue means everything left in the record is an answer.

Only then does reconciliation run, once, per venue — two statements:

```
1.  tip    := max(tip, TODAY - OVERDUE_DAYS)       every series
2.  DELETE                                         where the file table holds nothing for it
```

**Bounds are not among them.** Both are written by the sighting that saw the file, as it arrives, so
there is nothing here to measure a second time. Reconciliation used to fill a missing `first` from
`MIN(date)`, which meant `last` moved during a pass while `first` waited for the end of one — the two
columns meaning different things at any given moment.

**The delete is the only removal reconciliation does**, and it asks the file table rather than the
`first` column. The two agree now, and the column would be the cheaper read — but they agree only for
rows written since they did, and a catalog still holding series from before that, files and all, would
have them deleted wholesale by a reader that trusted the column. Nothing ever published means there is
no end to look for because there was never a beginning, and no request is needed to know it. An end
for a series that *did* publish needs to know whether the venue still lists it, which only the
preamble can ask.

**The first is what retires an absence for good**, and it does so without anyone having tracked which
series had a gap: a real hole, a transient miss that settled later, and the permanent dead range below
a newly listed instrument's true start all go the same way.

**It only ever raises.** A series whose keys were all found has already carried its own tip up past
the floor, and is left exactly where it is — those days are settled by having been answered, not by a
clock, and nothing re-probes them.

After it, a series that found something has a tip near yesterday and one that found nothing sits
*exactly* at the edge.

**A pass that did not finish reconciles nothing.** Blocked, paused, a partition that could not be
read, a venue answering nonsense — all of them return normally and none has checked anything. Lifting
their tips would assert the last `OVERDUE_DAYS` were asked about when they were not, permanently,
since a tip does not come back. The pass says so in the log and the next one generates a wider range.

**A walk never reconciles.** It states its own bounds as it reads, and a clock has nothing to add to
an index that was read to the end.


### When one key implies another

Generation builds a key from a pattern and a date, which cannot express an archive that splits one
period into an unknown number of pieces. At least one venue does: a day's trades are cut into
numbered parts, `_001`, `_002` and on, and nothing in the path, the listing or the date says how many
there are. The only way to learn is that the next one is not there.

So a probe that *settles* is put to the adapter too, through `ruleOnSuccess(path, size)`:

| it returns | meaning |
|---|---|
| nothing | the ordinary case, and almost every venue |
| `action: 'accept'` | settle the file as usual |
| `action: 'replace'` | discard it — it never reaches `file`. For an archive whose published key is a manifest rather than the data |
| `next` | keys to park in `wip`, inheriting this row's series and period |

**Parked before the row that revealed them settles**, so a crash between the two costs a repeated
probe rather than the keys. And because `next` names keys of the same *period*, the tip cannot move
over a period whose second part is still outstanding — which is the rule tips already follow, needing
nothing part-specific to know about it.

**A size threshold was the obvious alternative and is the wrong shape.** It would guess where the
venue states: one request saved against a silently truncated period.

**The chain ends where the archive does.** The first miss is an absence like any other and implies
nothing further, so nothing here needs to know how long a chain can be — which is exactly why this is
a hook returning the next candidate rather than a count declared anywhere.
