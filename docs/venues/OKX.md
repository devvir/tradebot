# OKX

What okx's published archives actually contain, established by asking okx rather than by reading
its documentation.

## The archive has an index, and it is public

OKX publishes no bucket listing, so its URLs are constructed from a date and probed. That is
avoidable: the download portal's own form calls a list endpoint that needs no cookies and no
token.

```
POST https://www.okx.com/priapi/v5/broker/public/trade-data/download-link?t=<epoch-ms>
content-type: application/json

{"module":"1","instType":"SPOT",
 "instQueryParam":{"instIdList":["BTC-USDT"]},
 "dateQuery":{"dateAggrType":"daily","begin":"1751328000000","end":"1751414399999"}}
```

`begin` and `end` are epoch milliseconds. The reply carries one group per instrument, and inside
it one entry per published file — **filename, URL and size in MB**:

```
BTC-USDT-trades-2025-07-01.zip   3.57 MB
  https://static.okx.com/cdn/okex/traderecords/trades/daily/20250701/BTC-USDT-trades-2025-07-01.zip?v=999
BTC-USDT-trades-2025-07-02.zip   3.8 MB
```

`totalSizeMB` sums the selection. The `?v=999` suffix is part of what the portal hands out.

Two things this is worth beyond enumeration:

- **Sizes are an integrity check.** Binance is otherwise the only venue here that publishes
  anything to verify a download against, and it does it with `.CHECKSUM` files.
- **It answers absence directly**, which a probe can only ever infer from a 404. That is worth
  having as a second opinion when a file is expected and missing — see
  [the unsupported claim](#the-unreliable-404-claim-is-unsupported) about okx's 404s, which is
  what this used to be justified by.

The endpoint rate-limits: a handful of rapid calls returns `{"msg":"Too Many Requests",
"code":"50011"}`, so it needs the same pacing as any other okx call.

## What the parameters select

| `module` | series | instrument types | periods | scope |
|---|---|---|---|---|
| `1` | trades | all four | daily + monthly | per instrument |
| `2` | candlesticks | all four | daily + monthly | per instrument |
| `3` | funding rates | **Perpetual only** | daily + monthly | per instrument |
| `4` | L2 order book, **400lv** | all four | **daily only** | per instrument |
| `5` | L2 order book, **5000lv** | all four | **daily only** | per instrument |
| `6` | [50-level book with order counts](#module-6--a-50-level-book-with-order-counts) | spot confirmed | daily | per instrument |
| `11` | borrowing rates | **Spot only** | daily + monthly | **daily: all in one; monthly: per currency**, via `ccyList` |

Instrument types are the form's Spot, Perpetual, Expiry and Options — `SPOT`, `SWAP`, `FUTURES`,
`OPTION`.

**A depth is a module, not a parameter.** The two order-book depths differ only by that number —
same `instType`, same `instIdList`, same window:

```json
{"module":"4", … }  → BTC-USD-L2orderbook-400lv-2026-08-12.tar.gz
{"module":"5", … }  → BTC-USD-L2orderbook-5000lv-2026-08-12.tar.gz
```

**The numbering is sparse, and that is the trap.** `7` through `10` answer `51000 Parameter module
error` while `11` serves borrowing rates, so **a module that errors says nothing about the next
one**. Two claims in this file were wrong for exactly that reason: `5` was recorded as borrowing
rates, which sent the hunt for 5000lv chasing a `depth` parameter that does not exist; and a sweep
that stopped at the `7`–`10` gap concluded `6` was the ceiling.

**Swept 7 to 40: only `11` answers.** So the set is `1`–`6` and `11`, established by exhaustion
rather than inferred from where the errors began. A module number cannot be reasoned about, only
observed — by capturing what the form sends, or by sweeping far past the first gap and treating
every silence as unproven rather than as an ending.

**This is what the form offers, which is not the same as what exists.** Two places they already
diverge:

- The form has no venue-wide option for trades, but an **empty `instIdList` returns one** —
  `allspot-trades-2025-07-02.zip`, 52 MB, daily only. `SWAP` answers the same way whatever it is
  given: `allswap-trades-…`, 208 MB.
- The order book card offers no period at all, yet the tree carries a `daily/` segment, so a monthly
  rendering cannot be ruled out from the form alone.

**Offering a combination is not a promise that every instrument has it.** Which months and days a
given instrument actually holds is what the index answers, and only the index.

**Borrowing rates change shape with the period**, which is the one place a module's own parameters
are not uniform — and the key is a **currency**, not an instrument:

```
monthly, per currency   …/borrowrates/monthly/202607/BTC-borrowrates-2026-07.zip
daily,   all at once    …/borrowrates/daily/20260813/allmargin-borrowrates-2026-08-13.zip
```

So `module: 5` takes `instQueryParam.ccyList` rather than `instIdList`, and there is no per-currency
daily file to ask for.

## The floors, measured rather than read off the portal

**Each dataset has its own floor.** The form's date pickers, read with no symbol selected, claim
"nothing exists before this date" about the archive as a whole. Measured against it, **the form is
right more often than it is wrong — and wrong badly enough that none of it can be assumed.**

| dataset | form claims | measured | |
|---|---|---|---|
| trades | 2021-09 | **202109** ✓ | 6 long-lived symbols, monthly *and* daily; nothing at 202108, or back to 201901 |
| candlesticks | 2023-07 | **202001** ✗ | 201912 is `404`, 202001 serves — **20 months before trades**, 6½ years before the claim |
| funding rate | 2022-03 | **202109** ✗ | serves at 202109, 18 months before the claim |
| borrowing rate | 2021-12 | **202112** ✓ | venue-wide daily: `404` on 2021-12-01, serves 2021-12-15 |
| L2 books 5000 | 2025-11 | **202511** ✓ | `404` at 2025-10-01, serves 2025-11-01 |
| L2 books 400 | 2023-03 | not established | `BTC-USDT` starts ~2023-12; the archive floor needs a symbol that started earlier |

Two of six are wrong, and one is unmeasured. That is the argument for measuring each floor rather
than for distrusting the form wholesale — the action is the same either way, but the reason
matters: **a floor is cheap to establish and expensive to guess.**

### Candles reach twenty months further back than trades

This is the finding that governs how a symbol's range can be established: **a dataset's history is
not bounded by its symbol's trade history.** `BTC-USDT` serves candlesticks for 202001 through
202108 while trades for those months do not exist at any granularity.

So a range cannot be derived once per symbol and reused. `first` has to be probed **per dataset**,
from that dataset's own measured floor.

**At the other end they do agree.** `AAC-USDT` stops at 202206 for trades and candlesticks alike,
with 202207 absent in both — so the *last* month can be taken from trades and applied across
datasets, which is the half of the assumption that survives.

**A symbol that listed after a floor starts everywhere at once.** `ASTR-USDT` (202201),
`ZENT-USDT` (202405), `BNB-USD` (202503) and `PNUT-USD` (202504) each begin trades and candlesticks
in their `listTime` month exactly, with nothing before. The divergence above is a property of the
*archive's* floors, not of instruments.

### `listTime` is not a lower bound

For anything predating the floors it is wrong in both directions at once. Five symbols stamped
`listTime` 202101:

| | 202101 | 202108 | 202109 | candles 202001 |
|---|---|---|---|---|
| ADA, ATOM, BCH, LTC | trades `404` | `404` | `200` | **`200`** |
| AAVE | trades `404` | `404` | `200` | `404` |

Trades ignore it and begin at the archive floor eight months later; candlesticks begin eleven
months *earlier* than it. So `max(floor, listTime)` loses a year of candles for every one of them,
and `listTime` alone wastes eight months of probes on trades.

**And it is largely fabricated at that depth:** 73 of the 98 live spot symbols below the trades
floor carry exactly `202101`, which is a migration stamp rather than 73 listings in one month.

It stays useful for genuinely recent instruments — 369 symbols carry 202603, and there the date is
real — but a bound that has to be trusted selectively is not a bound. **Probing a dataset's own
range is what establishes a start; `listTime` at most suggests where to look first.**

### Funding is per symbol monthly, venue-wide daily — and has a three-month hole

The directory and the filename disagree about the name, and the instrument keeps its `-SWAP`
suffix:

```
swaprates/monthly/202606/BTC-USDT-SWAP-fundingrates-2026-06.zip     per instrument
swaprates/daily/20260701/allswap-fundingrates-2026-07-01.zip        every instrument at once
```

`module: 3` **only ever answers with the daily venue-wide file**, whatever `instIdList` it is
given, and returns nothing at all for `monthly` — so the per-symbol monthly rendering is reachable
by construction and invisible to the index.

**`BTC-USDT-SWAP` serves 202109, then nothing until 202201.** Re-probed to be sure, and the
venue-wide daily is missing across the same span (2021-10-15, -11-15, -12-15 all `404`). So funding
begins at the trades floor, skips three months, and resumes — which means **the first month found
is not proof of a contiguous start**, and a bisect over a funding range would land in the hole and
report 202201.

### The book holes are real, and two methods agree

`BTC-USDT` 400lv, asked of the index and probed directly on the same days:

```
2024-01-01   index: 1 file    direct: 200
2023-12-15   index: 1 file    direct: 200
2023-03-01   index: 0 files   direct: 404
```

So the gaps are the venue's, not an artifact of guessing URLs — which also rules out the
[unsupported "404 may be 200" claim](#the-unreliable-404-claim-is-unsupported) as an explanation
for them.

**Whether the book window rolls is not established.** 2023-12-18 sat ~2.6 years back when
measured, which one observation cannot distinguish from a fixed start — the same trap bitget's
floor set. Re-probing that date in a few weeks answers it: if it has moved, OKX book history is
perishable and worth collecting first.

Funding and borrowing are published venue-wide, one file a day for every instrument at once:
`allswap-fundingrates-2025-07-01.zip` under `traderecords/swaprates/`, and
`allmargin-borrowrates-…` under `borrowrates/`. The borrowing archive's oldest file on disk is
2021-12-14, against a `RATES_START` of 2021-12-01 — so its true floor is a fortnight later than
the constant, which costs probes rather than data.

## The origin is Alibaba OSS, and it serves files directly

`static.okx.com` is three layers deep — **Alibaba Cloud OSS behind Alibaba's ENS/Swift CDN behind
CloudFront** — which the response headers give away: `server: Tengine`, a full set of `x-oss-*`
fields, `via: ens-cache…` *and* `…cloudfront.net`.

The origin names itself only when the cache cannot answer. A `GET` never reaches it, but a method
OSS must handle itself does:

```console
$ curl -X PUT https://static.okx.com/cdn/okex/traderecords/zzz
<Error><Code>MissingContentLength</Code>
  <HostId>okg-pub-hk.oss-cn-hongkong.aliyuncs.com</HostId></Error>
```

**Bucket `okg-pub-hk`, region `oss-cn-hongkong`**, and it fronts every prefix — `traderecords`, the
`okx/match` books, and the root all answer with the same host.

**Objects are publicly readable there, and it is the better download address.** The same key returns
`200` with identical `Content-Length` and `ETag`, from `Server: AliyunOSS` with no CDN in the path:

```
static.okx.com                           3740179  "3170CA8595A3AE1ABC66C27A94D01374"
okg-pub-hk.oss-cn-hongkong.aliyuncs.com  3740179  "3170CA8595A3AE1ABC66C27A94D01374"
```

So okx **is** the case for an optional second base: list one place, download another. Downloading at
the origin skips CloudFront entirely, which is where a rate limit would come from. Supporting it
means a second address on the adapter or the catalog's `venue` row, defaulting to the walking base
when empty. Nothing implements that yet.

**Listing is denied everywhere, and that is now established rather than assumed.** `ListObjects` at
the origin answers `AccessDenied — The bucket you access does not belong to you`; the
`oss-website-…` endpoint does not resolve; `/cdn/` is a zero-byte directory marker rather than an
index. There is no listable surface at any layer.

**A 404 tells you nothing, because it is a file.** The `NoSuchKey` body served through the edge
carries its own `etag`, `content-md5` and a `last-modified` of December 2023, with an `age` of
months — it is a stored error document, not a live OSS error, which is why it holds a bare `<Code>`
and never a `BucketName`.

> The AWS bucket `s3.eu-central-1.amazonaws.com/okx-public-data` exists and refuses everything —
> listing and `GetObject` alike, under every key layout tried. It is not this archive's origin.

## The limits, measured

| | |
|---|---|
| instruments per call | **4**. Five answers `51000 Parameter instIdList error` |
| window, `dateAggrType: daily` | **7 days** — `50076` past it |
| window, `dateAggrType: monthly` | **6 months** — `50077` past it |

**`monthly` is accepted, and it is the difference between an affordable enumeration and an
impractical one.** It returns the monthly files rather than the same days grouped:

```
BTC-USDT-trades-2024-09.zip   101.54 MB
  …/traderecords/trades/monthly/202409/BTC-USDT-trades-2024-09.zip
```

Roughly a twentieth of the calls: five years of one symbol's history is about a dozen monthly
requests against some 260 daily ones. Both modes are still needed, since each enumerates only its
own rendering and okx publishes months through 2026-06 and days after — but **the mode asked for is
what says which rendering came back**, so the granularity is known from the request rather than
parsed out of a path.

**An empty `instIdList` returns the venue-wide files** rather than an error —
`allspot-trades-2025-07-02.zip`, 52 MB, every spot instrument in one file. Daily only: the same
query with `monthly` returns nothing. This is the same shape `SWAP` answers with whatever it is
given.

**The index reaches the books, including their separate prefix.** `module: 4` answers with
`cdn/okx/match/orderbook/L2/400lv/daily/…`, so nothing needs to know in advance that the books live
somewhere other than `traderecords`.

## `module: 6` — a 50-level book with order counts

**`module` is not one per card on the download page.** A card carries its own selectors, and the
order book card's depths turned out to be modules `4` and `5` — so cards and modules do not
correspond, and a module without a card is not by itself proof of anything hidden.

What can be said about `6` is narrower and still worth having: it returns a file matching **neither
depth the order book card offers**, from a different bucket, in a different shape.

## The books sit on two clouds, at two prefixes

Both depths are served under `L2/` for older dates and `pro/L2/` for recent ones, and the two are
**different origins behind the same hostname**:

| | serves | origin |
|---|---|---|
| `…/orderbook/L2/<depth>/…` | 2025-01 or earlier → **2026-08-04** | `server: Tengine` — Alibaba OSS |
| `…/orderbook/pro/L2/<depth>/…` | **~2026-06** → current | `server: AmazonS3` |

`5000lv` is simply younger than `400lv` under `L2/`: `404` at 2025-10-01, `200` at 2025-11-01.

**Through the overlap the two serve the same bytes.** Checked on five dates spanning 2026-06-15 to
2026-08-04, `content-length` and ETag match exactly:

```
20260715  L2       68728044  "CDC23CB7F799B55087E0AF9F98419660"   Tengine
          pro/L2   68728044  "cdc23cb7f799b55087e0af9f98419660"   AmazonS3
```

So this is **one dataset addressable twice**, not two products and not a change of content.

**Which costs nothing here, because there is no listing to enumerate.** Every okx path is one we
construct, so the overlap is a choice rather than a duplicate: pick a cut date and build one prefix
or the other on either side of it. A listing venue would have no such option — it would see both
keys and have to decide afterwards which to keep.

**The ETag case differs by origin** — OSS answers uppercase, S3 lowercase — which is a serving
artifact and not a difference in the object. Two comparisons in prospector are case-sensitive today
([`queries.ts:1035`](../../services/prospector/src/catalog/queries.ts#L1035), the revision rule, and
[`routes.ts:433`](../../services/prospector/src/api/routes.ts#L433), the download check). Neither
misfires while a path stays on one origin, since paths differ between the prefixes — but okx has just
demonstrated that it moves trees between clouds, and the day a path changes origin, a case-sensitive
compare reads a version change that did not happen and marks a held file pending again. **ETags want
normalising before comparison.**

**A single probe cannot tell a wrong prefix from a wrong date**, which is how this file came to claim
5000lv was unreachable under `L2/` — one test, at 2026-08-12, past the point where the old prefix
stops. Both variables have to move before a path is called dead.

**Only two depths exist.** `5, 10, 20, 25, 50, 100, 200, 500, 1000` and `2000` are all `404` under
`pro/L2/`; only `400lv` and `5000lv` answer.

```
module=6 → BTC-USDT.OK.csv.gz   279.78 MB   (one day, one spot instrument)
http://qp-pri-hk.oss-cn-hongkong.aliyuncs.com/qp-storage/public_tbt/20250701/spot/BTC-USDT.OK.csv.gz
  ?Expires=…&OSSAccessKeyId=…&Signature=…
```

`module: 7` answers `51000 Parameter module error`, so six is the ceiling.

**303 columns: two timestamps, fifty levels a side, and an order count on every level.**

```
timeMs, exchTimeMs, bid_1_px, bid_1_qty, bid_1_ordCnt, ask_1_px, ask_1_qty, ask_1_ordCnt, … , symbol
1751328000003, 1751328000001, 107140, 0.47629152, 11, 107140.1, 0.09357525, 3, …
```

Two things here exist nowhere else in this venue's public archive. **`ordCnt` per level** is the
count of resting orders making up that size — the difference between "50 BTC on the bid" and "50 BTC
from one participant", which is what depth means for anything modelling liquidity or impact. And
**`exchTimeMs` beside `timeMs`** gives the venue's own stamp against the capture's, so latency is
measurable from the file rather than assumed.

`public_tbt` is presumably tick-by-tick; the two stamps in row one are 2 ms apart. At 280 MB per
instrument-day gzipped it is by far the largest thing okx publishes.

**It cannot be addressed the way everything else is.** The bucket is `qp-pri-hk` — private, where
the public archive is `okg-pub-hk` — and the URL is *presigned* with an `Expires`, an
`OSSAccessKeyId` and a `Signature`. The path is stable and storable
(`qp-storage/public_tbt/<yyyymmdd>/<market>/<INSTID>.OK.csv.gz`) but the URL is minted per request
and dies, so `base + root + path` cannot rebuild it. Anything fetching this has to ask the portal
for a fresh link at download time — a second shape of "where is this file", and the first thing here
that needs one.

Worth being explicit about the risk: **reachable is not the same as promised.** It comes from an
undocumented endpoint on a private bucket, which is a reason to take it sooner rather than to plan
around it.

Confirmed on `BTC-USDT` and `ETH-USDT` spot, same shape and path both times. The same query for
`ETH-USDT-SWAP` returns no files, so it may be spot-only — unestablished.

## Where the symbols come from, and what each source knows

Three sources, none sufficient alone:

| source | covers | ranges |
|---|---|---|
| `api/v5/public/instruments?instType=` | **live only** — 1,354 spot | `listTime`, `expTime`, `state` |
| `priapi/v5/broker/public/trade-data/instruments?instType=` | **everything, dead included** — 2,170 spot | names only |
| `download-link` with `monthly` | everything | **exact months, definitive** |

**818 of 2,170 spot symbols are dead** — 38% — and the public API does not serve them at all:
asking for `AAC-USDT` by `instId` answers `51001 … doesn't exist`. So `listTime` is unavailable for
more than a third of the universe.

**But the index answers for dead symbols.** `AAC-USDT` returns four monthly files for 2022. That
makes the index the only complete source, and makes a range table an optimisation rather than a
prerequisite here — see [the note on ranges](#ranges-are-cheap-here-and-expensive-on-bitget).

`instType` takes `SPOT`, `SWAP`, `FUTURES` and `OPTION`, matching the card's
Spot/Perpetual/Expiry/Options. Two traps in the answers:

- **The portal spells swaps without the suffix.** It returns `LAYER-USDT` where the public API says
  `LAYER-USDT-SWAP`. Which spelling `download-link` wants is unestablished, and on bitget the
  equivalent mismatch returned an empty list rather than an error — which reads exactly like "no
  data".
- **`FUTURES` and `OPTION` return underlyings, not contracts** — 129 and 6 — because files are
  published per chain. 121 of the 129 are `*-USD_UM_XPERP` on names like `MU`, `MRVL`, `SOXL` and
  `XAU`: tokenised equity and commodity perpetuals, a product line nothing here collects.

### Ranges, and why the monthly sweep is how to get them

Two costs, and they are nothing alike. Sixty months of archive, four instruments a call:

| | window | windows | calls, spot's 2,170 symbols |
|---|---|---|---|
| `monthly` | ~5 months | 12 | **~6,500** |
| `daily` | 7 days | ~257 | **~139,000** |

Per module, per instrument type — and the catalog wants both renderings of everything, so the daily
figure is the one that repeats across modules 1, 2, 4, 5 and 6.

**Most of those daily calls ask about a symbol that was already dead, or not yet born.** 818 of
2,170 spot symbols are delisted, most with short lives, so a sweep that runs every symbol across the
full sixty months spends the overwhelming majority of its requests confirming emptiness. Knowing the
range is not a tidy saving on a cheap job; it is the difference between asking a bounded question and
brute-forcing the keyspace.

**So the monthly pass is how the ranges get established.** It is cheap enough to run blind, it
answers exactly which months each symbol has — including the dead ones, which nothing else will say
— and its answer bounds every daily pass that follows. Ranges are an output of the first sweep and an
input to all the rest.

**For a live symbol, one request bounds it.** Monthly candles at the maximum page size return a
whole history at once:

```
GET /api/v5/market/history-candles?instId=BTC-USDT&bar=1M&limit=100
  → 100 bars, 2018-04 … 2026-07
```

A hundred months reaches back past the 2021-09 archive floor from any date this decade, so **one
call per symbol always spans the entire archive era** — 1,354 calls for all of live spot, answering
where data actually starts and stops rather than when trading opened. That is a tighter bound than
`listTime`, which says nothing about whether an archive file exists.

**For a dead symbol there is nothing.** Delisted instruments are gone from the public API entirely:
`AAC-USDT` answers `51001 … doesn't exist` from `public/instruments` and `market/history-candles`
alike, so no pagination trick reaches behind a delisting.

So the ranges come from two places, split by whether the symbol still trades:

| | how | cost, spot |
|---|---|---|
| 1,354 live | one monthly-candle call each | ~1,350 |
| 818 dead | the monthly index sweep | ~2,500 |

Roughly **3,800 requests to bound the whole spot universe**, after which every daily pass asks only
about months that can hold something.

## Nobody else has a listing either

The published tools all construct URLs and probe, which is worth recording so it is not
re-investigated as a possible shortcut:

- **`okx-data-dump`** (PyPI `okx-dump`) builds `…/traderecords/{type}/daily/…` and treats a 404 as
  absent — and takes its instrument universe from **`api.tardis.dev`**, not from okx.
- **`OKX-CandlestickRetriever`** does not touch the archives at all; it pages `api/v5` candles.

So the portal index is already better than any of them: it enumerates, and it answers for
instruments and prefixes a constructed URL has to guess at.

## The "unreliable 404" claim is unsupported

Trucker's adapter carries `unreliableAbsence: true` for okx alone, on the stated grounds that the
same URL has answered 404 and then 200 seconds later. It is the reason okx's absences are probed
twice and ledgered for spaced re-checks — a doubling of the request count for the venue with the
most files.

**The evidence available does not support it.** `@shared/archives/absences.jsonl` holds 46,847
recorded absences, every one of them okx:

- **`attempts` is `1` on all 46,847.** Not one was ever retried, so the double-probe this claim
  justifies has never run on any of them — and this ledger cannot be where the observation came
  from.
- **219 were re-probed at the origin, sampled across all eight datasets. None exists.** A 404 that
  was spurious at the time would serve `200` today, so zero hits is a real result rather than an
  inconclusive one.

Not disproven — 219 is a sample, and nobody has caught the alternating behaviour in the act. But
nothing here justifies paying double for it, and the claim should be re-established before it is
relied on again.

## Not yet established

- Whether the endpoint reckons days in UTC. A window ending `2021-09-05T23:59:59.999Z` returned a
  2021-09-06 file, which suggests a venue-local zone.
- Where exactly the monthly window boundary falls: three months is accepted and a span of exactly
  six is refused, so the limit is inclusive of fewer months than the message implies.
- Which spelling `download-link` wants for swaps: the portal's instrument list says `LAYER-USDT`
  where the public API says `LAYER-USDT-SWAP`. Worth settling deliberately rather than by trying
  one — a wrong symbol form is answered here with an empty list, not an error, which reads exactly
  like "this instrument has no data".
- Where borrowing rates get their universe. They key on a currency rather than an instrument, so
  none of the instrument lists above enumerates them.
- Whether `module: 6` covers anything but spot. `ETH-USDT-SWAP` returned no files.
- Whether the order books have a monthly rendering. The form offers no period for them, but the
  tree carries a `daily/` segment, which is not how a venue names something with only one form.

## Layout

Everything is served from `static.okx.com`, across **three prefixes and two buckets**:

```
cdn/okex/traderecords/                       the public bucket, okg-pub-hk
  trades/{daily/<yyyymmdd>|monthly/<yyyymm>}/<INSTID>-trades-<yyyy-mm-dd>.zip
  candlesticks/…                             same two granularities
  swaprates/daily/<yyyymmdd>/allswap-fundingrates-<yyyy-mm-dd>.zip
  borrowrates/daily/<yyyymmdd>/allmargin-borrowrates-<yyyy-mm-dd>.zip
  borrowrates/monthly/<yyyymm>/<CCY>-borrowrates-<yyyy-mm>.zip

cdn/okx/match/orderbook/{pro/}L2/{400lv|5000lv}/daily/<yyyymmdd>/
  <INSTID>-L2orderbook-<depth>-<yyyy-mm-dd>.tar.gz
                                             `pro/` from 2026-07-01, plain `L2/` until 2026-08-04

qp-storage/public_tbt/<yyyymmdd>/<market>/<INSTID>.OK.csv.gz
                                             the private bucket, qp-pri-hk, presigned only
```

**None of the three is reachable by guessing from another.** The books' prefix does not follow from
the `traderecords` layout, the `pro/` segment does not follow from the books' own older path, and
the tick-by-tick tree is on a different bucket entirely. Every one of them was found by asking the
index what it would serve — which is the argument for the index over constructed URLs, stated as a
layout fact rather than as a preference.
