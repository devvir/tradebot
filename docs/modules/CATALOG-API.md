# Catalog API

Everything the `catalog` service serves, in one place. **This is the reference — other docs link here
rather than restating it**, so an endpoint cannot be described in two places and drift.

Containers on the shared network reach it as `catalog:8080`; the host reaches it on `CATALOG_PORT`,
bound to `CATALOG_BIND` (`127.0.0.1` unless set). It reads the catalog prospector writes, and hands
every write it is sent to prospector. Prospector's own API (starting and pausing surveys, settling
reports, storing lenses) is private to the [archives module](ARCHIVES.md) and documented in
[PROSPECTOR.md](../services/PROSPECTOR.md#the-api).

## Conventions

**Authentication.** Every request carries the shared secret in an `x-catalog-token` header. A wrong
token and a missing one answer `401` alike, before anything else is read. Not authentication so much
as a closed door: there are no users and no sessions, and what it protects against is the port being
reachable by something with no business here.

**An empty `CATALOG_TOKEN` removes the door**, and every request is let through with no header at all,
which is what makes these endpoints readable straight from a browser. Suitable where nothing else can
reach the port, and warned about at startup so it cannot be the state nobody chose.

**A venue is a venue.** Contents, lenses, paths and parameters are by venue name, whichever servers
the venue publishes from; only `hosts` on a venue row and `Host` on a listed object say which server a
file is on.

**Canonical names, never the venue's own.** `market`, `dataset` and `variant` are the catalog's
vocabulary (`perp`, `klines`, `1m`); the translation from a venue's own naming, such as gate's
`futures_usdt/candlesticks_1m`, is prospector's and ends there. See
[PROSPECTOR.md](../services/PROSPECTOR.md).

**`variant` is the level below the dataset, whatever that level happens to be.** For klines it is the
bar length; for books it is the kind and the depth. It is stored as one string, the levels' values
joined by commas in the order the levels belong in (`incremental,500`). A shape answers it as an
object naming each level, in that order:

| dataset | variant |
|---|---|
| `klines`, `markPrice`, `indexPrice`, `premiumIndex`, `volatilityIndex`, `optionSummary`, `optionTicker` | `{ "interval": "1m" }` |
| `books` | `{ "kind": "incremental", "depth": "500" }` — the kind is `incremental`, `snapshot` or `bands` |
| `trades` | `{ "aggregation": "default" }` or `"aggregated"` |
| `funding` | `{ "kind": "realised" }` or `"predicted"` |
| `quotes`, `liquidations`, `openInterest`, … | `{}`: no level below the dataset |

The market row's `variants`, a partition's `variant` and a lens option's `variant` carry the stored
string, since that is what a filter or a rule names. **Trades with no variant are every trade**, at
every venue: nothing is stored for them, a shape answers them as `aggregation: "default"`, and the
market row lists them as `default`. A venue's aggregation of its trades is a variant of them,
`aggregated`.

**`grain` is the size of the thing; `period` is which one.** A monthly series has a grain of `monthly`
and a period of `202506`. Grains are `monthly`, `daily`, `hourly` and `minutely`. Many venues publish
the same data both monthly and daily, so `grain` is what tells the two renderings apart.

**Reading through a lens.** A request names a [lens](#lenses) in an `x-catalog-lens` header, or in a
`lens` query parameter where it sends no header — so a browser can look through one too — and the
listing, reports and `/venues/*` answer only what it lets through. The header wins where both are sent.
Naming none is the whole catalog. An unknown slug, or a `lens` parameter given more than once, is a
`422`, never the whole catalog in its place. What a lens changes in each answer is in
[CATALOG-LENSES.md](CATALOG-LENSES.md#reading-through-a-lens).

**Collections answer `{ "items": [...] }`.** Single resources answer the object itself. Errors answer
`{ "error": "..." }` with a fitting status. The listing and its report answer their own refusals in
S3's `Error` shape, a `Code` and a `Message`; a refusal before any route runs (`401`, a body too large
or not JSON) and a `500` are `{ "error": … }` everywhere.

**Each query parameter is given once.** One given twice is a `400`; `lens` given twice is the `422`
above.

## Contents

What each venue holds, one level at a time:

```
GET /venues                                        every venue
GET /venues/:venue                                 its markets
GET /venues/:venue/symbols                         every instrument
GET /venues/:venue/markets/:market                 its shapes
GET /venues/:venue/markets/:market/symbols         its instruments
GET /venues/:venue/partitions                      its slices, and the partitions of each
```

A venue that does not exist is a `404`.

### Venues

A venue row carries `venue`, `firstMonth`, `lastMonth`, `files`, `bytes`, `pending`, `pendingBytes`,
`withdrawn`, `series` (`withFiles` out of `total`) and `hosts`. Every venue the catalog knows is
listed, with or without files. Under a lens, a venue the lens lets no file through from is left out,
and the figures are read off the lens's stored partitions; which of them are the lens's is in
[CATALOG-LENSES.md](CATALOG-LENSES.md#reading-through-a-lens).

`hosts` is where the venue's files are served from, by server: `{ "": [address, …] }`, or one entry for
each of `primary` and `secondary` where a venue has two. The first address of each is the one
prospector lists and probes; any after it serve the same files under the same paths. Each address ends
where a file's `Path` begins, so an address followed by a `Path` is the file's URL.

### Shapes

**A shape is one distinct thing the venue publishes** — a `(market, dataset, variant, grain)` — and the
row to read before wanting anything:

```json
{ "market": "perp", "dataset": "klines", "variant": { "interval": "1m" },
  "grain": "daily", "symbols": 1487, "buckets": 0,
  "first": "20190423", "last": "20260830" }
```

| | |
|---|---|
| `symbols` | how many series of named instruments carry it |
| `buckets` | how many series of the market bundle (`@`), the venue-wide file carrying every instrument at once, carry it |
| `first` | the oldest date a file of it has been seen at, written as in a key |
| `last` | the newest. **Both are measurements**: `null` means nothing has ever been seen |

**Nothing here describes how the venue arranges its URLs.** Whether a dataset changed its path once or
a thousand times is prospector's business; what a shape distinguishes is **variants of a dataset**,
never the same data under two names. So a variant that stopped and the one that replaced it are two
rows with adjacent spans. Bybit's perpetual books, for example, changed depth for every instrument at
once:

```json
{ "dataset": "books", "variant": { "kind": "incremental", "depth": "500" },
  "first": "20230118", "last": "20250820" }
{ "dataset": "books", "variant": { "kind": "incremental", "depth": "200" },
  "first": "20250821", "last": "20260930" }
```

Fetching both rows is how a caller gets the whole span.

### Markets and symbols

A market row names its datasets and sizes each one, because a single count for the market is
unreadable:

```json
{ "market": "perp", "symbols": 1354,
  "datasets": [
    { "dataset": "klines", "shapes": 30, "grains": ["daily", "monthly"],
      "variants": ["12h", "15m", "1d", "1h", "1m", "…"], "symbols": 1289 },
    { "dataset": "funding", "shapes": 1, "grains": ["monthly"],
      "variants": ["realised"], "symbols": 550 }
  ] }
```

`symbols` there is distinct instruments: in the market, and in each dataset.

**Symbols are not paged.** The largest answer is a few thousand strings. The market bundle is not an
instrument and is not among them; `buckets` on a shape is where it is reported.

Markets, shapes and symbols take the filters `market`, `dataset`, `variant` (the stored string) and
`grain`, each one value, the first three matched without regard to case; a path's `:market` takes the
place of `market`. So the questions people actually have are one request each:

```
?dataset=klines              which bar lengths does this venue publish?
?dataset=trades              are its trades filed monthly, daily, or both?
?dataset=books               does it have books, of which kinds and depths?
?dataset=trades&grain=daily  …and is there a venue-wide file, or 2,000 of them?
```

An unknown `grain` answers `400` rather than silently matching nothing.

**Every level is a projection of one read** of the venue's series, so no two of them can disagree about
whether a retired pattern counts or what an unstated end means. None of them reads a file.

### Partitions

**A venue's partitions** are what to read to handle its data a partition at a time. Each slice is
listed once, with its months inside it, in slice order and each slice's months ascending:

```json
{ "market": "perp", "dataset": "trades", "variant": "", "grain": "daily", "bundle": "instrument",
  "partitions": [
    { "month": "202011", "files": 270, "bytes": 921878368, "pending": 0, "pendingBytes": 0,
      "withdrawn": 0, "version": "9c41e07b25d3a6f8", "updatedAt": "2026-10-03T22:14:07.512Z" }
  ] }
```

| | |
|---|---|
| `variant` | the stored string; `""` where the dataset has none |
| `bundle` | `instrument` where a file holds one instrument, `market` where it holds every instrument of the market |
| `files`, `bytes` | what the venue serves of that month, withdrawn files left out |
| `pending`, `pendingBytes` | of those, what has not been reported downloaded |
| `withdrawn` | files of that month the venue no longer serves |
| `version` | sixteen hex digits computed from the ETags of the files served: it changes whenever a file is added, withdrawn or replaced by different bytes, and is the same for the same files whatever their order or paths |
| `updatedAt` | when the version last changed. A download does not move it |

The whole venue comes back at once; it is a few thousand partitions. Under a lens only the lens's
partitions are listed. Partitions takes its own filters, and a slice left with no partition is left
out:

| | |
|---|---|
| `market`, `variant`, `grain` | one value each |
| `bundle` | `instrument` or `market`; anything else is a `400` |
| `datasets` | a comma-separated list |
| `downloaded` | only partitions with nothing pending |
| `settled` | only settled partitions |
| `settled-before` | an ISO 8601 date, or date and time with its offset: only settled partitions whose version last changed before it. Anything else is a `400` |

`market`, `variant` and each of `datasets` are matched without regard to case. `downloaded` and
`settled` are yes where given bare, `true` or `1`, and no filter where `false` or `0`;
anything else is a `400`.

**A settled partition is one a completed run saw whole, after the venue had stopped publishing into
it.** What a caller can rely on:

- **Its month ended more than 15 days ago.** A month that is running or only just closed is never
  settled.
- **The venue's open run, if it has one, has not changed it:** its version last changed before that
  run started. Anything an unfinished run has changed is not settled, whether that run is at work or
  stopped half way.
- **`settled-before` asks for the same and for quiet on top**: settled, and unchanged since the instant
  given.

Settled is not final. A venue can republish, withdraw or publish late, and the partition's version
moves when it does.

## Listings

The catalog as one storage bucket, named `catalog`: every venue's files, in S3's shape, each keyed by
what the file *is*. A client walks the listing and writes each object at its key, so it needs no
vocabulary of its own, and it reports by the same key.

| | |
|---|---|
| `GET /listings` | One page of the bucket, in key order. |
| `POST /listings/report` | What became of a page, by Key. |

```
GET /listings?prefix=binance/&pending=true&max-keys=1000&marker=<last key>
x-catalog-lens: backfill-20
```

### The key

**The key is the canonical archive path**, venue first:

```
venue/market/dataset[,variant]/F/symbol/YYYYMM/venue|market|dataset[,variant]|symbol|date[.part<P>].ext
venue/market/dataset[,variant]/@/YYYYMM/venue|market|dataset[,variant]|@|date[.part<P>].ext

binance/perp/klines,1m/B/BTCUSDT/202001/binance|perp|klines,1m|BTCUSDT|20200101.zip
gate/spot/books,incremental,full/B/BTC_USDT/202107/gate|spot|books,incremental,full|BTC_USDT|20210726.part03.csv.gz
gate/spot/indexPrice,ticks/@/202312/gate|spot|indexPrice,ticks|@|202312.part1702857600.txt
```

- A dataset with no variant has no comma. The variant's values are joined in the order their levels
  belong in.
- `symbol` is the venue's own name for the instrument.
- `F` is the symbol's first letter in upper case, or `_` where it is not a Latin letter: a digit, or
  gate's symbols written in Chinese.
- `@` is the market bundle, one file carrying every instrument of a market. It has no letter folder,
  so its keys are one segment shorter, and `@` is never anything else, so a key says which depth it
  has. It sorts below every letter folder, so a dataset's bundle lists before its instruments.
- `YYYYMM` is the month of the date.
- `date` is the file's period at its grain: `202001` a month, `20200101` a day, ten and twelve digits an
  hour and a minute. Its length is the grain, so nothing else has to say it.
- `.part<P>` is a piece of a period the venue splits, and only there. `P` is the part as the venue
  writes it: a two-digit hour for gate's hourly books, a three-digit piece for bitget's trades, an
  epoch for gate's slices. It sits before the extension, where a downloaded file's name carries it.
- `.ext` is how the file is wrapped, said the same way whatever its venue wrote, and it is always
  there. It is the last extension, and before it the one saying what a compressed stream is: `.zip`,
  `.csv.gz`, `.tar.gz`. Whatever a venue writes in front of an archive's extension is dropped. A file
  whose venue names it wrongly, or not at all, is given the ending of what it holds — `.json.gz` for a
  gzip of JSON lines named `.gz`, `.txt` for text with no extension — so a name is matched as
  `date[.part<P>].*` and no reader keeps a list of endings or allows for a missing one.
- The name repeats the whole prefix but the letter, so a name read alone says everything.

**The levels are positional, not `key=value`.** A segment means what its position says, and a key has
one of two depths, told apart by `@`, so a key is read by position alone.

**The filename is for programs; the path is for people and for narrowing.** Since the name carries the
whole identity, a reader can list files and parse names without knowing where they sit. The path is
what makes a tree of keys something a person can look at, and what lets a `prefix` descend to the part
meant rather than scan the whole. `F` is a device of that tree, not a fact about the data: it keeps a
dataset's directory to a few dozen letters instead of thousands of symbols side by side, and it is a
bare segment because it labels nothing.

**A key discards the venue's own filename, and the catalog keeps the link.** Every object carries its
`Path` at the venue, so a tree written by key needs no record of where each file came from.

**Keys hold `|`**, so in a shell a key needs quoting.

### Paging

**Keys sort as bytes, as S3's do**, and that order is instrument, then date, then part. So
`trades,aggregated/` comes before `trades/`, a month's file before its days (`.` sorts below every
digit), and a monthly and a daily rendering of one instrument interleave by date under the same prefix.

**`prefix` narrows the listing**, as on S3: a venue (`gate/`), a dataset (`gate/spot/books,incremental,full/`),
an instrument, a month.

**`ListObjects` V1 by default, V2's shape with `list-type=2`.** Both resume after an exact key, so they
are one listing with two spellings:

| | V1 | V2 (`list-type=2`) |
|---|---|---|
| resume after | `marker` | `continuation-token`, or `start-after` on the first page |
| more to come | `IsTruncated`, `NextMarker` | `IsTruncated`, `NextContinuationToken` |
| also answered | `Name`, `Prefix`, `Marker`, `MaxKeys` | `Name`, `Prefix`, `MaxKeys`, `KeyCount`, `ContinuationToken`, `StartAfter` |

`max-keys` is 500 unless asked for, and 1,000 at most. Asking past the cap gets the cap, and anything
that is not a whole number from 1 is a `400`; so is a `list-type` other than `1` or `2`, and a
`prefix`, `marker`, `continuation-token`, `start-after` or `partition` holding a character XML cannot
carry. **Keys are listed flat**: a `delimiter` is a `501 NotImplemented`. `encoding-type` and
`fetch-owner` are ignored.

**XML unless JSON is asked for.** With no `Accept` header, or one that prefers XML, the answer is S3's
`ListBucketResult`. With `Accept: application/json`, it is the same fields under the same names, as one
object; an element S3 repeats (`Contents`) is an array under its own name. The listing's refusals take
S3's `Error` shape in either format, as does a path under `/listings` that no route answers (`404
NoSuchKey`). An ETag keeps S3's quotes as part of its value, so in XML it reads `&quot;…&quot;` and in
JSON `"\"…\""`.

**Each object carries `Key`, `Path`, `Host`, and, where the catalog knows them, `ETag`, `Size` and
`LastModified`.** `Path` is the file's own, below its server's address, and `Host` names the server
where the venue has more than one (`''` otherwise). The listing gives no address: a server can be
reached at several, which `/venues` lists, and a file's URL is any of them followed by its `Path`. A
file is listed once prospector has confirmed the venue serves it, and not after the venue withdraws it.

**Three filters S3 does not have.** Each one leaves files out, as though the bucket did not hold them:

| | |
|---|---|
| `pending=true` | only files not yet reported downloaded. `false` is no filter; anything else is a `400` |
| `partition=<name>` | only the files of one partition, named `venue\|market\|dataset[,variant]\|*\|grain\|YYYYMM` — `@` in place of `*` for a market-bundle partition, as in `binance\|perp\|klines,1m\|*\|daily\|202001`. Through a lens that does not let the partition through, nothing. A name that is not one, or names none, is a `422 NoSuchPartition` |
| `x-catalog-lens: <slug>`, or `lens=<slug>` | only what that lens lets through. An unknown lens is a `422 NoSuchLens` |

A walk is a cursor over keys, so a file catalogued behind the cursor is listed by the next walk, as on
any bucket.

### Reporting

```json
{ "downloaded": ["binance/perp/klines,1m/B/BTCUSDT/202001/binance|perp|klines,1m|BTCUSDT|20200101.zip"],
  "failed":     ["…"],
  "mismatched": [{ "Key": "…", "Size": 506, "ETag": "…" }] }
```

Files are named by Key: `downloaded` and `failed` are lists of keys, and `mismatched` a list of a
`Key` with the `Size` (a whole number) and `ETag` the client found, each optional. A list left out is
empty. A report holds at most 10,000 keys, and its body at most 5 MB. It is read through the lens the
files were listed through, sent as `x-catalog-lens`.

**`200` where every key was settled, `207 Multi-Status` where some were not**, with only those in the
body, as S3's quiet `DeleteObjects` answers:

```xml
<ReportResult>
  <Error><Key>…</Key><Code>NoSuchKey</Code><Message>No catalogued file has this key</Message></Error>
  <Error><Key>…</Key><Code>AccessDenied</Code><Message>The lens this report reads through does not let this file through</Message></Error>
</ReportResult>
```

`NoSuchKey` is a key naming no file; `AccessDenied` is a file the report's lens does not let through.
Neither is settled, and neither mends itself by being sent again. A whole request refused has a status
of its own, in S3's `Error` shape:

| | |
|---|---|
| `400 MalformedReport` | the body is not a report |
| `400 InvalidArgument` | it names more than 10,000 keys |
| `400 ReportRefused` | prospector refused the report as it stands, with what it said; sending it again is refused again |
| `422 NoSuchLens` | the lens it reads through does not exist |
| `502 CollectorError` | prospector failed settling it |
| `502 ServiceUnavailable` | prospector did not answer, or not in time |

**A report is prospector's to settle.** The catalog resolves each key to its file, checks it against
the lens, and hands the rest to prospector; the answer comes once prospector has settled them.
Settling is idempotent: a file reported downloaded twice is recorded once.

**A report that is not settled changes nothing.** Its files stay pending, are listed again, and can be
reported again. Nothing ties a report to a download made from a listing, so a file is reported
downloaded whenever a client holds it, however it came to.

How prospector rules on a failure or a mismatch is in
[PROSPECTOR.md](../services/PROSPECTOR.md#reports).

## Lenses

A **lens** is a named selection of the catalog. What one is, what is refused, and how it resolves is in
[CATALOG-LENSES.md](CATALOG-LENSES.md).

| | |
|---|---|
| `GET /lenses` | Every lens, the most recently changed first. |
| `GET /lenses/:slug` | One, by the address a consumer is configured with: `id`, `slug`, `name`, `note`, `createdAt`, `updatedAt`, `definition` and `updating`. |
| `POST /lenses` | Create one. `slug` required; `name`, `note` and `definition` optional, a name left empty taking the slug. Answers `201` and the lens once it is stored, with `updating: true`: what it lets through is worked out afterwards. |
| `PUT /lenses/:slug` | Replace any of `slug`, `name`, `note` and `definition`; a part left out keeps its value. Answers `200` and the lens once it is stored; `updating` is true while it is worked out, as it is once the definition changed. |
| `DELETE /lenses/:slug` | Delete it. Answers `204`. |
| `GET /lenses/options` | Every combination the venues publish that has a series — `venue`, `market`, `dataset`, `variant`, `grain` — all venues in one list. What a rule is written against. |
| `POST /lenses/check` | What is wrong with a definition, without storing it: `{ "problems": [] }`, or a `400` with the problems. |
| `POST /lenses/size` | What a definition would put on a disk: `partitions`, `files`, `bytes`, and of those `pending` and `pendingBytes`, not yet downloaded. Exact, summed over the partitions it lets through. |
| `GET /lenses/:slug/size` | The same, for one that exists, and `updating`: whether it is still being worked out, in which case the figures are of the rules before. |
| `POST /lenses/resolve` | What it actually selects: `{ "venues": { <venue>: { "slices", "partitions", "spans" } } }`, the spans being the months its rules bound them to, as `from..to`. |

**Addressed by `slug`, never by number**, in every path. A slug is lower-case letters, digits and
hyphens, two to 64 characters, not starting with a hyphen, and not `options`, `size`, `check` or
`resolve`. A write whose body names any other is a `400`; a path naming one is a `404`.

`check`, `size` and `resolve` take the definition as the body, or under `definition` in it. A
definition that does not hold is a `400` with `error` and `problems`, each naming the venue, the
rule's position and what is wrong — see
[CATALOG-LENSES.md](CATALOG-LENSES.md#what-is-refused).

**Writes are stored by prospector.** A write that passes the catalog's checks is handed on, and the
answer is prospector's own status and body: the lens, or its refusal (`404`, `409`) as it is. Where
prospector does not answer, the write is a `502`.

## Errors

| | |
|---|---|
| `200` / `207` | a report settled in full, or in part — see [Reporting](#reporting) |
| `201` / `204` | a lens created, or deleted |
| `400` | a body that is not JSON, or not what the endpoint takes; a query parameter given twice, or with a value it cannot take (`grain`, `bundle`, `downloaded`, `settled`, `settled-before`, `max-keys`, `list-type`, `pending`); a report over 10,000 keys, or refused by prospector as it stands; a lens slug that is not lower case, digits and hyphens of two characters or more; a lens definition that does not hold |
| `401` | the token is wrong or absent |
| `404` | no such venue, no such lens addressed in the path, or a path no route answers |
| `409` | a lens address already taken |
| `413` | a body over 256 KB, or over 5 MB for a report |
| `422` | a lens named in `x-catalog-lens` or `lens=` that does not exist, or a `lens` parameter given twice (`NoSuchLens`); a `partition=` that names no partition (`NoSuchPartition`) |
| `501` | a listing asked with a `delimiter` |
| `502` | prospector did not answer a lens write, or answered it with a `5xx` that is not JSON; did not answer, or failed, a report |
| `500` | a fault in this service. The log keeps the whole of it; the response says nothing |
