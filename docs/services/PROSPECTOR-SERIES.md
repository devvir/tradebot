# Prospector: series

How prospector records where a venue publishes — patterns, series, instruments and seeds — and the
rules that decide which keys an update asks about: the bounds a series carries, generation, `open`,
the preamble, reconciliation, and periods published in parts. What prospector is and how a pass runs
is [PROSPECTOR.md](PROSPECTOR.md); how the probe asks about the keys generated here is
[PROSPECTOR-PASSES.md](PROSPECTOR-PASSES.md#probing-settling-what-a-listing-could-not-carry). The
tables themselves are in [PROSPECTOR-STORAGE.md](PROSPECTOR-STORAGE.md).

## Patterns and series

**A pattern has the instrument as a slot; a series is one instrument's occupancy of it.** So a venue
listing a new symbol needs new **series** rows — one against each pattern of its market — and no new
pattern at all. A new *pattern* means something else entirely: the venue changed the shape of a URL.

**Two tables because they change at different rates.** A venue adds symbols weekly and changes the
shape of a URL once in years, so `pattern` holds the shapes — tens of rows, effectively frozen — and
`series` holds one row per instrument per shape, with its bounds and its tip, in the tens of
thousands. Holding both in one table would make adding a symbol something only code that knew how
to build that venue's URLs could do, which is knowledge an adapter would then carry for ever.

**The `series` table belongs to the core**, in `catalog/series.ts`; no adapter reads or writes those
rows. Nothing about `pattern` or `series` belongs to the venues that cannot be listed either. Every
venue publishes series of files that differ only by a date, and every file belongs to one; what
differs is only how the rows get there — an indexed venue records them as its walk confirms files,
and one that cannot be listed has them declared and its bounds measured.

### The slots

**A pattern's slots are a calendar, an instrument and a part** — `{YYYY}` `{MM}` `{DD}` `{HH}`
`{MI}`, `{SYMBOL}` and `{PART}` — beside the slots an adapter renders itself (below) and
`{TRANSFORM:…}` ([what a pattern cannot spell](#what-a-pattern-cannot-spell-one-instrument-at-a-time)).
Everything else in it is literal, because a different value of it is a different shape. So building a
key is substitution and nothing else, whoever does it.

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

That is why **okx and bitget have no `inspectUrl` at all**. Neither can be listed, so every key they
meet was generated, and the translation they need is one-way: attributes to URL, which is `keyFor`
substituting a date and a symbol into the pattern the series carries. The date is the one thing
still read from the path, by `dateOf`, which stays the single authority on it — a second source for
the same fact is a second thing that can disagree.

**A directory that names another period stays literal.** A pattern is built by replacing the file's
own date with slots, so where a directory names a different month from the filename, that month stays
in the pattern as written and the shape can only ever hold the one period it was found with. Such a
shape is seeded [retired](#retired-patterns) at the day it holds, so generation stops there and the
files stay; gate is the case ([PROSPECTOR-VENUES.md](PROSPECTOR-VENUES.md#gate)).

### A decoration around the symbol belongs in the pattern

Where a venue writes a constant around every name under one shape — a family suffix distinguishing a
futures chain from the spot pair of the same name — that constant is determined by the shape and not
by the instrument. Measured across the whole catalog: **not one pattern spells two of its symbols
differently**. A constant determined by the shape is what a pattern is *for*, so it goes into the
template:

```
…/{YYYY}{MM}{DD}/{SYMBOL}-futureschain-L2orderbook-…
```

Generating a key is then substitution of the venue's own name, and the canonical symbol stays the one
its listing uses rather than one decorated to match a path.

Reading a path back is the one place the decoration still matters, and it is evidence rather than
spelling: okx's flat namespace puts a spot pair and a futures family under names differing by nothing
else, so the suffix in the *path* is what says which market it is — and the market then picks the
pattern.

**What does not belong in the pattern is a difference between two instruments under one shape** —
that is `url_symbol` on the series, or a `{TRANSFORM:…}` slot where one key needs two different
strings.

### `url_symbol`, and what makes two series one

**`url_symbol` is how the archive spells the instrument, and NULL means "exactly as the venue does".**
It carries the transformation a pattern cannot express because it happens *inside* the name — a venue
writing `BTC/USDT` as `BTC_USDT`, or lowercasing — and the case where one instrument's files move to a
different name partway through its life, or appear under two names at once. Nullable rather than
blank: these rows are held in memory, and a null costs nothing where a copy of the symbol costs a
string each.

**A series is one shape and the name its keys carry** — `url_symbol` where there is one, otherwise
the symbol. Two series of one shape that resolve to the same name would generate the same URLs, so
the registry (`identity()` in `catalog/series.ts`) refuses the second before it is written. The symbol
alone cannot serve, because an instrument whose archive name changes mid-life is two series that
agree about everything except that name, and both must be able to exist under the symbol a consumer
asks for: one instrument's files under two names at once are two series of the one instrument. The
table's own unique index (`series_key`) is narrower: pattern, instrument (none for a venue-wide file)
and `url_symbol` with NULL as `''`. Writers therefore store NULL, never a copy of the symbol, where the
archive spells the instrument as the venue does.

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

### Retired patterns

**`pattern.retired_at` says the venue stopped writing that shape, and on what day.** The day is the
point: it is a ceiling on generation, not merely a fact about creation. It does two things, and a
bare flag could only do the first:

- **A newly listed instrument gets no series on a dead shape.** `patternsOf` offers only live ones,
  so an instrument listed tomorrow is created on the offered tree and nowhere else.
- **Generation for the series already there stops at that date** rather than at yesterday. The
  archive under a dead naming is still there to be read — but only up to the day it stopped.

A shape with no date is asked for every day from its floor to yesterday, once each, by the pass that
discovers it. On a venue that has renamed its trees more than once, that is millions of keys every
one of which is certain to answer that it is not there.

Retirement closes nothing by itself. A series stops being generated for when its own tip reaches that
ceiling, which is the ordinary rule and not a second one; and [`open`](#open-when-keys-are-still-generated)
keeps a series of a retired shape generating only while its newest file is within reach.

**Nothing can infer the date, so it is declared.** A missing file and a tree that has ended are the
same answer from the archive, and no amount of asking separates them — see [nothing notices a pattern
that moves](#nothing-notices-a-pattern-that-moves). So it arrives with the shape, from the seed that
carries it — `seeds/<venue>/pattern.csv`, one column, and a date somebody measured rather than
assumed. A venue *moving* a URL is two patterns as well, and the old one carries the day it stopped
rather than leaving its series to time out.

That is also why a *walked* venue can have a seed. Discovering patterns by reading an archive is what
a walk does well; noticing that a tree has **stopped** is what it cannot do at all, so a venue that is
otherwise fully walked may still seed nothing but its dead shapes and their dates. Which shapes are
seeded retired at each venue is in [PROSPECTOR-VENUES.md](PROSPECTOR-VENUES.md#venue-by-venue).

## Instruments

**An instrument is a row of its own**, `(venue, market, symbol)`, and a series is one shape it is
published in. What is true of the instrument is stated once, there, and every series of it reads it:
today that is `state` — whether the venue's listing still names it — since a venue lists or delists
an instrument, never one of its shapes. The venue is its *name* rather than a `venue` row: those
are servers, and an instrument published from two of them is one instrument.

**A series holds no symbol: it holds its instrument**, and its name is read from there. Whoever
creates a series — a survey or a seed — asks for the instrument first, through the one statement
`INSTRUMENT_OF` in `schema.ts`, which creates it where it is new and reads its venue and market off
the pattern's slice, and its kind off the pattern.

**A dataset's venue-wide file is not an instrument.** Where a venue publishes one file a period
carrying every instrument of a market at once, there is nothing per-instrument to measure and no
series to keep per symbol. The file is the market bundle (`@`) series, which has no instrument — `@`
is how a series without one is spelled wherever a symbol is expected — and it is generated from its
own tip like any other series.

**A chain is an instrument too**, of `kind` `chain`: a family whose files carry every one of its
expiries under the family's name, as okx's `…-futureschain-…` files do. Its members differ in expiry
alone, so everything else true of them is true of the chain, and it stands as one instrument; the
members themselves are only ever seen inside the files. What makes an instrument a chain is its
shape — `pattern.holds` says what one file of a pattern holds, `instrument` or `chain`. **A chain is
one file**, whatever is open inside it: `BTC-USD` has eight live contracts and one file a day, and
asking for a contract's own file answers 404. So a new expiry under a family the catalog already
holds creates no series and needs no discovery.

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
completed pass is worth](#reconciliation-what-a-completed-pass-is-worth). That is the one place a
series row is removed.

## Where series come from

Series arrive three ways, and patterns only one.

- **A walk** creates a series from the first file it reads under a new name, and a pattern from the
  first file it reads under a new shape. It is the only thing that ever creates a pattern from an
  archive, from a path an index handed it.
- **A seed** declares patterns, series and floors — for a venue that cannot be listed, and for the
  shapes a listed one stopped writing ([retired patterns](#retired-patterns)).
- **The preamble** asks the venue what it lists at the start of every update that is not a resume, on
  every venue with an `instruments` hook, listable or not. It creates series for newly listed
  instruments on the patterns already held, marks departed ones `delisted`, and backfills the series
  it creates — see [the preamble](#the-preamble-asking-the-venue-what-it-lists).

**Nothing discovers by probing.** An update generates keys from patterns already held, so it can
only extend series that exist, and it can never meet a shape it has no pattern for. So **discovery is
not what separates the two kinds of venue**: every venue with an `instruments` hook discovers new
instruments the same way, through the preamble, and an indexed venue needs that exactly as much as
an unindexed one once its walk is behind it. What differs is only how the backfill happened — a
listed venue found its patterns, its series and its files in one walk, while an unlisted one was
handed patterns and series and then guessed keys and confirmed them.

**What neither the preamble nor probing covers is a new dataset or a new pattern**: probing cannot
see one and an instrument listing does not name one. So a venue that changes its naming convention
costs a listed venue a re-walk — which is why a listable venue is
[walked again on a schedule](PROSPECTOR-PASSES.md#when-an-update-is-a-walk) — and an unlisted one
another round of research.

A walk remains the authority on what an archive holds. The preamble creates series from a listing,
and the files then decide which of them stay: see [what a completed pass is
worth](#reconciliation-what-a-completed-pass-is-worth).

### A seed is research before it is data

**A seed is what a walk would have produced.** The two are not different designs. A catalog starts
from a search space — the patterns, a series for every instrument that ever occupied one, the floor
each shape starts at — and every pass after that generates keys from it and records what answers. A
walk produces that search space as a by-product of reading an index once; a seed states it directly.
Discard everything a walk learned except those three and hand them over as a seed, and the first
update rediscovers the files and arrives at the same catalog. What a seeded venue is owed is
therefore not a different kind of pass, it is the backfill a walk would have done for free — and the
work of establishing its search space, which for an unlisted venue is research rather than reading:
a venue's download portal, its instrument APIs, whatever mixture that one turned out to need. So it
happens beside the adapter and lands in the catalog as rows, which this service then reads exactly
as it reads any others.

**Unbounded, construction is hopeless**: every period the archive could hold, for every instrument,
almost all of them misses. Bounded, it is one request per candidate that could exist.

**At a venue that cannot be listed, what only a seed can supply is narrower than it looks:**

| | where it comes from |
|---|---|
| **a pattern** | the seed, and nothing else. An update generates from shapes it already holds and can never meet one it has no pattern for, so a shape absent from the seed is invisible for ever |
| **a series for an instrument the venue still lists** | the seed *or* the preamble. A listing names it and the preamble gives it a series per shape of its market, exactly as at any other venue |
| **a series for an instrument nothing lists any more** | the seed, and nothing else. No API names a delisted symbol, and its files are in the archive all the same |
| **a floor** | the seed. Generation starts above a tip and a tip only ratchets forward, so history below a seeded floor is asked about by nothing afterwards |

So **a venue with no seed is not stuck**: it builds its series the way a seeded venue builds one for
a symbol that lists tomorrow — the instrument listing for the universe, probing for the bounds. A
seed saves re-paying for bounds already measured, and reaches what no listing names.

**A seed states a floor, not a `first`.** The first pass measures where each series starts, and
reconciliation replaces whatever a seed could have said about it.

**A seed's symbols are a superset, and only probing settles which are real.** A seed crosses every
symbol a venue has ever been seen to name with every pattern of its markets, because binding a symbol
to a shape beforehand is exactly the judgement that loses series: an instrument recorded in one
market may publish in the other, and a spelling the venue no longer lists may be the one its files
sit under. So a seed names many times the series the archive turns out to hold. The excess is not
waste in the record, only in the asking. A series the archive answers for keeps what it measured; one
it never answers for is deleted by the reconciliation after the first completed pass, and recreated
by the next preamble only while the venue lists the symbol on a live shape. What the catalog ends up
holding is what the venue turned out to serve.

The seed format, and how a research seed becomes a permanent one, are in the
[seeds README](../../services/prospector/src/database/migrations/seeds/README.md).

## The three bounds a series carries

Every series carries `first`, `last` and `tip`, and between them they decide everything an update
does.

| | |
|---|---|
| **`first`** | the date of the oldest file the catalog holds for this series. NULL means no file has been seen. A **floor** on generation: nothing was published before a series began, so a tip sitting under its start does not license asking about the gap |
| **`last`** | the date of the newest file the catalog holds for this series. NULL means no file has been seen. Never a ceiling on generation |
| **`tip`** | *nothing at or below this period will ever be asked about again.* Generation starts at the period after it. A one-way ratchet: nothing lowers it |

`first` and `last` are **measurements**. A sighting widens them (`sawFile`), and a finished pass
resets both to what `file` holds (`reconcile`), which is how a withdrawal narrows them. Neither is a
claim about the venue — `first` is "first in the archive", not "first ever published", because a
rolling-window archive has an early bound that moves; and `last` says where the archive has got to,
not that it has stopped.

**These three are what anything reasons about a series with**, and that is a deliberate property of
the schema rather than a convenience. `series` holds tens of thousands of rows per venue where `file`
holds hundreds of millions, so "when does this series start, where has it got to, is it still
running" is answered from three columns rather than from a group-by over the largest table in the
catalog. Querying `file` for a range is a thing to do while *establishing* a venue — see
[a seed is research before it is data](#a-seed-is-research-before-it-is-data) — and not something the
ordinary path should ever need.

### A sighting states the bounds; a finished pass checks them

**A walk is the source of truth, so it reads none of the three to decide anything.** It never skips a
period, stops early, or refuses a file because of a `first`, a `last` or a `tip`. It reads the index
and states what is there. The file that creates a series is also the first thing known about it, so
the bounds are written by the same call that writes the row (`walkSeries`).

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
index does not guarantee across hours and scopes — and a file the venue *withdraws* narrows
nothing when it goes. A pass that finished reads both bounds back from `file` and replaces any the
files do not bear out: see [reconciliation](#reconciliation-what-a-completed-pass-is-worth).

**`last` is the newest date seen, and it is the whole of what a sighting says.** Nothing concludes an
ending from it — that judgement lives in `open`, and it needs the instrument's listing and the shape's
state as well, neither of which a sighting knows.

### What moves a tip

**A tip is not a per-file claim, so no sighting moves it.** It says a whole range was asked about,
which no single file is evidence of. It is written when a series is created and lifted afterwards,
and nothing anywhere lowers it:

| | the tip |
|---|---|
| **a walk creates the series** | the walk's settled edge, `lastSettled(grain, START)` with `START` the walk's own start — or the file's period where that is newer, though never above the last period closed when the walk began |
| **the preamble creates the series** | the [covered floor](#the-preamble-asking-the-venue-what-it-lists) |
| **the preamble revives a relisted instrument** | raised to the covered floor where it is below it |
| **the preamble finds a series with a `first` and no tip** | the period below its `first` |
| **a pass finishes** | lifted by [reconciliation](#reconciliation-what-a-completed-pass-is-worth) |

**Generation never touches a tip.** A generated key is a question, and a tip moved over it would
claim an answer nobody has given: nothing at or below a tip is generated again. Generation refuses a
series with no tip, so a series a walk or the preamble creates has one from its first moment.

### Bounds are buffered, and flushed before a cursor moves

Bounds are held in memory and written in batches, on a full buffer or a quiet interval. **A walk
flushes before its cursor advances**, and that ordering is the whole guarantee: a page whose files are
committed and whose cursor moves on, while the bounds derived from them sit in the buffer and are
then lost, leaves a series whose `first` is quietly later than the truth — and nothing afterwards
re-reads the page that would have corrected it.

Within that ordering the buffering is free. A buffer lost between page boundaries costs nothing,
because the page is re-listed from its cursor and rewritten.

## Generation: which keys an update asks about

**The index is a bootstrap device, not a permanent dependency.** A full sweep is how everything is
discovered — the symbols, the datasets, the URL shapes, the gaps, the conventions nobody wrote down.
That is worth paying for once. Afterwards an update does not need to be told what exists: it needs
the next file of each thing already known.

So an update reads no listing at all, and it is not a scanner that does the work. `update.ts` builds
a page the same way for every venue: **one scope per live series, and the dates between its tip and
the last complete period substituted into its pattern**, a thousand keys a page. Nothing is fetched to
produce them, so a page costs no request and every key it yields is a candidate — which is why
probing is always on during an update, including for venues whose walks never probe. A cursor over
generated keyspace is a period, and it behaves exactly as a marker over a listing does.

**Per-venue variation is two optional hooks, not a generator each.** `slotsFor` renders a slot a
calendar cannot spell, and `expandParts` names the files a period was published in where it took more
than one. Everything else is substitution over rows, so a venue that needs neither adds no code to
this path at all.

**The generation range reads only the calendar and the two ends of the ratchet** (`update.ts`), with
`lag` the adapter's `probingLag` (one where it declares none, which is yesterday for a daily shape):

```
START := max(tip + 1, first)                              first ignored where NULL
END   := min(lastClosed(now - (lag - 1) days), retired_at)   retired_at ignored where NULL
```

**`first` clamps `START`**, which matters for a seed that states one floor per dataset rather than per
series: every series then starts below its own start, and without the clamp each would spend the gap
asking about days known to hold nothing. **`last` does not bound generation.** *Whether* to generate
is a separate question with a single answer, [`open`](#open-when-keys-are-still-generated).

**A series with no tip generates nothing.** It is skipped and logged (`Series with no known start
skipped`). A series with a tip and no `first` — every one the preamble creates — generates from the
period after its tip.

**One span may be skipped from the middle.** On a venue that cannot be listed, until a pass has
completed there, generation leaves out `[last + 1, lastSettled(seededAt)]` for a series with a
`last`: the pass that built the seed went on looking up to its own date, so that span is measured
absence (`Rules.seededAt`).

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

## `open`: when keys are still generated

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
instruments are alive and whose shapes are finished. Reading the instrument alone would keep every one
of them generating to yesterday for ever — which is the whole reason a retired pattern is recorded.

**The patience is measured from the tip, so `open` needs no clock.** The tip is how far the venue has
actually been asked, which is the only thing a silence can be judged against; a wall clock would call
a series closed over a fortnight nobody spent asking, which is a statement about this service rather
than about the venue. A series of a delisted instrument, or of a retired shape, stays open while its
`last` is within `OVERDUE_DAYS` of its tip, and reconciliation lifts the tip to at least
`OVERDUE_DAYS` before the pass began — so the window comes out at about two of them: a month for a
daily shape, a month and a half for a monthly one. That figure is arbitrary and deliberately so.

## The preamble: asking the venue what it lists

Probing can only ask about series that already exist, so nothing an update does will ever find a
symbol listed since the last full pass. A walk finds one by reading the index and a seed by having
been built; between those there is only this. Without it, a venue that lists a hundred pairs a month
quietly stops being current, one pair at a time, until somebody re-walks it.

**It runs at the start of every update pass that is not a resume** (`sync.ts`), for every adapter
with an `instruments` hook — all eight, listing venues included. A walk does not run it: it discovers
by reading the index. A resumed update skips it: its scopes are already planned, and asking the venue
again would spend its API calls to learn nothing. Probing can only ask about series already known, so
for okx and bitget the preamble is the only way a new instrument arrives after the seed.

**It runs to completion before generation starts**, which is the one ordering that matters: the
update's scopes are built from the series that exist when its job opens, so a series created after
that would wait for the next pass.

An adapter answers with every instrument it lists, across every market, **already spelled the way the
archive spells it**. That is the same translation `inspectUrl` does for paths, at the same boundary —
the catalog's `symbol` is defined by the files, so an API answering `btcusdt` against an archive
writing `BTC-USDT` is the adapter's to translate. How many calls it takes is the adapter's business:
binance needs four hosts, htx four endpoints. The calls go through the venue-API fetcher
([PROSPECTOR-TRANSPORT.md](PROSPECTOR-TRANSPORT.md#asking-a-venue-about-itself)), not the archive's
gate.

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

### The backfill reaches below the tip without ever moving it

A series created here is given its tip **up front**, at the covered floor, and `backfill` then probes
*downward* from the floor for as long as the venue keeps answering. Each period it finds is written
straight into `file` as settled — a `HEAD` carries size, checksum and last-modified, which is the
whole of a file row — so history under the floor is reached without anything below the tip ever
being generated for. It stops at the first period that does not answer, or, logged as an error, at
the oldest date the catalog holds for the venue. The files below the tip are there because they were
recorded, not because the range is still open: nothing re-reads that range later.

It runs only for series with no `first` — one request where the instrument is as new as it looks, and
the only thing that ever recovers history at a venue with no index. A series that already has a start
is skipped: the archive below it has been read, and asking again re-probes years to re-find files the
catalog holds.

### A shape with no symbol cannot be branched by symbol

This step exists to discover instruments and give each one its series, so a pattern that never spells
a symbol has nothing for it to branch on: **every instrument handed one generates the identical
sequence of keys**, and the series are the same series wearing different names. Venue-wide files are
the case, and there the dataset *is* the file: the market bundle (`@`) series carries it, made by a
walk or a seed. So a pattern with no `{SYMBOL}` slot is never offered to an instrument.

**What allowing it costs is not a duplicate, it is a scramble.** `file` is unique on
`(venue_id, path)` and settles with `DO NOTHING`, so such series never collide — they *divide* the
dataset, each period landing on whichever asked first, and none of them ever holding all of it. Every
one of them then re-asks the same key for ever.

Measured on okx, where four series shared `allswap-fundingrates`: between them they held 1,693
distinct dates and **not one date twice**. The `@` series had 11 of them; a perp listed weeks earlier
had 1,660, and so appeared to have five years of funding history it had never had — which is what
being handed a venue-wide file looks like from the outside.

### One market can be more than one archive

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

### It refuses rather than guessing

Before anything is created or delisted, the step compares what the venue lists against what the
catalog holds. **A spelling that disagrees is the one failure that is silent and total**: every
instrument reads as new, so it would create a parallel set of series *and* mark every real one
delisted, with nothing to show it had happened.

The test is "most of what the venue lists live, we have already seen" — never the reverse, since an
archive holds thousands of symbols a venue stopped listing years ago and a small overlap in that
direction is correct. Below half it logs the counts and an example and does nothing at all: a venue
does not relist itself overnight, so anything near a clean split is drift rather than new listings.
A catalog that holds nothing for the venue yet has nothing to disagree with, and passes.

## Reconciliation: what a completed pass is worth

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

**A pass that did not finish reconciles nothing.** Blocked, paused, a scope that could not be
read, a venue answering nonsense — all of them return normally and none has checked anything. Lifting
their tips would assert the last `OVERDUE_DAYS` were asked about when they were not, permanently,
since a tip does not come back. The pass logs `Pass unfinished` (unless it was paused), stays open,
and is reconciled by whichever run of it finishes.

## `OVERDUE_DAYS`

**Probing settles nothing by the clock.** Where a clock does decide — *is this late, or is it
never?* — it is `OVERDUE_DAYS`, 15, read through `lastSettled` in `dates.ts` by every reader alike:

- reconciliation lifts each tip to that edge over a pass that finished;
- a walk starts the tip of a series it creates there;
- the preamble and the backfill start a new or relisted series that far below the newest date the
  last completed update covered;
- a first pass over a seeded venue skips the span its seed proved empty up to that far below the day
  the seed was built;
- `open` keeps a delisted series, or one of a retired shape, generating while its `last` is within
  that distance of its tip.

**It is a decision, not a measurement.** Nothing established 15 days. It is where we decided to stop
believing a file is merely late. The longest wait any venue here documents is a week: binance
publishes a month's files on the first Monday of the next, which can be as late as the 7th, and gate
generates a month of 7-day candles on the 7th of the next (see
[BINANCE.md](../venues/BINANCE.md#publication) and
[GATE.md](../venues/GATE.md#candlesticks-intervals-and-cadence-differ-per-market)). Fifteen is twice
the worst promise and still short enough that ordinary lateness is never read as absence. Nothing
models when a file is expected: the one number stands for every venue and every dataset.

**It fails cheaply in the direction it fails.** A file arriving on the sixteenth day of a listable
venue is found by its next walk, which reads the keyspace and owes nothing to any tip. Waiting longer
instead costs a probe per gap per pass, on every series that has one, for as long as the wait lasts.
What it gives up is [a hole older than the window](#a-hole-older-than-the-window-is-walked-past-not-filled).

## A period published in parts

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
one at a time and reads each answer; one that knows them from the period names them at once. How
bitget and gate each name theirs is in [PROSPECTOR-VENUES.md](PROSPECTOR-VENUES.md#venue-by-venue).

### What the two callers do with it

**Generation follows the chain in memory first.** Before a single request, it walks the parts the
catalog already holds, reporting each back to the hook as present, and emits only the ones it does
not have. That is what lets an update finish a day a walk left half-catalogued: a chain that stopped
at the first file it already had would never reach the rest of the period. A token it has already
seen ends the period — the core cannot read a token, so it cannot tell a cycle from progress by
looking, only refuse to go round twice.

**The probe carries it on from there, on settlement and only on settlement.** A part reports back
when its fate is final: catalogued, or set down as absent — see [what ends a
key](PROSPECTOR-PASSES.md#what-ends-a-key-absence-confirmed). A `404` the core will ask about again is
still an open question, and a `503` is not an answer at all — put either to the hook and the same
period is expanded once per attempt. That is also what makes the answer a boolean rather than a
status: by the time it is asked, there is nothing left to interpret.

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

## Known gaps

Not plans, and not defects that break anything today — things worth knowing before trusting a
reading of the series.

### Nothing notices a pattern that moves

**A single `404` cannot say which kind of wrong it is.** *Nothing was published that day* and *the
template moved* are identical per request, and no amount of retrying separates them.

What would separate them is **shape**, which `pattern` makes computable: one instrument going quiet
under a pattern its siblings are still publishing to is a delisting, while *every* instrument of a
pattern going quiet at once is the template having moved. Nothing aggregates that, so **a whole
branch of a venue can disappear from one day to the next and no alarm fires** — the update simply
generates keys nobody answers, sets them down, and reconciliation lifts each tip past them, pass
after pass.

**It bites during an update, not a walk.** An indexed venue re-walking from empty, or refreshed,
reads whatever the venue serves and catalogues the new shape as a new pattern — so a full run
recovers on its own. It is the venues that only ever update, and the long stretches between full
runs, where a moved template is invisible.

Nothing models *when a file is expected*, so nothing can tell a file that is merely late from one that
will never come except [`OVERDUE_DAYS`](#overdue_days).

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

### A hole older than the window is walked past, not filled

Reconciliation lifts every tip without knowing what it steps over — a real hole, a miss that would
have settled on the next pass, and the dead range below a newly listed instrument's true start go the
same way — so anything unanswered below the tip is never asked about again. That is the deliberate
half of `OVERDUE_DAYS`, the price of not re-probing every gap for ever. What recovers it is a full
re-walk, which reads the keyspace and owes nothing to any tip. A venue that cannot be walked has no
second chance, which is what makes a lifted tip the one bound worth being careful with: too low costs
requests, too high loses files silently.

### A listed instrument that never publishes is asked about every pass

A series no file has ever been seen for has a NULL `last`, and `open` reads that as **open**: there is
no measurement to call it finished on. Each finished pass deletes it, since it holds no file, and the
next preamble creates it again from the covered floor while the venue still lists the instrument — so
the venue is asked about that window on every pass until something publishes.

Cheap at the scale of a real run, and the alternative is worse: closing on absence alone would put
the judgement exactly where the evidence is weakest — an instrument a venue lists but has not
published for yet is indistinguishable from one that never will. Every newly listed instrument is in
this state between its series being created and the archive's first file.
