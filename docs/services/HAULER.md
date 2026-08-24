# Hauler

Hauler brings catalogued venue files to disk under canonical names. Prospector
establishes what every venue publishes; hauler asks for a list of URLs, fetches
them, verifies them, and states when a partition is finished.

Everything it does follows from one division: **prospector owns what exists, and
hauler owns what is on disk.** Neither writes the other's conclusions, and where
they disagree the disagreement stays visible rather than being resolved by
whichever wrote last.

## What it is not

- **It does not discover.** The catalog knows what exists. Hauler asks for a
  list and fetches it; whether those URLs follow an obvious pattern or look
  random from here is not its business, and nothing in the service parses one.
- **It does not know how a venue structures its archive.** No prefixes, no
  naming rules, no tree walking. That knowledge lives in prospector and stops
  there.
- **It does not know what a venue calls anything.** Markets, datasets, variants
  and instruments arrive canonical. There is no translation table here, and
  adding a venue to prospector adds nothing to hauler.
- **It does not mirror the venue's hierarchy.** Where a file lands is decided by
  what the file *is*.

## The layout on disk

```
<archives>/venue/market/dataset/YYYYMM/FL/symbol/
    venue|market|dataset|symbol|period[|part].ext
```

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
| `dataset` | `klines,1m` | canonical, **with its variants** — `books,500,incremental` |
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

The unit downstream is `venue + market + dataset + month`: hauler completes one,
stocker imports one, cold storage evicts and restores one. With the month as a
level **that partition is exactly one directory** — matched without a walk, moved
with one rename, restored the same way.

The alternative, `year`, spreads a partition across every symbol directory of
that year, so locating one becomes a filtered walk and evicting one becomes a
`find` and many renames.

The cost is directories, and it is smaller than it looks: a month of one symbol's
daily files is about thirty, so roughly 2.3M leaf directories across a catalog of
~70M files — about 1% of the volume's inodes.

### There is no `tag`

The catalog computes a tag per venue for "the same period published twice", and
hauler never reads it. Enumerated, almost every one is something the canonical
name already says: a grain, an interval, a book depth, or which cloud served it —
which is not a fact about the data at all.

Bybit's books used to be the exception, where `ob500` and `ob200` distinguished
two depths of one dataset. They are a `variant` now, like every other level, so
the exception is gone and hauler reads no tags of any kind.

## Naming

**Hauler holds no venue vocabulary, and needs none.** The catalog answers in the
vocabulary the archives are arranged by — `perp`, `klines`, `1m`, `BTC_USDT` —
because turning `futures_usdt/candlesticks_1m` into that is prospector's job and
stops inside prospector's adapters. So naming is those fields put in order:

```
market   ─ the canonical market, as given
dataset  ─ the canonical dataset with its variant levels appended:  klines,1m
symbol   ─ the venue's own name for the instrument, or @ for a venue-wide file
period   ─ the date at whatever grain it covers
```

There is no table here, no per-venue rule, and nothing to keep in step with a
venue that renames a tree.

**What is left is checking.** A consumer of a vocabulary still owes that much, so
a market or dataset outside it is **refused by name** rather than approximated —
an invented name becomes a directory, and a directory becomes something a reader
trusts. A refused file is skipped and logged; it is a gap between the two
services, not a fault of the venue's, and not a failed download to report.

**An empty symbol is a refusal too, and a subtle one.** `@` is the catalog's own
name for a file carrying every instrument of a market. Blank means it could not
place the file in a series at all — a different claim entirely — and filing that
as `@` would hide an unidentified file among the ones that genuinely carry
everything, where no reader could detect it.

### Markets and datasets

`spot`, `perp`, `future`, `option`, `tradfi`, and the dataset list in
`src/types.ts`. Hauler knows these only as the set it will accept; what each
means, and which of a venue's trees produces one, is documented in
[PROSPECTOR.md](PROSPECTOR.md).

**Margining is not a market**, which is why there is no `linear` or `futures-um`
here: those are properties of the instrument, readable from the symbol, and not a
reason for a reader to look in two places for the same kind of series. Prospector
resolves them before hauler sees anything.

### Variants

The level below the dataset, whatever that level is for that dataset: a bar
length for klines, a depth and a mode for books, an aggregation for trades, a
kind for funding.

**It arrives named**, because the catalog names it: `{ "interval": "1m" }`,
`{ "depth": "400", "mode": "incremental" }`. Hauler appends the values to the
dataset directory in the order they arrive — `klines,1m`, `books,400,incremental`
— which is the order the levels belong in. Nothing here sorts them or decides
what they mean; reordering them would rename directories on a whim.

**`aggregation: "default"` is not a claim that trades are raw**, only that it is
the flavour that venue publishes. Binance publishes both and names them, so it
alone has an `aggregated` beside a `default`; everywhere else the catalog says
nothing about aggregation because the archive does not.

**Which levels a dataset carries is a property of the dataset, never of the
venue.** A venue publishing a single book depth or a single bar length still
lands under a directory naming it: path depth that varied by venue would make
every reader branch on which venue it was looking at, and a missing level reads
as a different partition rather than the same one. Prospector is what guarantees
that, by recording the variant for every series it knows.

## The shopping list

**Fetching everything is not on the table.** The raw archives plus the vault were
estimated at 70 TB before two of the largest venues were indexed, so what gets
fetched is a choice.

It changes rarely enough that a deployed constant would have served, but the
facts database is already the pipeline's open, queryable store, so putting the
list there means a tool or a dashboard can show *what we intend to fetch* beside
*what we have fetched* — one store, one query, no second format to learn.

**A want is written in canonical names**, because those are what a person thinks
in and what the archives are arranged by. Nobody maintaining the list should have
to know that gate keeps its perpetuals in two trees.

**And it states a requirement, never an answer.**

```
topic    archives:scope    the tree the fact is about
fact     wanted            what is asserted
venue    gate
market   perp              canonical
dataset  klines            canonical, and bare
subject  —                 unused: every row here is about the same thing
period   202101..202312    the months wanted, one end or both, or blank for all
meta     { fixed, prefer } what it should get of that dataset
```

**The columns are used as columns and the rest is hauler's.** `venue`, `market`
and `dataset` are the pipeline's shared vocabulary and anything may filter on
them; `period` holds periods, as everywhere else. What has no column is the
requirement itself — `{ prefer: { interval: 'min' } }` means nothing to any other
service — so it goes in `meta`, which is exactly what `meta` is for.

The identity is `venue + market + dataset`, so there is **one row per dataset of
a venue**: two rows about one dataset would be two answers to one question.
Restating a want replaces it whatever its bounds or requirements were.

## Saying what you want, not what you found

**The requirement is the thing that stays true.** *The smallest bar length,
monthly if there is a choice, the venue-wide file if there is one* survives a
venue dropping an interval, starting to publish daily, or listing a thousand new
symbols. `1m monthly` written out instead is a want that silently fetches
nothing the day the venue moves — and nothing reports it, because a want that
matches nothing looks exactly like a venue with nothing new.

So a want carries requirements, and what they select is worked out per pass
against `GET /venues/:venue/shapes`. Two kinds:

| | |
|---|---|
| `fixed` | **this or nothing.** A depth nobody publishes fetches no files, because a caller who named one did not mean "or a different one" |
| `prefer` | **this where there is a choice.** Applied in key order, and skipped entirely where it would leave nothing |

Both are keyed by the level they constrain: `grain`, `scope`, or any level of the
dataset's own variant — `interval`, `depth`, `mode`, `aggregation`, `kind`. The
level names come from the catalog, so a dataset growing a new one needs no change
here.

```json
{ "prefer": { "interval": "min", "grain": "monthly", "scope": "bucket" } }
```

**A preference that would leave nothing is skipped.** That is the whole
difference from a filter, and the reason one sentence survives a venue
rearranging itself: no monthly rendering falls through to daily, no `1m` falls
through to whatever the finest is.

**Key order is priority order.** `{ interval: "min", grain: "monthly" }` takes
the finest bars even where that means giving up the monthly rendering; swapping
the two takes monthly even where the finest bars are only published daily.

**Ties are kept rather than broken**, so two shapes at `1m` differing only in
grain both stay candidates and the next preference decides. That is what makes
the ordering above mean something.

### `min` and `max`, and what has a size

Only a level that can be ordered has one. A bar length is a duration and a book
depth is a number; a mode, an aggregation or a funding kind is neither, so `min`
on one of those is ignored rather than resolved alphabetically.

`ticks` sorts below any bar. An unbinned series carries every event rather than a
summary of a span, so under *the smallest interval* it is the answer — which
matters for `markPrice` and `indexPrice`, where a venue may publish both bars and
ticks under one dataset.

The month is nominal — it only has to sort above a week — and `mo` is matched
before `m`, or every `1mo` would be a minute.

### What okx made concrete

okx publishes trades as one venue-wide file a day, and as per-instrument files a
month at a time. `{ prefer: { scope: "bucket", grain: "monthly" } }` takes the
daily bucket: preferring the bucket comes first, and one file a day beats two
thousand a month. Written as a resolved answer instead, that choice would have
had to be re-derived by hand every time either side changed.

### A want becomes one listing per shape

What survives resolution is a **plan** — one concrete listing — and one want can
produce several or none. Asking for klines without naming an interval asks for
every interval the venue has, and each is its own series, its own partition and
its own listing.

Each plan's fields are the catalog's own filters, so nothing is translated on the
way out:

```
GET /venues/okx/pending?market=perp&dataset=trades&grain=daily&symbol=@&month=202506
```

A plan narrowed to one variant, one grain or the venue-wide file is narrowed **by
the catalog** — the files of every other shape are never offered, rather than
being offered and discarded.

There is no upper bound unless a want states one. Hauler stops at whatever the
catalog holds.

### The API

The only thing hauler serves, because it is the only thing about hauler a person
decides.

```
GET    /wanted[?venue=gate]
PUT    /wanted   venue, market, dataset, [from], [to], [fixed], [prefer]
DELETE /wanted   venue, market, dataset
```

`fixed` and `prefer` are objects, taken from the body as they are or from the
query string as `prefer.interval=min` — because this is a list maintained by hand
as often as by script, and `curl` should be able to state a whole want.

**Nothing here interprets them.** Which keys mean something depends on what the
catalog turns out to publish, and that is `plan.ts`'s question; validating them
here would be a second opinion about it. What is checked is that they are objects
of strings, which is the only way they could fail invisibly.

`PUT` rather than `POST`, since stating a want is idempotent. Fields are taken
from the body or the query string without preference — this is a list maintained
by hand as often as by script. Every request carries `x-catalog-token`: one
secret for the pair, since anything trusted to read the catalog is trusted to say
what should be fetched from it. **An empty `CATALOG_TOKEN` takes both doors off**
— nothing is sent to the catalog and nothing is checked here — which is a
deployment's decision, warned about at startup.

**Only canonical names are accepted**, and the error names the alternatives. A
want naming `futures_usdt` is not a narrower want, it is a want in the wrong
language — the catalog would match nothing and the list would look answered.

**Nothing is validated against the catalog here**, though. Whether gate publishes
perpetual klines has an authoritative answer one HTTP call away, and a copy of it
here would be a second thing to keep in step. Resolution happens once at startup,
where it costs one request per want and names anything that found nothing.

## Order and parallelism

```
venue ─┬─ month ─┬─ dataset ─┬─ url page ─┬─ fetch
       │         │           │            ├─ fetch
       │         │           │            └─ fetch  (concurrent)
       │         │           └─ next page…
       │         └─ next dataset…
       └─ next month…
```

**The order is the point, not an implementation detail.** The unit that matters
downstream is a `dataset + month` partition, and a partition is only useful once
it is *complete* — stocker cannot import half a month. Interleaving datasets or
periods would leave many partitions in progress and none finished, which is the
slowest possible route to the first usable thing.

Each venue is an independent worker; venues share nothing and never wait on each
other, because they are unrelated hosts with unrelated limits. Concurrency is
bounded per venue, so a slow venue holding sockets open cannot starve a fast one.

**One listing can be several partitions.** A canonical partition is named by what
a file *is*, and two variants can share one catalog `(market, dataset)` — bybit's
two book depths, binance's mixed liquidation tree. So what completes is whatever
was actually named, not what was asked for.

## Verifying what was fetched

The size and the etag come with every URL. Hauler checks every file it holds
against them — the one cheap integrity signal available, and the one that makes
the whole arrangement self-correcting.

| the file | matches | |
|---|---|---|
| just fetched | yes | it downloaded, and that is all |
| already on disk | yes | **it downloaded** — the self-healing case |
| already on disk | no | discard it and treat it as never downloaded |
| just fetched | no | **report the discrepancy**, store nothing, leave the partition open |

**The second row is why nothing needs repairing by hand.** A file present and
correct is confirmed whatever the catalog previously believed, so a download
recorded and then lost, or performed and then forgotten, resolves itself the next
time its partition is listed. No migration, no reconciliation script, no separate
fixing of the database — and a machine whose archive is already on disk can be
adopted with no seeding step at all.

**The fourth row never resolves itself and must not pretend to.** Nothing is
kept, nothing is stated, and the partition stays open until the two services
agree.

The size is checked first because it costs a `stat` and rules out almost every
disagreement; the digest is computed only when the size agrees and the etag is
actually a digest. A multipart etag carries a `-partcount` suffix and digests the
list of parts rather than the bytes, and several venues publish none — neither is
evidence against a file, only an absence of evidence for it. Etags are compared
unquoted and case-blind, since okx serves the same digest in opposite cases from
its two clouds.

**Nothing appears at its final path until it has been checked.** Every download
lands as a `.part` file and is renamed only once it verifies. Verifying after the
rename would leave a truncated file at the real path, where every later pass sees
it present and skips it, permanently and silently.

## Failure, and how a partition finishes

**A URL gets three attempts.** After that it is not hauler's problem to solve
alone: the key is reported, and prospector goes and asks the venue whether it is
really there. Retrying harder would only make hauler more confident about
something it cannot check.

**A partition with failures is not complete.** Hauler asks for it again in a few
minutes, and one of two things happens: the catalog still asserts the files exist,
so they come back in the list and hauler tries again; or the catalog has since
ruled them absent, so nothing is outstanding and the partition completes.

So completion is never hauler deciding it has waited long enough. It is the two
services agreeing — either the file arrives, or the catalog withdraws the claim.

**Persistent disagreement blocks the month, and that is the right outcome.** The
file either exists or it does not, so a disagreement that survives repetition
means one of the two services is wrong, and a loop that visibly refuses to finish
is a better signal than a partition quietly marked complete with a hole in it.

### How not to write the retry

**The catalog's answer can be stale, and that is harmless.** Confirming a file is
really gone means probing the venue, so the next listing can arrive carrying the
claim that was just disputed. Hauler reports it again. Nothing is lost and the
loop converges as soon as the catalog has done its work.

**So the only real failure mode is impatience.** Two rules follow.

*Do not spam.* A partition that reported a discrepancy is set aside for a few
minutes, and the time is spent on other partitions — there are always others, and
a venue worker blocked on one is a venue worker doing nothing.

*Never fail after N identical answers.* The tempting counter — "the catalog said
the same thing five times, so give up" — is wrong twice over. It is unpredictable,
since how many repetitions occur depends on how fast prospector probes and how
often hauler asks, neither of which means anything; and it converts a recoverable
disagreement into a permanent one at an arbitrary threshold.

## One fact, and where everything else already lives

**Almost nothing needs publishing, because the catalog already knows it.** Which
files were downloaded, exactly when, their sizes and etags are all there, per
file. Copying any of it into the facts database would be a second copy of a live
table, free to disagree with the first and with nothing to say which is right.

What is *not* derivable is when hauler considered a partition finished. That is
the one fact:

```ts
facts.record({ topic: 'archives', venue: 'bitget', period: '202008',
               market: 'perp', dataset: 'klines', subject: '1m',
               fact: 'complete', value: new Date().toISOString() });
```

The variants go in `subject`, which is for what only the owner knows the shape
of: `1m` means something to klines and nothing to anybody else, so it belongs
there rather than in a column every other topic would leave blank.

### What one timestamp buys downstream

The completion time is a **version**, and comparing one value replaces comparing
two lists. Stocker records the completion time it built against; a newer one
means the partition was reopened and rebuilt, so its own output is stale. **So
stocker stops tracking which files went into a partition**, and so does cold
storage — neither needs a membership list to know work must be redone.

**A revision is covered by the same mechanism.** When a venue republishes a file,
the catalog clears its `downloaded_at`, the partition stops being complete, and
everything above follows with no special case.

### Why the finer grain is a requirement, not a refinement

Trucker's grain — venue plus month — made sense under trucker's assumption: fetch
everything from every venue, in order. Then a venue's month really does become
complete once and stay that way.

**That assumption is dead.** What gets fetched is now a choice, so under venue +
month, taking a new dataset later means reopening a month already declared
complete. That ripples: stocker rebuilds partitions it had finished, cold storage
restores what it had evicted, and every consumer that trusted "complete" was told
something provisional.

A *dataset's* month does not have that problem. Once `bitget / 202008 / klines,1m`
is complete it is complete for ever, because nothing later belongs to it.
Deciding to take `trades` next year creates a new partition rather than
invalidating an old one.

### Two owners on one topic

`archives` is owned by both `trucker` and `hauler` while one replaces the other.
They fill the same tree and say the same kind of thing about it, so the tree keeps
one meaning and the handover needs no migration. A list of owners is still an
enumeration — a service not on it cannot write there — and trucker's entry goes
when trucker does.

## What the catalog serves

All of this is prospector-side and implemented. **The endpoints, their parameters and their
responses are in [CATALOG-API.md](../modules/CATALOG-API.md)**; what matters here is which of them
hauler leans on and for what.

| | |
|---|---|
| `GET /venues/:venue/shapes` | what the venue publishes, which is what a want is resolved against — see above |
| `GET /venues/:venue/pending` | one `dataset + month` partition at a time, narrowed to one resolved shape |
| `POST /venues/:venue/report` | `downloaded`, `failed` and `mismatched` — the handshake that lets a partition finish |

**Three lists in the report rather than two**, because "did not arrive" and "arrived wrong" are
different claims prospector acts on differently. Neither is taken at face value: a key reported as
undownloadable is checked against the venue and either stays owed or is ruled absent, and a mismatch
is confirmed the same way. Hauler reports problems; the catalog rules on them.

**A pending item states what the file is**, so hauler never parses a URL — canonical market, dataset
and variant, the venue's own symbol, the period and the extension. That is the whole reason the
listing exists in this shape: a downloader that read paths would have to learn every venue's tree and
be taught again whenever one moved.

### "Is this partition complete?"

The listing query stopped at the first row. The obvious endpoint — *list the
complete partitions* — is the expensive one: it has to examine every partition and
prove none of its files is still owed. Turned around it is one indexed lookup with
a `LIMIT 1`, and because it is computed rather than stored it is true at the
moment it is asked.

## Adopting an archive that already exists

Hauler decides a file is already downloaded by looking at the path that file
would occupy — so an archive already on disk under canonical names needs no
seeding, no import and no bookkeeping. The first listing that covers it finds
every file present, verifies each against the catalog's size and etag, and
reports them downloaded. That is the self-healing row of the verification table
doing the whole job.

**Which makes placing an existing archive a pure naming exercise.** Prospector
already maps a URL to `venue + market + dataset + symbol + tag + date`; hauler
already maps those to a path. Anything that can put a file where hauler expects
it is replaying that pair of mappings over files that are already downloaded —
and the two services between them are the definition of where a file belongs, so
there is no second rule to keep in step.

## What "complete" means while the catalog is still filling

**Nothing.** Hauler completes what the catalog gave it; whether the catalog had
found everything by then is the catalog's business and the consumer's caution.

This is affordable because every stage records what it processed. If prospector
discovers new URLs for a partition already downloaded, imported and cold-stored,
the evidence to detect that is on disk in the facts database — a tool can compare
and either raise it or repair the pipeline for that partition.

## Open

**Whether the vault adopts the same interval vocabulary.** The archives
canonicalise; stocker still writes whatever a venue's path captured, so
`interval=7d` and `interval=1w` can both exist in the vault for the same
duration. Worth reconciling, and not as a side effect of anything here.
