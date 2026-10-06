# Catalog API

Everything the `catalog` service serves, in one place. **This is the reference — other docs link here
rather than restating it**, so an endpoint cannot be described in two places and drift.

Served on `CATALOG_PORT`, and the only way anything outside the [archives module](ARCHIVES.md) reaches
the catalog. Prospector's own API (starting and pausing surveys, settling reports) is private to the
module and documented in [PROSPECTOR.md](../services/PROSPECTOR.md#the-api).

## Conventions

**Authentication.** Every request carries the shared secret in an `x-catalog-token` header. A wrong
token and a missing one answer `401` alike. Not authentication so much as a closed door: there are no
users and no sessions, and what it protects against is the port being reachable by something with no
business here.

**An empty `CATALOG_TOKEN` removes the door**, and every request is let through with no header at all,
which is what makes these endpoints readable straight from a browser. Suitable where nothing else can
reach the port, and warned about at startup so it cannot be the state nobody chose.

**A venue is a venue.** Bybit publishes its order books on a second host, and that is the catalog's
business: it appears in no path, no parameter and no response field. A caller asks about `bybit` and
gets bybit.

**Canonical names, never the venue's own.** `market`, `dataset` and `variant` are the catalog's
vocabulary (`perp`, `klines`, `1m`); the translation from `futures_usdt/candlesticks_1m` stops inside
the prospector adapter that read it. See [PROSPECTOR.md](../services/PROSPECTOR.md).

**`variant` is the level below the dataset, whatever that level happens to be.** For klines it is the
bar length; for books it is the depth and the kind. It is stored as one string (`500,incremental`) and
answered as an object naming each level:

| dataset | variant |
|---|---|
| `klines`, `markPrice`, `indexPrice`, `premiumIndex` | `{ "interval": "1m" }` |
| `books` | `{ "depth": "400", "mode": "incremental" }` |
| `trades` | `{ "aggregation": "default" }` or `"aggregated"` |
| `funding` | `{ "kind": "realised" }` |
| `quotes`, `liquidations`, `borrowing`, … | `{}`: no level below the dataset |

The keys come in the order the levels belong in. **`aggregation: "default"` claims only "the one this
venue publishes"**, never that it is raw: most venues publish one flavour of trades and say nothing about
it, so the catalog stores nothing and reports the default. Binance publishes both and names them, so its
raw feed is `default` and its `aggTrades` is `aggregated`.

**`grain` is the size of the thing; `period` is which one.** A monthly series has a grain of `monthly`
and a period of `202506`. Many venues publish the same data both monthly and daily, so `grain` is what
tells the two renderings apart.

**Reading through a lens.** A consumer names a [lens](#lenses) in an `x-catalog-lens` header, or in
a `lens` query parameter where it sends no header — so a browser can look through one too — and the
listings and `/venues/*` answer only what it lets through. Naming none is the whole catalog; an
unknown slug is a `422`, never the whole catalog in its place: the URL names something that exists, and
the lens names something that does not.

**Collections answer `{ "items": [...] }`.** Single resources answer the object itself. Errors answer
`{ "error": "..." }` with a fitting status. The listing is the exception: it answers in S3's shape,
errors included.

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

A venue row carries `venue`, `firstMonth`, `lastMonth`, `files`, `bytes`, `pending`, `pendingBytes`,
`withdrawn`, and `series` (`withFiles` out of `total`). It lists only venues the catalog holds anything
for. Under a lens every figure is the lens's, which costs resolving the lens: a few seconds on the
full catalog the first time, and about one while the resolved lens is held. A caller that only wants
venue names asks without one.

**A venue's partitions** are what to read to handle its data a partition at a time. Each slice is
listed once, with its months inside it:

```json
{ "market": "perp", "dataset": "trades", "variant": "", "grain": "daily", "bundle": "instrument",
  "partitions": [
    { "month": "202011", "files": 270, "bytes": 921878368, "pending": 0, "pendingBytes": 0,
      "withdrawn": 0, "version": "9c41e07b25d3a6f8", "updatedAt": "2026-10-03T22:14:07.512Z" }
  ] }
```

| | |
|---|---|
| `bundle` | `instrument` where a file holds one instrument, `market` where it holds every instrument of the market |
| `files`, `bytes` | what the venue serves of that month, withdrawn files left out |
| `pending`, `pendingBytes` | of those, what has not been reported downloaded |
| `version` | sixteen hex digits that change whenever a file of the partition is added, withdrawn or changed, and are the same for the same files |
| `updatedAt` | when the version last changed. A download does not move it |

The whole venue comes back at once; it is a few thousand partitions. Under a lens only the lens's
partitions are listed. Query parameters narrow it, and a slice left with no partition is left out:

| | |
|---|---|
| `market`, `variant`, `grain`, `bundle` | one value each |
| `datasets` | a comma-separated list |
| `downloaded=true` | only partitions with nothing pending |
| `settled` | only settled partitions |
| `settled-before` | an ISO timestamp: only settled partitions whose version last changed before it |

**A settled partition is one a completed run saw whole, after the venue had stopped publishing into
it.** Its month ended more than 15 days ago, and the venue's open run, if it has one, has not changed it. A
month that is running or only just closed is never settled, and neither is anything an unfinished run
has changed, whether that run is at work or stopped half way. `settled-before` asks for the same and
for quiet on top: settled, and unchanged since the instant given.

Settled is not final. A venue can republish, withdraw or publish late, and the partition's version
moves when it does.

**A shape is one distinct thing the venue publishes**, and the row to read before wanting anything:

```json
{ "market": "perp", "dataset": "klines", "variant": { "interval": "1m" },
  "grain": "daily", "symbols": 1487, "buckets": 0,
  "first": "20190423", "last": "20260830" }
```

| | |
|---|---|
| `symbols` | named instruments carrying it |
| `buckets` | venue-wide files carrying every instrument at once (the `@` symbol) |
| `first` | the oldest period anything of this shape covers |
| `last` | the newest file anybody has seen of it. **A measurement**: `null` means nothing has ever been seen |

**Nothing here describes how the venue arranges its URLs.** Whether a dataset changed its path once or a
thousand times is prospector's business; what a shape distinguishes is **variants of a dataset**, never
the same data under two names. So a variant that stopped and the one that replaced it are two rows with
adjacent spans:

```json
{ "dataset": "books", "variant": { "depth": "500", "mode": "incremental" },
  "first": "20230118", "last": "20250820" }
{ "dataset": "books", "variant": { "depth": "200", "mode": "incremental" },
  "first": "20250821", "last": "20260930" }
```

Bybit changed the depth of its perpetual books on 2025-08-21, for every instrument at once. Fetching
both rows is how a consumer gets the whole span.

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

Every venue sub-route takes the filters `market`, `dataset`, `variant` and `grain`, so the questions
people actually have are one request each:

```
?dataset=klines              which bar lengths does this venue publish?
?dataset=trades              are its trades filed monthly, daily, or both?
?dataset=books               does it have books, at what depths, and which mode?
?dataset=trades&grain=daily  …and is there a venue-wide file, or 2,000 of them?
```

An unknown `grain` answers `400` rather than silently matching nothing.

**Symbols are not paged.** The largest answer is a few thousand strings. The venue-wide file is not
among them; `buckets` on a shape is where that is reported.

**Every level is a projection of one read**, so no two of them can disagree about whether a retired
pattern counts or what an unstated end means. Answered from patterns and series (thousands of rows
where files are hundreds of millions), so it costs nothing to ask. What a lens changes here is in
[CATALOG-LENSES.md](CATALOG-LENSES.md#reading-through-a-lens).

## Listings

The catalog as one storage bucket: every venue's files, in S3's shape, each keyed by what the file *is*.
This is what a downloader walks. It writes each object at its key, so it needs no vocabulary of its own,
and it reports by the same key.

| | |
|---|---|
| `GET /listings` | One page of the bucket, in key order. |
| `POST /listings/report` | What became of a page, by Key. |

```
GET /listings?prefix=binance/&pending=true&max-keys=1000&marker=<last key>
x-catalog-lens: backfill-20
```

**The key is the canonical archive path**, venue first:

```
venue/market/dataset[,variant]/F/symbol/YYYYMM/venue|market|dataset[,variant]|symbol|date[.partNN].ext
venue/market/dataset[,variant]/@/YYYYMM/venue|market|dataset[,variant]|@|date[.partNN].ext

binance/perp/klines,1m/B/BTCUSDT/202001/binance|perp|klines,1m|BTCUSDT|20200101.zip
gate/spot/books/B/BTC_USDT/202107/gate|spot|books|BTC_USDT|20210726.part03.csv.gz
gate/spot/trades/@/202107/gate|spot|trades|@|202107.csv.gz
```

- A dataset with no variant has no comma. The variant's values are joined in the order their levels
  belong in.
- `F` is the symbol's first letter in upper case, or `_` where it is not a Latin letter: a digit, or
  gate's symbols written in Chinese.
- `@` is the venue-wide file, one file carrying every instrument of a market. It has no letter folder,
  so its keys are one segment shorter, and `@` is never anything else, so a key says which depth it
  has. It sorts below every letter, so a dataset's bucket lists before its instruments.
- `date` is the file's period, a month (`202001`) or a day (`20200101`).
- `.partNN` is a piece of a period a venue splits, as bitget's trades and gate's hourly books are. It
  sits before the extension, where a downloaded file's name carries it.
- The name repeats the whole prefix but the letter, so a name read alone says everything.

**Keys sort as bytes, as S3's do**, and that order is instrument, then date, then part. So
`trades,default/` comes before `trades/`, a month's file before its days (`.` sorts below every digit),
and a monthly and a daily rendering of one instrument interleave by date under the same prefix.

**`prefix` narrows the listing**, as on S3: a venue (`gate/`), a dataset (`gate/spot/books/`), an
instrument, a month. A downloader walks one venue at a time with `prefix=<venue>/`.

**`ListObjects` V1 by default, V2's shape with `list-type=2`.** Both resume after an exact key, so they
are one listing with two spellings:

| | V1 | V2 (`list-type=2`) |
|---|---|---|
| resume after | `marker` | `continuation-token`, or `start-after` on the first page |
| more to come | `IsTruncated`, `NextMarker` | `IsTruncated`, `NextContinuationToken` |
| also answered | `Marker` | `KeyCount`, `ContinuationToken`, `StartAfter` |

`max-keys` is 500 unless asked for, and 1,000 at most. Asking past the cap gets the cap, and anything
that is not a whole number from 1 is a `400`. `delimiter`, `encoding-type` and `fetch-owner` are not
implemented.

**XML unless JSON is asked for.** With no `Accept` header, or one that prefers XML, the answer is S3's
`ListBucketResult`. With `Accept: application/json`, it is the same fields under the same names, as one
object; an element S3 repeats (`Contents`) is an array under its own name. An error takes S3's `Error`
shape with a `Code` and a `Message` in either format. An ETag keeps S3's quotes as part of its value, so
in XML it reads `&quot;…&quot;` and in JSON `"\"…\""`.

**Each object carries `Key`, `Url`, and, where the catalog knows them, `ETag`, `Size` and
`LastModified`.** `Url` is the whole address of the file at its venue. A page can span venues, and one
venue can be served from two hosts, so there is no base to share.

**Two filters S3 does not have.** Each one leaves files out, as though the bucket did not hold them:

| | |
|---|---|
| `pending=true` | only files not yet downloaded |
| `x-catalog-lens: <slug>`, or `lens=<slug>` | only what that lens lets through; the header wins where both are sent. An unknown lens is a `422 NoSuchLens` |

A walk is a cursor over keys, so a file catalogued behind the cursor is listed by the next walk, as on
any bucket.

### Reporting

```json
{ "downloaded": ["binance/perp/klines,1m/B/BTCUSDT/202001/binance|perp|klines,1m|BTCUSDT|20200101.zip"],
  "failed":     ["…"],
  "mismatched": [{ "Key": "…", "Size": 506, "ETag": "…" }] }
```

Files are named by Key, and through the lens they were listed through, sent as `x-catalog-lens`. A report
holds at most 10,000 keys.

**`200` where every key was settled, `207 Multi-Status` where some were not**, with only those in the
body, as S3's quiet `DeleteObjects` answers:

```xml
<ReportResult>
  <Error><Key>…</Key><Code>NoSuchKey</Code><Message>No catalogued file has this key</Message></Error>
  <Error><Key>…</Key><Code>AccessDenied</Code><Message>The lens … does not let this file through</Message></Error>
</ReportResult>
```

`NoSuchKey` is a key naming no file; `AccessDenied` is a file the report's lens does not let through.
Neither is settled, and neither mends itself by being sent again. A whole request refused has a status
of its own: `400` for a body that is not a report or names more than 10,000 keys, `422 NoSuchLens`, and
`502` where prospector does not answer.

**A report is prospector's to settle.** The catalog resolves each key to its file and forwards it to
prospector's private reports API. Where prospector does not answer, the report is a `502` and is sent
again later: a downloader that loses a report loses nothing, since the files are listed again, found on
disk, and reported then.

**Reporting is not transactional with the download, on purpose.** That same path is what lets a machine
whose archive is already there be adopted with no seeding step.

**The caller reports problems; prospector rules on them.** A file reported as undownloadable is checked
against the venue, and either stays owed or is ruled absent. A mismatch is confirmed the same way, and
what the venue says is what gets recorded.

## Lenses

A **lens** is a named way of looking at the catalog. See [CATALOG-LENSES.md](CATALOG-LENSES.md).

| | |
|---|---|
| `GET /lenses` | Every lens, newest first. |
| `GET /lenses/:slug` | One, by the address a consumer is configured with. |
| `POST /lenses` | Create one. `slug` required; `name`, `note` and `definition` optional. Answers once it is stored, with `updating: true`: what it lets through is worked out afterwards. |
| `PUT /lenses/:slug` | Replace it whole: `slug`, `name`, `note`, `definition`, or any of them. Answers once it is stored; `updating` is true where the rules changed. |
| `DELETE /lenses/:slug` | Delete it. |
| `GET /lenses/options/:venue` | The combinations that venue publishes (`market`, `dataset`, `variant`, `grain`), how many series each holds, and how many of those are venue-wide files (`buckets`). What a rule is written against. |
| `POST /lenses/check` | What is wrong with a definition, without storing it. |
| `POST /lenses/size` | What a definition would put on a disk: `partitions`, `files`, `bytes`, and of those `pending` and `pendingBytes`, not yet downloaded. Exact, summed over the partitions it lets through. |
| `GET /lenses/:slug/size` | The same, for one that exists, and `updating`: whether it is still being worked out, so the figures are of a part of it. |
| `POST /lenses/resolve` | What it actually selects, per venue: how many `slices`, how many `partitions`, and the month `spans` its rules bound them to. |

**Addressed by `slug`, never by number**, in every path.

## Errors

| | |
|---|---|
| `200` / `207` | a report settled in full, or in part — see [Reporting](#reporting) |
| `400` | a malformed body, a report over 10,000 keys, an unknown `grain`, or a lens definition that does not hold |
| `401` | the token is wrong or absent |
| `404` | no such venue, or no such lens addressed in the path |
| `422` | a lens named in `x-catalog-lens` or `lens=` that does not exist |
| `409` | a lens address already taken |
| `413` | a body over 5 MB |
| `502` | a report prospector did not answer |
| `500` | a fault in this service. The log keeps the whole of it; the response says nothing |
