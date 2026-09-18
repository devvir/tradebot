# Catalog API

Everything prospector serves, in one place. **This is the reference — other docs
link here rather than restating it**, so an endpoint cannot be described in two
places and drift.

Served by the `prospector` service on `CATALOG_PORT`. Prospector is the only
process that opens the catalog database, so every question and every change any
other service has arrives here — including from another machine, since surveying
is expected to run where the link to the venues is good rather than where the
downloading happens.

## Conventions

**Authentication.** Every request carries the shared secret in an
`x-catalog-token` header. A wrong token and a missing one answer `401` alike.
Not authentication so much as a closed door: there are no users and no sessions,
and what it protects against is the port being reachable by something with no
business writing here.

**An empty `CATALOG_TOKEN` removes the door**, and every request is let through
with no header at all — which is what makes these endpoints readable straight
from a browser. Suitable where nothing else can reach the port, and warned about
at startup so it cannot be the state nobody chose.

**A venue is a venue.** Bybit publishes its order books on a second host, and
that is prospector's business: it appears in no path, no parameter and no
response field. A caller asks about `bybit` and gets bybit.

**A file is named by an opaque `key`**, handed out by a listing and echoed back
exactly. A path alone could not say which of a venue's hosts a file came from,
and making callers model that would put storage arrangements into everyone
else's head. A malformed key is a `404`, never an error.

**Canonical names, never the venue's own.** `market`, `dataset` and `variant`
are the catalog's vocabulary — `perp`, `klines`, `1m` — and the translation from
`futures_usdt/candlesticks_1m` stops inside the adapter that read it. See
[PROSPECTOR.md](../services/PROSPECTOR.md) for how that mapping works.

**`variant` is the level below the dataset, whatever that level happens to be.**
For klines it is the bar length; for books it is the depth and the kind; a
dataset that needs two of them carries both, comma-separated, in one string
(`500,incremental`). It is deliberately one generic field rather than an
`interval` column and a `depth` column and whatever the next dataset needs —
those are properties of particular datasets, not of the catalog. A dataset with
no level below it has no variant at all.

**Collections answer `{ "items": [...] }`.** Single resources answer the object
itself. Errors answer `{ "error": "..." }` with a fitting status. The bucket
listing is the exception: it answers in S3's shape, errors included — see
[Buckets](#buckets).

## Endpoints

### Reading what exists

| | |
|---|---|
| `GET /venues` | Every venue that can actually be worked on, with its totals and `established`. A venue registered without a scanner would be absent rather than listed as empty; all eight have one today. |
| `GET /venues/:venue/shapes` | **What this venue publishes** — every `(market, dataset, variant, grain)`, with counts and span. Same filters as a listing. |
| `GET /venues/:venue/months` | One row per month, with `state`, counts and bytes. Filters: `state`, `from`, `to`, `in` (comma-separated). |
| `GET /venues/:venue/months/open` | The same, narrowed to months with work outstanding. |
| `GET /venues/:venue/months/closed` | The same, narrowed to months with none. |
| `GET /venues/:venue/months/:month` | One month as a resource: the object, or `404`. |
| `GET /status` | The cached figures per venue, plus whether a survey is running. `venue` narrows it. |

A venue row carries `venue`, `firstMonth`, `lastMonth`, `files`, `bytes`,
`pending`, `pendingBytes`, `withdrawn`, `established` and `lastRun`. A month row
carries `month`, `state` and the same five figures.

`lastRun` is the venue's **most recent pass**, whether or not it ended:
`{ kind, at, startedAt, ongoing }` — `walk` or `update`, when it finished, when
it began, and whether it is still going on any of the venue's hosts. It answers
what `established` cannot: that is a completion time, so a venue three hours into
its first walk has none and is indistinguishable from one nobody has ever
surveyed.

**`startedAt` is the run's own start, and `since` below is not.** Where a venue
is paused, `since` holds when it was *stopped* — so a caller wanting "this
update began at" would read the pause time and label it a beginning. A pause
neither closes a run nor undoes one, so it changes nothing here.

`GET /status` adds where each venue stands, which `GET /venues` does not:

| | |
|---|---|
| `state` | `not started`, `starting`, `walking`, `updating`, `waiting` or `paused` |
| `enrolledAt` | when somebody first asked for this venue. `null` where nobody has |
| `since` | when the open job began — or, where paused, when it was stopped |
| `during` | what a pause interrupted, so a reader knows what resuming returns to |
| `nextRun` | when the next update falls due, where the venue is waiting for one |
| `surveying` | whether **this process** has a loop alive |
| `stopping` | asked to stop, still finishing the page it was on |
| `listable` | whether there is a keyspace to walk. `false` where the bucket refuses a listing |
| `wip` | rows discovered but not yet established |

**`listable` is what makes `refresh` offerable or not.** A venue whose bucket
serves no listing has no keyspace: its series are declared and every pass is an
update over them, so dropping its run rows leaves a walk with nothing to walk.
Callers read it to withhold the action rather than to discover afterwards that it
did nothing.

**`state` and `surveying` are deliberately side by side**, because they are
different facts: the first is work the catalog has outstanding, the second is
whether anything is doing it. Walking with `surveying: false` is what a killed
container leaves behind, and the one worth acting on.

**`paused` and `waiting` are not the same idle.** One is a person's decision that
survives restarts; the other is a schedule. Both have no open job, which is
exactly why the state is read from `survey` and `run` together rather than from
either alone.

**`starting` is the one state the rows cannot say.** A pass lists instruments and
writes new series before it opens a job, and until then its rows read exactly as
a venue asleep between passes — four minutes, on binance, for an update somebody
had just ordered. So it comes from the process instead: a pass under way with no
job open yet. It lasts until the job opens, and `nextRun` is `null` for it,
because the next pass is not the one that matters any more.

### Deciding what to ask for

**`GET /venues/:venue/shapes` is the research endpoint**, and the one to reach
for before wanting anything — one row per distinct thing the venue publishes:

```json
{ "market": "perp", "dataset": "klines", "variant": { "interval": "1m" },
  "grain": "daily", "symbols": 1487, "buckets": 0,
  "first": "20190423", "last": "20260830", "open": true }
```

| | |
|---|---|
| `symbols` | named instruments carrying it |
| `buckets` | venue-wide files carrying every instrument at once — the `@` symbol |
| `first` | the oldest period anything of this shape covers |
| `last` | the newest file anybody has seen of it. **A measurement** — `null` means nothing has ever been seen, and nothing else |
| `open` | whether the catalog **still expects files** for it. True while any one of its series is |

`last` and `open` are separate because they are separate facts: where the shape has
reached, and whether it has stopped. They were one field, with `last: null`
standing for "still publishing", which threw the measurement away to make the
claim — every shape reported no end at all, and a variant that stopped beside the
one that replaced it was unreadable.

**`open` is the same question prospector asks before generating a key**, so a
shape reported open is one requests are still going out for. A consumer deciding
what to fetch reads `open`; one deciding what range to ask for reads `first` and
`last`.

**Nothing here describes how the venue arranges its URLs**, and that is the
catalog's job rather than a gap in it. Whether a dataset changed its path once or
a thousand times is prospector's business; where two shapes would be the same
data twice, one of them is offered and the other never surfaces. What a shape
does distinguish is **variants of a dataset** — never the same data under two
names.

So a variant that stopped and one that replaced it are two rows with adjacent
spans, which is the answer a consumer needs:

```json
{ "dataset": "books", "variant": { "depth": "500", "mode": "incremental" },
  "first": "20230118", "last": "20250820", "open": false }
{ "dataset": "books", "variant": { "depth": "200", "mode": "incremental" },
  "first": "20250821", "last": "20260830", "open": true }
```

Bybit changed the depth of its perpetual books on 2025-08-21, for every
instrument at once. Fetching both rows is how a consumer gets the whole span;
fixing on one depth is how it gets half.

Narrowed by the same filters a listing takes — `market`, `dataset`, `variant`,
`grain` — so the questions people actually have are one request each:

```
?dataset=klines            which bar lengths does this venue publish?
?dataset=trades            are its trades filed monthly, daily, or both?
?dataset=books             does it have books, at what depths, and which mode?
?dataset=trades&grain=daily  …and is there a venue-wide file, or 2,000 of them?
```

Answered from patterns and series — thousands of rows where files are millions —
so it costs nothing to ask.

### Walking it instead

The same rows, one level at a time, for finding your way rather than filtering:

```
GET /contents/venues                                        every venue
GET /contents/venues/:venue                                 its markets
GET /contents/venues/:venue/symbols                         every instrument
GET /contents/venues/:venue/markets/:market                 shapes, as above
GET /contents/venues/:venue/markets/:market/symbols         its instruments
```

A market row names its datasets and sizes each one, because a single count for
the market is unreadable — binance's perpetuals are 130 shapes, and that number
alone does not say it is four datasets at fifteen bar lengths filed two ways:

```json
{ "market": "perp", "symbols": 1354,
  "datasets": [
    { "dataset": "klines", "shapes": 30, "grains": ["daily", "monthly"],
      "variants": ["12h", "15m", "1d", "1h", "1m", "…"], "symbols": 1289 },
    { "dataset": "funding", "shapes": 1, "grains": ["monthly"],
      "variants": ["realised"], "symbols": 550 }
  ] }
```

**Symbols are not paged.** The largest answer is a few thousand strings, and it
is asked by somebody deciding what to fetch rather than in a loop. The venue-wide
file is not among them — `@` is the catalog's own name for a file carrying every
instrument at once, and `buckets` on a shape is where that is reported.

**Every level is a projection of one read**, so no two of them can disagree about
whether a retired pattern counts or what an unstated end means. There is no
`/datasets` level below the market: it would carry the same rows grouped, and
`/datasets/:dataset` the same rows filtered — a query parameter wearing a path
segment.

**One endpoint at the finest grain**, rather than a coarse one beside it. A
caller wanting only the `(market, dataset)` pairs collapses the rows it gets; two
endpoints where one is a `GROUP BY` of the other would be two things to keep
true.

### Listing files

**The listing this API exists for.** A caller names what it wants in the
catalog's own vocabulary and is answered with URLs that work — never having to
know which tree a venue files things under, how it spells an interval, or where
the date sits in a name.

| | |
|---|---|
| `GET /venues/:venue/files` | Every file the catalog holds, narrowed by any of the filters below. |
| `GET /venues/:venue/pending` | The same handler with `downloaded=false` fixed. |

| filter | | |
|---|---|---|
| `market` `dataset` `variant` | canonical, case-blind | `perp`, `klines`, `1h` |
| `symbol` | the venue's own name; repeatable **or** comma-separated, case-blind | `BTCUSDT,ETHUSDT` |
| `grain` | which rendering of the data | `monthly` `daily` `hourly` `minutely` |
| `month` | a whole calendar month, whatever grain its files are in | `202406` |
| `from` `to` | bounds in each series' own grain, for callers that mean exactly that | |
| `downloaded` | `true`, `false`, or **absent for either** | |
| `after` `limit` | paging | |

**Absent means *any*.** No filters at all is the whole venue. The one exception
is an explicit set that matches nothing — naming instruments a venue does not
publish is a filter that matched nothing, and is answered with nothing rather
than with the whole venue.

**`grain` is the filter worth knowing about.** Many venues publish the same data
both monthly and daily, so a caller asking for June trades without saying which
gets the monthly file *and* every day of June — the same trades twice. Asking for
both is legitimate, which is why nothing is defaulted; a caller that already
knows which it wants says so.

An unknown `grain` answers `400` rather than silently matching nothing, since it
can only be a caller's typo.

**`grain` is the size of the thing; `period` is which one.** A monthly series has
a grain of `monthly` and a period of `202506`. The two words are kept apart
deliberately, because one string having both meanings is how a filter for "the
monthly rendering" and a filter for "June" get confused.

Each item states **what the file is**, so its reader never parses a path:

```json
{ "key": "…", "url": "https://…", "market": "perp", "dataset": "klines",
  "variant": { "interval": "15m" }, "symbol": "BTC-USDT", "date": "20250601",
  "ext": ".zip", "part": "001", "size": 12345, "etag": "…", "tag": null,
  "venueId": 1, "path": "…", "seriesId": 28867, "downloadedAt": null }
```

`market`, `dataset`, `variant` and `symbol` are read off the series — the same
values you filtered by, spelled the way you asked.

**`variant` is an object naming each level**, because `400,incremental` is two
facts about a book and choosing between depths should not mean splitting a comma
and counting positions:

| dataset | variant |
|---|---|
| `klines`, `markPrice`, `indexPrice`, `premiumIndex` | `{ "interval": "1m" }` |
| `books` | `{ "depth": "400", "mode": "incremental" }` |
| `trades` | `{ "aggregation": "default" }` or `"aggregated"` |
| `funding` | `{ "kind": "realised" }` |
| `quotes`, `liquidations`, `borrowing`, … | absent — no level below the dataset |

The keys come in the order the levels belong in, so anything rebuilding a path
can join the values as they arrive.

**`aggregation: "default"` claims only "the one this venue publishes"**, never
that it is raw. Most venues publish one flavour of trades and say nothing about
whether it is already aggregated, so the catalog stores nothing and reports the
default; binance publishes both and names them, so its raw feed is `default` and
its `aggTrades` is `aggregated`. `aggTrades` is not a dataset — it is binance's
word for one rendering of trades.

`part` is where a venue splits a period into pieces, as bitget's trades are.
`symbol` is always the venue's own name for the instrument, never the archive's
spelling — okx serves a futures family as `<name>-futureschain`, and that fact
about its URLs stops at this boundary. `@` means one file carrying every
instrument of a market.

**An empty `symbol` is neither of those**, and is the one case a caller has to
handle rather than file. It means this file has no series — catalogued before its
venue's patterns could be read — so `market`, `dataset` and `variant` are blank
beside it. The file is real and still owed; what is missing is any statement of
what it *is*. Treating that as `@` would file an unidentified file among the ones
that genuinely carry everything.

`downloadedAt` is when the file was recorded as being on disk, or `null` while it
is still owed — which is what makes a listing that is not scoped to one state
readable.

A row whose series was never resolved answers blanks rather than being withheld:
the file is real and still owed, and a downloader that cannot place it says so
far more usefully than a listing that silently omitted it.

**`month` is the filter that means what a caller usually wants.** `date` holds
each series' own grain — `202506` monthly, `20250601` daily, `2025060113`
hourly, `202506011345` per minute — so an inclusive `to` of `202506` sorts below
every daily file of that month and silently drops all of them. `month` becomes an exclusive bound at the next one,
catching both. `from` and `to` remain for callers that mean exactly what they say.

Paging is by opaque cursor: a response carries `next`, which is passed back as
`after`. `limit` defaults to 1000 and is capped at 10,000 — asking past the cap
gets the cap, since a client's mistake stays the client's. A narrowed listing
pages series by series rather than along one ordering across the venue, which the
cursor carries for you.

### Downloading

| | |
|---|---|
| `POST /venues/:venue/report` | What became of a page: `downloaded`, `failed`, `mismatched`. |
| `POST /venues/:venue/downloaded` | Record a batch as on disk: `keys`, plus optional `observed` per key. |
| `POST /venues/:venue/downloaded/:key`<br>`DELETE /venues/:venue/pending/:key` | One file, on disk. The same move named twice. |
| `POST /venues/:venue/pending/:key`<br>`DELETE /venues/:venue/downloaded/:key` | One file, owed again. |
| `PATCH /venues/:venue/files/:key` | Correct what is recorded, outside the download flow. `200`, or `409` if unconfirmable. |

**Reporting is not transactional with the download, on purpose.** A file fetched
but never reported comes round in the next batch, where the downloader finds it
already on disk and reports it then — which is also what lets a machine whose
archive is already there be adopted with no seeding step.

**The caller reports problems; the catalog rules on them.** Nothing a caller
sends is taken as fact about a venue: a key reported as undownloadable is
checked against the venue, and either stays owed or is ruled absent. A mismatch
is confirmed the same way, and what the venue says is what gets recorded. That
division is what lets a disagreement stay visible instead of being settled by
whoever wrote last.

### Buckets

Each venue as a storage bucket. The listing has S3's shape, and every object is
keyed by what the file *is*. This is what a downloader walks: it writes each
object at its key, so it needs no vocabulary of its own.

| | |
|---|---|
| `GET /buckets/:venue` | One page of the bucket, in key order. |
| `POST /buckets/:venue/report` | What became of a page, by `FileId`. |

```
GET /buckets/binance?pending=true&max-keys=1000&marker=<last key>
x-catalog-lens: backfill-20
```

**The key is the canonical archive path**, the same one on every venue:

```
market/dataset[,variant]/YYYYMM/F/symbol/venue|market|dataset[,variant]|symbol|period[|part].ext

perp/klines,1m/202001/B/BTCUSDT/binance|perp|klines,1m|BTCUSDT|20200101.zip
perp/quotes/202001/B/BTCUSDT/binance|perp|quotes|BTCUSDT|20200101.zip
```

A dataset with no variant has no comma. `F` is the symbol's first letter in
upper case, or `_` where it is not a letter. The variant's values are joined in
the order their levels belong in. Keys sort as bytes, as S3's do, so
`trades,default/` comes before `trades/`.

**`ListObjects` V1 by default, V2's shape with `list-type=2`.** Both resume
after an exact key, so they are one listing with two spellings:

| | V1 | V2 (`list-type=2`) |
|---|---|---|
| resume after | `marker` | `continuation-token`, or `start-after` on the first page |
| more to come | `IsTruncated`, `NextMarker` | `IsTruncated`, `NextContinuationToken` |
| also answered | `Marker` | `KeyCount`, `ContinuationToken`, `StartAfter` |

`max-keys` is 500 unless asked for, and 1,000 at most. Asking past the cap gets
the cap, and anything that is not a whole number from 1 is a `400`. `prefix`,
`delimiter`, `encoding-type` and `fetch-owner` are not implemented yet.

**XML unless JSON is asked for.** With no `Accept` header, or one that prefers
XML, the answer is S3's `ListBucketResult`. With `Accept: application/json`, it
is the same fields under the same names, as one object. An error takes S3's
`Error` shape with a `Code` and a `Message` in either format: `NoSuchBucket`
(404), `NoSuchLens` (404) or `InvalidArgument` (400). An ETag keeps S3's quotes
as part of its value, so in XML it reads `&quot;…&quot;` and in JSON `"\"…\""`.

**Each object carries `Key`, `FileId`, `Url`, and, where the catalog knows
them, `ETag`, `Size` and `LastModified`.** `FileId` is not S3's: it is the
catalog's own number for the file, and what everything outside the S3 listing
names a file by — a report above all. The key is the listing's identity and its
cursor; it runs to hundreds of bytes, so it is not asked to be anything else. A
`FileId` stays the file's for as long as the file exists, which holds because
the catalog never runs a full `VACUUM`. `BaseUrl` joined to `Url` is the address of the
file. When every object on a page lives under one base, `BaseUrl` is that base
and each `Url` is the rest. When a page mixes a venue's hosts, `BaseUrl` is
empty and each `Url` is complete.

**Two filters S3 does not have.** Each one leaves files out, as though the bucket
did not hold them:

| | |
|---|---|
| `pending=true` | only files not yet downloaded |
| `x-catalog-lens: <slug>` | only what that [lens](#lenses) lets through. Absent means every file; an unknown slug is a `404`, never the whole bucket |

A walk is a cursor over keys, so a file catalogued behind the cursor is listed
by the next walk, as on any bucket.

**A report is the same as `POST /venues/:venue/report`, by `FileId`**, and the
catalog settles it the same way:

```json
{ "downloaded": [4815162, "…"],
  "failed":     [4815163],
  "mismatched": [{ "FileId": 4815164, "Size": 506, "ETag": "…" }] }
```

The answer counts what was recorded, plus `unknown`: ids that name no file of
this venue. They are otherwise ignored. A report holds at most 10,000 files.

### Exclusions

| | |
|---|---|
| `GET /venues/:venue/exclusions` | The listed half of exclusion, with `key`, `path` and `reason`. |
| `POST /venues/:venue/exclusions` | Add one. `path` and `reason` both required. |
| `DELETE /venues/:venue/exclusions/:key` | Lift one, by the key the listing handed out. |

**The half of exclusion that can only be listed.** A truncated copy of the wrong
file at a real URL is not a pattern and the next one will not resemble it, so
these are rows — finding a bad file costs a request rather than a redeploy.
Anything that *can* be described belongs in an adapter's `accepts`, in code,
where it also covers keys nobody has published yet.

Adding applies to **every server of the venue**, so a caller never has to know
one of them is served from two machines. Nothing already catalogued is removed:
this says what must not be *fetched* again.

### Surveying

| | |
|---|---|
| `POST /surveys` | Start or continue. `venue` optional — a name, several, or absent for all. |
| `POST /venues/:venue/surveys` | The same, for one venue named in the path. |
| `POST /surveys/pause` | Stop where it is, keeping every cursor. Same `venue` argument. |

**One verb, because where a venue has got to is not a caller's decision.** A
venue with nothing starts; one with work outstanding continues from its cursors;
one already complete finds what has appeared since. And it does not stop: a
surveyed venue keeps itself current, walking once and then updating daily,
**across restarts**, until it is paused or refreshed.

Starting a venue is what **enrols** it, and a restart carries on with whatever is
enrolled: an open job resumes from its cursors, a venue between passes waits out
the rest of its interval, a paused one stays paused, and a venue nobody ever
asked about is left alone for ever. So a deployment where nobody has started a
survey is read-only, permanently and by construction.

#### The two modifiers

| | |
|---|---|
| `refresh: true` | Throw the progress away and walk it all again. |
| `update: true` | Skip the wait and update now. |

`refresh` is opt-in precisely so an ordinary request can never silently discard a
backfill in flight.

`update` acts in one state and a half. It is **refused where no pass has ever
completed** — a venue mid-walk or one never run is owed the walk it is already
doing — and does **nothing where an update is already running**. What is left is
a venue waiting out its interval, and one **paused partway through an update**,
which it resumes: that case comes back in `resumed` rather than `started`,
because carrying on from cursors that already exist is not the same thing as
planning fresh scopes, however alike they look from here.

Whether a venue is paused is not the question — what the pause interrupted is. A
pause during the walk is refused for the ordinary reason.

The two are mutually exclusive: one discards the progress the other builds on, so
a request asking for both is a `400`. A forced update that started and resumed
nothing is a `409` carrying the reason, because the one thing it was for did not
happen.

**They are also the only requests that interrupt a venue already surveying**,
which they have to be: the loop does not end on its own, so refusing on that
ground would make a refresh impossible for ever after the first survey, and a
forced update useless in the one state it exists for — since what it skips is a
wait the loop is in the middle of. An *ordinary* request on a running venue is
answered `already running`, which is a statement that the work is happening
rather than a refusal.

The `phases` field is read off whichever kind of run a venue actually does. Most
are walked; okx and bitget have no keyspace to list and only ever generate keys
from their series, so theirs is read off their `update` rows instead. `not run`
therefore means a venue that has genuinely never been surveyed, not one that
cannot be walked.

`POST /venues/:venue/surveys` is a **shortcut, not a second endpoint** — the
venue moves from the path into the same argument the body form fills, so phases,
`refresh` and refusals are identical by construction. Where both name a venue,
the path wins.

Both answer as soon as the work is under way rather than when it ends: a survey
runs for hours, and `GET /status` is where its progress lives. The reply carries
`started`, `resumed`, `skipped` (with a reason each) and `phases`.

A pause keeps every cursor, which is why there is no matching resume verb:
starting a paused venue *is* resuming it — to what the pause interrupted, so a
venue paused while waiting goes back to waiting. It is also **permanent until then**,
and survives a restart — the pause is a row, not a flag in memory, so a
deployment that comes back up does not restart a venue somebody deliberately
halted.

### Lenses

A **lens** is a named way of looking at the catalog. Where one is in force, what
it lets through *is* the catalog as far as that consumer is concerned; the rows
underneath stay complete and unfiltered.

| | |
|---|---|
| `GET /lenses` | Every lens, newest first. |
| `GET /lenses/:slug` | One, by the address a consumer is configured with. |
| `POST /lenses` | Create one. `slug` required; `name`, `note` and `definition` optional. |
| `PUT /lenses/:slug` | Replace it whole — `slug`, `name`, `note`, `definition`, or any of them. |
| `DELETE /lenses/:slug` | Delete it. |
| `GET /lenses/options/:venue` | The combinations that venue publishes — `market`, `dataset`, `variant`, `grain`, and how many series each holds. What a rule is written against. |
| `POST /lenses/check` | What is wrong with a definition, without storing it. |
| `POST /lenses/size` | What a definition would put on a disk: `series`, `files`, `bytes`, `exact`. |
| `GET /lenses/:lens/size` | The same, for one that exists. |
| `POST /lenses/resolve` | What it actually selects, per venue: how many series, and the date spans. |

**Addressed by `slug`, never by number**, in every path. A lens carries three
names and they do different jobs: `slug` is what a consumer is configured with and
what every path addresses, so it is stable; `name` is what a person calls it, free
text and free to change; `note` is what it is for. Addressing by `name` would mean
renaming a lens reconfigures whoever reads through it.

**A consumer reads through a lens by naming it** in an `x-catalog-lens` header.
The [bucket listing](#buckets) honours it. An unknown slug is a `404` rather
than the unfiltered catalog.

**Read whole, written whole.** There is no `PATCH` of a single rule, which is why
rules carry no ids and their position in the array identifies them. Last write
wins.

### The definition

```jsonc
{
  "format": 1,
  "venues": {
    "bitget": [
      { "effect": "include", "to": "202012" },
      { "effect": "exclude", "datasets": [{ "dataset": "books" }] },
      { "effect": "exclude", "datasets": [{ "dataset": "trades" }], "from": "201901" }
    ]
  }
}
```

**Keyed by venue name**, never by id: an id names a *host*, and bybit publishes
its books from a second one.

**`*` holds rules about every venue, and they apply before that venue's own.** A
lens whose only rule is global reaches venues it never names — including ones
added later.

**Rules apply in order, starting from nothing.** `include` adds what it matches,
`exclude` takes it away — so a list that opens with `exclude` lets nothing
through.

**A rule states only what it constrains.** An absent dimension means all of it, so
`{ "effect": "include", "datasets": [{ "dataset": "trades" }] }` is every market,
grain and instrument of every variant of trades, for all time.

| field | matched against |
|---|---|
| `markets`, `grains` | the pattern's own |
| `datasets` | a list of `{ dataset, variant? }`. An absent `variant` is every variant of that dataset |
| `instruments` | the series' symbol. `@` is the venue-wide file, and an ordinary value here |
| `from`, `to` | months, `yyyymm`, inclusive; absent is open |

**A variant belongs to its dataset**, which is why the two travel as a pair. `1m`
is a kline length, `full,incremental` a book shape, and trades have variants of
their own — so two flat lists could not say *one length of kline, and every
trade*, which is an ordinary thing to want:

```jsonc
"datasets": [{ "dataset": "klines", "variant": "1m" }, { "dataset": "trades" }]
```

Because rules compose, a later one can carve a hole in an earlier one's range, so
a lens resolves to a **list of spans per series** rather than one range.

**Sizing is why a lens is decidable**, so it is answered while somebody is still
choosing. A selection of at most a few hundred series is counted from the files
themselves; beyond that it is estimated from a sample of series and marked
`exact: false`.

**A definition that claims more than a venue publishes is refused**, with `400`
and a `problems` list. Each problem names the venue, the rule's position and, where
one part is at fault, the field — so an editor can put it where the choice was
made. `POST /lenses/check` answers the same thing without storing, which is what a
form asks on every change.

## Errors

| | |
|---|---|
| `400` | a malformed body — `keys` not an array, a required field missing, a batch over 10,000 — or an unknown `grain` |
| `401` | the token is wrong or absent |
| `404` | no such venue, month, file, exclusion or lens; also a key that decodes to nothing |
| `409` | a correction the venue would not confirm; a forced update with nothing to update; a lens address already taken |
| `413` | a body over 5 MB — room for a 10,000-key report |
| `500` | a fault in this service — the log keeps the whole of it, the response says nothing |
