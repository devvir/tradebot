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

**Reading through a lens.** A consumer names a [lens](#lenses) in an `x-catalog-lens` header, and the
listings and `/contents/*` answer only what it lets through. No header is the whole catalog; an unknown
slug is a `404`, never the whole catalog in its place.

**Collections answer `{ "items": [...] }`.** Single resources answer the object itself. Errors answer
`{ "error": "..." }` with a fitting status. The listing is the exception: it answers in S3's shape,
errors included.

## Contents

What each venue holds, one level at a time:

```
GET /contents/venues                                        every venue
GET /contents/venues/:venue                                 its markets
GET /contents/venues/:venue/symbols                         every instrument
GET /contents/venues/:venue/markets/:market                 its shapes
GET /contents/venues/:venue/markets/:market/symbols         its instruments
```

A venue row carries `venue`, `firstMonth`, `lastMonth`, `files`, `bytes`, `pending`, `pendingBytes`,
`withdrawn`, and `series` (`withFiles` out of `total`). It lists only venues the catalog holds anything
for. Under a lens every figure is the lens's, which costs resolving the lens: a few seconds on the
full catalog the first time, and about one while the resolved lens is held. A caller that only wants
venue names asks without one.

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

Each venue as a storage bucket. The listing has S3's shape, and every object is keyed by what the file
*is*. This is what a downloader walks: it writes each object at its key, so it needs no vocabulary of
its own.

| | |
|---|---|
| `GET /listings/:venue` | One page of the venue's listing, in key order. |
| `POST /listings/:venue/report` | What became of a page, by `FileId`. |

```
GET /listings/binance?pending=true&max-keys=1000&marker=<last key>
x-catalog-lens: backfill-20
```

**The key is the canonical archive path**, the same on every venue:

```
market/dataset[,variant]/YYYYMM/F/symbol/venue|market|dataset[,variant]|symbol|period[|part].ext

perp/klines,1m/202001/B/BTCUSDT/binance|perp|klines,1m|BTCUSDT|20200101.zip
perp/quotes/202001/B/BTCUSDT/binance|perp|quotes|BTCUSDT|20200101.zip
```

A dataset with no variant has no comma. `F` is the symbol's first letter in upper case, or `_` where it
is not a letter. The variant's values are joined in the order their levels belong in. `part` is where a
venue splits a period into pieces, as bitget's trades are. `@` as the symbol means one file carrying
every instrument of a market. Keys sort as bytes, as S3's do, so `trades,default/` comes before
`trades/`.

**`ListObjects` V1 by default, V2's shape with `list-type=2`.** Both resume after an exact key, so they
are one listing with two spellings:

| | V1 | V2 (`list-type=2`) |
|---|---|---|
| resume after | `marker` | `continuation-token`, or `start-after` on the first page |
| more to come | `IsTruncated`, `NextMarker` | `IsTruncated`, `NextContinuationToken` |
| also answered | `Marker` | `KeyCount`, `ContinuationToken`, `StartAfter` |

`max-keys` is 500 unless asked for, and 1,000 at most. Asking past the cap gets the cap, and anything
that is not a whole number from 1 is a `400`. `prefix`, `delimiter`, `encoding-type` and `fetch-owner`
are not implemented.

**XML unless JSON is asked for.** With no `Accept` header, or one that prefers XML, the answer is S3's
`ListBucketResult`. With `Accept: application/json`, it is the same fields under the same names, as one
object. An error takes S3's `Error` shape with a `Code` and a `Message` in either format: `NoSuchBucket`
(404), `NoSuchLens` (404) or `InvalidArgument` (400). An ETag keeps S3's quotes as part of its value, so
in XML it reads `&quot;…&quot;` and in JSON `"\"…\""`.

**Each object carries `Key`, `FileId`, `Url`, and, where the catalog knows them, `ETag`, `Size` and
`LastModified`.** `FileId` is not S3's: it is the catalog's own number for the file, and what a report
names a file by. The key is the listing's identity and its cursor; it runs to hundreds of bytes, so it is
not asked to be anything else. A `FileId` stays the file's for as long as the file exists, which holds
because the catalog never runs a full `VACUUM`.

`BaseUrl` joined to `Url` is the address of the file. When every object on a page lives under one base,
`BaseUrl` is that base and each `Url` is the rest. When a page mixes a venue's hosts, `BaseUrl` is empty
and each `Url` is complete.

**Two filters S3 does not have.** Each one leaves files out, as though the listing did not hold them:

| | |
|---|---|
| `pending=true` | only files not yet downloaded |
| `x-catalog-lens: <slug>` | only what that lens lets through |

A walk is a cursor over keys, so a file catalogued behind the cursor is listed by the next walk, as on
any bucket.

### Reporting

```json
{ "downloaded": [4815162, "…"],
  "failed":     [4815163],
  "mismatched": [{ "FileId": 4815164, "Size": 506, "ETag": "…" }] }
```

The answer counts what was `recorded`, `withdrawn` and `corrected`, plus `unknown`: ids that name no
file of this venue, otherwise ignored. A report holds at most 10,000 files.

**A report is prospector's to settle**, so the catalog forwards it as sent and answers with what
prospector said. Where prospector does not answer, the report is a `502` and is sent again later: a
downloader that loses a report loses nothing, since the files are listed again, found on disk, and
reported then.

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
| `POST /lenses` | Create one. `slug` required; `name`, `note` and `definition` optional. |
| `PUT /lenses/:slug` | Replace it whole: `slug`, `name`, `note`, `definition`, or any of them. |
| `DELETE /lenses/:slug` | Delete it. |
| `GET /lenses/options/:venue` | The combinations that venue publishes (`market`, `dataset`, `variant`, `grain`), how many series each holds, and how many of those are venue-wide files (`buckets`). What a rule is written against. |
| `GET /lenses/instruments/:venue` | Every instrument the venue publishes, for a rule's `instruments`. |
| `POST /lenses/check` | What is wrong with a definition, without storing it. |
| `POST /lenses/size` | What a definition would put on a disk: `series`, `files`, `bytes`, and of those `pending` and `pendingBytes`, not yet downloaded. Exact, summed off the rollups. |
| `GET /lenses/:slug/size` | The same, for one that exists. |
| `POST /lenses/resolve` | What it actually selects, per venue: how many series, and the date spans. |

**Addressed by `slug`, never by number**, in every path.

## Errors

| | |
|---|---|
| `400` | a malformed body, a report over 10,000 files, an unknown `grain`, or a lens definition that does not hold |
| `401` | the token is wrong or absent |
| `404` | no such venue or lens |
| `409` | a lens address already taken |
| `413` | a body over 5 MB |
| `502` | a report prospector did not answer |
| `500` | a fault in this service. The log keeps the whole of it; the response says nothing |
