# OKX

OKX as a source of market data: what it publishes, where, and how it behaves when asked.

## Archives

What okx's published archives actually contain, established by asking okx rather than by reading
its documentation.

### The shape of the archive

Five datasets, and the markets each applies to — okx's *expiry* is `FUTURES`, its *perpetual* is
`SWAP`:

| dataset | markets | monthly | daily | venue-wide daily bucket |
|---|---|---|---|---|
| trades | all four | yes | yes | `allspot` `allswap` `allfutures` `alloption` |
| candlesticks | all four | yes | yes | `allspot` `allswap` `allfutures` `alloption` |
| funding rates | **perpetual only** | yes | *(see below)* | `allswap` |
| borrowing rates | **spot only** | yes, per **currency** | *(see below)* | `allmargin` |
| order books | all four | **no** | yes | **none** |

- **Order books are the exception in three ways**: daily only, no venue-wide bucket, and **two
  depths** — `400lv` and `5000lv` — which are separate datasets sharing a shape.
- **Trades and candlesticks are published three ways**, per instrument per month *and* per instrument
  per day, plus the bucket. Each is a key of its own that exists or does not on its own.
- **Funding rates have no per-instrument daily rendering.** Monthly per instrument, and daily only as
  `allswap` — `BTC-USDT-SWAP-fundingrates-2026-08-15.zip`, `…-swaprates-…` and a `fundingrates/daily/`
  path all answer 404 while the bucket answers 200.
- **Borrowing rates are keyed by currency**, not by instrument: `BTC-borrowrates-2026-07.zip` is
  real, but no endpoint enumerates okx's currencies, so the bucket is the only rendering whose name
  follows from a date alone. It begins **2021-12-14** — the 13th answers 404 and the 14th 200.

#### The buckets are the dataset, not an instrument in it

`allspot`, `allswap`, `allfutures`, `alloption` and `allmargin` have no listing and no lifetime of
their own: each exists for as long as its dataset has.

Their floors differ by market for the same dataset: spot candlesticks reach back to 2019-12 while
futures begin in 2021-09.

#### A chain is not spelled the way the venue names it

The archive is **one directory per dataset per period, holding every market at once**, so the
instrument token in a filename is the only thing separating them. Dated chains carry what kind of
chain they are:

```
BTC-USD-trades-2026-07.zip                 the SPOT pair BTC-USD
BTC-USD-futureschain-trades-2026-07.zip    the FUTURES chain
BTC-USD-optionchain-trades-2026-07.zip     the OPTION chain
allfutures-trades-2026-07-15.zip           every futures instrument, that day
```

**This holds for every futures family, bare ones included** — the download index states it for
`BTC-USD` exactly as for `AAOI-USD_UM_XPERP` — and it holds across datasets and renderings, books
included (`AAVE-USD_UM_XPERP-futureschain-L2orderbook-400lv-2026-07-15.tar.gz`).

Asking for the plain name on a futures family does not fail; **it returns the spot pair's file**.

#### `preopen` instruments have no archive

okx's instruments API carries a `state`, and `preopen` means **announced, not yet trading** —
`JP225-USDT-SWAP` sat in the portal's list on 2026-08-16 with a listing date of 2026-09-09. It has no
archive, cannot have one, and is not a gap: the form lists what will be tradable, which is a
different question from what has been published.

The portal's list cannot say this — it is names only. `state` is on the public API alone.

### The archive has an index, and it is public

OKX publishes no bucket listing. The download portal's own form calls a list endpoint that needs
no cookies and no token.

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

Beyond enumeration:

- **Sizes are an integrity check**: the index reports each file's size in MB.
- **It answers absence directly**, which a probe can only ever infer from a 404. That is worth
  having as a second opinion when a file is expected and missing — see
  [the unsupported claim](#a-404-is-reliable-as-far-as-anyone-has-checked) that okx's 404s are
  unreliable.

The endpoint rate-limits: a handful of rapid calls returns `{"msg":"Too Many Requests",
"code":"50011"}`.

### What the parameters select

| `module` | dataset | instrument types | periods | scope |
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

**The numbering is sparse.** `7` through `10` answer `51000 Parameter module error` while `11`
serves borrowing rates, so **a module that errors says nothing about the next one**. There is no
`depth` parameter.

**Swept 7 to 40: only `11` answers.** The set is `1`–`6` and `11`.

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

So `module: 11` takes `instQueryParam.ccyList` rather than `instIdList`, and there is no per-currency
daily file to ask for.

### The floors, measured rather than read off the portal

**Each dataset has its own floor.** The form's date pickers, read with no symbol selected, claim
"nothing exists before this date" about the archive as a whole. Measured against it, **the form is
right more often than it is wrong — and wrong badly enough that none of it can be assumed.**

| dataset | form claims | measured | |
|---|---|---|---|
| trades | 2021-09 | **202109** ✓ | 478 pairs begin in that month and none earlier |
| candlesticks | 2023-07 | **201912** ✗ | 291 pairs begin there; 201911 is `404` for all of them |
| funding rate | 2022-03 | **202109** ✗ | 137 pairs begin there, 18 months before the claim |
| borrowing rate | 2021-12 | **202112** ✓ | venue-wide daily: `404` on 2021-12-01, serves 2021-12-15 |
| L2 books 5000 | 2025-11 | **202511** ✓ | 1,104 pairs begin there, `404` at 2025-10-01 |
| L2 books 400 | 2023-03 | **≤ 20230403** ? | futures chains by 2023-04-03; spot pairs from 202309 |

Two of the claims are wrong, both late — candlesticks and funding. The 400-level claim is neither
confirmed nor refuted.

**The 400-level books begin earlier on the futures chains than on spot.**
`BTC-USD-futureschain-L2orderbook-400lv-2023-04-03.tar.gz` answers `200`, 151 MB, while the spot
pairs begin in 202309 (481 of them). How far below 2023-04-03 the chains reach is not established.

**These are archive floors, and a floor measured from one symbol is that symbol's floor.**
`BTC-USDT` has no 201912 candlestick file; `BSV-USDT`, `BTC-USDC`, `ETC-USDT`, `ETH-USDC` and
`TRX-USDT` all do, and all `404` at 201911.

#### Candles reach twenty months further back than trades

**A dataset's history is not bounded by its symbol's trade history.** `BTC-USDT` serves
candlesticks for 202001 through 202108 while trades for those months do not exist at any
granularity. A symbol's first month differs by dataset.

**At the other end they agree.** `AAC-USDT` stops at 202206 for trades and candlesticks alike, with
202207 absent in both: a delisting ends every dataset in the same month.

**A symbol that listed after a floor starts everywhere at once.** `ASTR-USDT` (202201),
`ZENT-USDT` (202405), `BNB-USD` (202503) and `PNUT-USD` (202504) each begin trades and candlesticks
in their `listTime` month exactly, with nothing before. The divergence above is a property of the
*archive's* floors, not of instruments.

#### `listTime` is not a lower bound

For anything predating the floors it is wrong in both directions at once. Five symbols stamped
`listTime` 202101:

| | 202101 | 202108 | 202109 | candles 202001 |
|---|---|---|---|---|
| ADA, ATOM, BCH, LTC | trades `404` | `404` | `200` | **`200`** |
| AAVE | trades `404` | `404` | `200` | `404` |

Trades ignore it and begin at the archive floor eight months later; candlesticks begin eleven
months *earlier* than it.

**And it is largely fabricated at that depth:** 73 of the 98 live spot symbols below the trades
floor carry exactly `202101`, which is a migration stamp rather than 73 listings in one month.

For recent instruments the date is real — 369 symbols carry 202603 — but it is not a bound on what
the archive holds.

#### Funding is per symbol monthly, venue-wide daily — and has a three-month hole

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
begins at the trades floor, skips three months, and resumes: **the first month is not proof of a
contiguous start**.

#### Swap trades for 2021-10 list every trade twice

**The first month of swap trades is not usable as published.** Every swap instrument's trades for
October 2021 carry each trade on two rows, one after the other: the same `trade_id`, price, size and
time, once as `BUY` and once as `SELL`.

```
BTC-USDT-SWAP,118368467,SELL,43135.1,4.0,1633017600564
BTC-USDT-SWAP,118368467,BUY,43135.1,4.0,1633017600564
BTC-USDT-SWAP,118368468,SELL,43135.1,1.0,1633017600564
BTC-USDT-SWAP,118368468,BUY,43135.1,1.0,1633017600564
```

- **Every swap, the whole month, both grains.** All 72 monthly files of 202110 have it from their
  first row, and so do the daily files (`BTC-USDT-SWAP` on 2021-10-01, -15 and -31, read on
  2026-10-07).
- **It ends at the month.** From 2021-11-01 a trade is one row, in the daily and the monthly files
  alike — every day of 2021-11 was read — and no later month has it.
- **Spot never had it**, from its own first month, 202109.
- **Dated futures never had it either.** The daily chain files for `BTC-USD`, `BTC-USDT` and `ETH-USD`
  and the venue-wide `allfutures` file list each trade once on 2021-09-15, on 2021-10-01, -15 and
  -31, and after.

**Which row is the trade as it happened is not stated anywhere.** Which side comes first varies from
pair to pair, about evenly. Read against the price movement, the first row of a pair behaves as a
taker's side does and the second as its mirror — one-instant sweeps of several prices agree with the
first row in 96% of cases for `BTC-USDT-SWAP` and 100% for `ETH-USDT-SWAP`, against 99.8% and 99.9%
for the side as published in 2021-11. That is an inference from the prices and not the venue's word,
so the month's sides are not known, and taken as published its rows and its volume are double.

**Swap trades are therefore usable from 2021-11.**

#### Candlestick volumes are three columns, filled by era

A candlestick row is `instrument_name, open, high, low, close, vol, vol_ccy, vol_quote, open_time,
confirm`. `vol` is always filled. The other two are not, and a column okx did not fill holds the text
`None` on every row of the file.

| Months | `vol_ccy` | `vol_quote` |
|---|---|---|
| up to 2021-08 (spot; nothing else is published yet) | filled | `None` |
| 2021-09 to 2023-08 | `None` | `None` |
| from 2023-09 | filled | filled |

What they measure depends on the market:

- **Spot**: `vol` is the base amount, and `vol_ccy` and `vol_quote` are both the quote amount — the
  same number wherever both are filled. `ETH-BTC`, 2020-12: `vol` 113.075912 at 0.0309, `vol_ccy`
  3.4946. `BTC-USDT`, 2023-09: 5.52708124, 148781.61, 148781.61.
- **Contracts**: `vol` is the number of contracts, `vol_ccy` the base coin and `vol_quote` the quote.
  `BTC-USDT-SWAP`, 2023-09: 11060, 110.6, 2976805.145. `BTC-USD-SWAP`: 3204, 11.9026, 320400.

Read from the monthly files of `BTC-USDT`, `ETH-BTC`, `BTC-USDT-SWAP` and `BTC-USD-SWAP`, one row a
month.

#### Candlestick files can repeat rows

Measured on 2026-10-04: of 200 random 2020 spot 1m files, 96 carry every bar exactly twice, byte for
byte — `BTC-USDT`'s June 2020 monthly file holds 86,400 rows for 43,200 bars — and 104 carry each
once; 2021 perpetual files, 0 of 40; 2023 perpetual files, 4 of 40, and those repeat a handful of
rows rather than all (`KSM-USDT` 2023-10: 44,651 rows, 44,640 bars). Which way a file goes varies by
instrument, by day and by year.

#### What a book file holds

The `.tar.gz` holds one `.data` file of a JSON record a line:

```
{"instId":"AUDF-USDT","action":"snapshot","ts":"1780272000008","asks":[["0.7189","50000","1"]],"bids":[…]}
{"instId":"AUDF-USDT","action":"update","ts":"1780272031008","asks":[["0.7189","0","0"]],"bids":[…]}
```

A `snapshot` is the whole book to the file's depth and an `update` the levels that changed; a level
is `[price, size, orders]`, and a size of `0` removes it. At 400 levels there is a snapshot a minute
(1,440 in a day's file), each side filled out to 400 with `["0","0.0","0"]`. `ts` is in milliseconds,
unique and rising through a file. A `futureschain` or `optionchain` file holds every contract of the
family, each record naming its own.

**Book files are UTC days.** A day's file runs 00:00 to 24:00 UTC (2023-03-01, 2023-12-18,
2026-06-01; spot, swap and futures), where a day of trades or candlesticks is a UTC+8 day.

#### The book holes are real, and two methods agree

`BTC-USDT` 400lv, asked of the index and probed directly on the same days:

```
2024-01-01   index: 1 file    direct: 200
2023-12-15   index: 1 file    direct: 200
2023-03-01   index: 0 files   direct: 404
```

So the gaps are the venue's, not an artifact of guessing URLs — which also rules out the
[unsupported "404 may be 200" claim](#a-404-is-reliable-as-far-as-anyone-has-checked) as an explanation
for them.

### What the archive holds (walked 2026-08-16/17)

Every instrument-dataset pair, walked at the spellings above until it answered or the archive ran
out.

#### A dataset's floor is a launch, not a gradual filling

Each dataset appears all at once, backfilled across everything listed at the time:

| month | event | pairs beginning |
|---|---|---|
| 201912 | the archive itself begins, candlesticks only | 291 |
| 202109 | trades and funding rates launch together | 478 + 137 |
| ≤2023-04 | 400-level books: futures chains from ≤2023-04-03, spot pairs from 2023-09 | 481 spot, then 169 the next month |
| 202511 | 5000-level books launch | 1,104 |

**A symbol that listed before its dataset launched begins at the launch**, whatever its trading
history: 478 of the 2,578 instruments with trades begin in 202109, and 1,104 of the 1,884 with
5000-level books in 202511. Only candlesticks reach 201912, so **candles are the only part of the
archive before 2021-09**.

#### Two mass listings

202511 (1,239 pairs) and 202603 (1,240) each add as much as a dataset launch, spread across all five
datasets rather than concentrated in one: new instruments rather than new history. 202604 through
202606 stay elevated.

#### A delisting ends every dataset of a symbol together

202603 closes 22 pairs in each of the five datasets, 202602 closes 7 of each. 2,360 pairs have an end,
across 56 distinct months.

#### The universe

**12,430 instrument-dataset pairs**:

| | pairs |
|---|---|
| a start, and an end where the archive has one | 10,680 |
| no file anywhere in the archive, and no longer listed | 1,750 |

By market, excluding order books: SPOT 4,340 · SWAP 1,926 · FUTURES 258 · OPTION 12. Order books
account for the other 5,894.

**Every active symbol has data in every dataset its market publishes.** Every pair with nothing is a
dead symbol: candlesticks reach back to 2019-12 while every other dataset begins in 2021-09, so a pair
that stopped trading before then has only candlesticks, which okx goes on writing with zero volume.

**The unified-margin families publish only as chains.** The underlyings okx returns for `FUTURES`
include unified-margin names beside the plain ones — `AAVE-USD_UM_XPERP` beside `AAVE-USD`,
`BTC-USD_UM` beside `BTC-USD`. Every one of them publishes, under `<name>-futureschain-<dataset>-…`
only; nothing is served at `<name>-<dataset>-…`. For the tokenised equities and commodities that is
the only spelling they have.

### The origin is Alibaba OSS, and it serves files directly

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

**Objects are publicly readable there**, for the `okex/traderecords/` and `okx/match/orderbook/L2/`
keys but not for `pro/L2/` (see [the two prefixes](#the-books-sit-on-two-clouds-at-two-prefixes)).
The same key returns
`200` with identical `Content-Length` and `ETag`, from `Server: AliyunOSS` with no CDN in the path:

```
static.okx.com                           3740179  "3170CA8595A3AE1ABC66C27A94D01374"
okg-pub-hk.oss-cn-hongkong.aliyuncs.com  3740179  "3170CA8595A3AE1ABC66C27A94D01374"
```

A request to the origin does not pass through CloudFront, where
[the refusals](#what-the-cdn-tolerates-and-how-it-refuses) come from.

**Listing is denied everywhere.** `ListObjects` at
the origin answers `AccessDenied — The bucket you access does not belong to you`; the
`oss-website-…` endpoint does not resolve; `/cdn/` is a zero-byte directory marker rather than an
index. There is no listable surface at any layer.

**A 404 tells you nothing, because it is a file.** The `NoSuchKey` body served through the edge
carries its own `etag`, `content-md5` and a `last-modified` of December 2023, with an `age` of
months — it is a stored error document, not a live OSS error, which is why it holds a bare `<Code>`
and never a `BucketName`.

> The AWS bucket `s3.eu-central-1.amazonaws.com/okx-public-data` exists and refuses everything —
> listing and `GetObject` alike, under every key layout tried. It is not this archive's origin.

### The limits, measured

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
requests against some 260 daily ones. Each mode enumerates only its own rendering, so **the mode
asked for is what says which rendering came back**.

**An empty `instIdList` returns the venue-wide files** rather than an error —
`allspot-trades-2025-07-02.zip`, 52 MB, every spot instrument in one file. Daily only: the same
query with `monthly` returns nothing. This is the same shape `SWAP` answers with whatever it is
given.

#### The dated markets are selected by family, and asking wrongly answers anyway

**`FUTURES` and `OPTION` take `instFamilyList`, not `instIdList`.** A chain is a family, not an
instrument, so naming it under the wrong key selects *nothing* — and the endpoint does not say so.
It applies the empty-selection rule above and hands back the venue-wide bucket:

```json
{"module":"1","instType":"FUTURES","instQueryParam":{"instIdList":["ETH-USD_UM"]},  …}
  → allfutures-trades-2026-08-18.zip        ← the bucket. Nothing to do with ETH-USD_UM.

{"module":"1","instType":"FUTURES","instQueryParam":{"instFamilyList":["ETH-USD_UM"]}, …}
  → ETH-USD_UM-futureschain-trades-2026-08-18.zip
```

**Both answers are `code: 0`.** So a bucket coming back is not evidence that the per-symbol file is
absent — it is the answer to a question that selected no instrument. Every market publishes
per-symbol files.

**Confirm existence against the CDN, not against this index.** A `HEAD` on the constructed URL is
the only thing that answers whether a key exists; the index answers what the portal's form would
offer for a selection, which is a different question and has more ways to be silently empty.

**The index reaches the books, including their separate prefix.** `module: 4` answers with
`cdn/okx/match/orderbook/L2/400lv/daily/…`, outside `traderecords`.

### `module: 6` — a 50-level book with order counts

**`module` is not one per card on the download page.** A card carries its own selectors, and the
order book card's depths are modules `4` and `5` — so cards and modules do not
correspond, and a module without a card is not by itself proof of anything hidden.

What `6` returns is a file matching **neither depth the order book card offers**, from a
different bucket, in a different shape:

```
module=6 → BTC-USDT.OK.csv.gz   279.78 MB   (one day, one spot instrument)
http://qp-pri-hk.oss-cn-hongkong.aliyuncs.com/qp-storage/public_tbt/20250701/spot/BTC-USDT.OK.csv.gz
  ?Expires=…&OSSAccessKeyId=…&Signature=…
```

**303 columns: two timestamps, fifty levels a side, and an order count on every level.**

```
timeMs, exchTimeMs, bid_1_px, bid_1_qty, bid_1_ordCnt, ask_1_px, ask_1_qty, ask_1_ordCnt, … , symbol
1751328000003, 1751328000001, 107140, 0.47629152, 11, 107140.1, 0.09357525, 3, …
```

Two things here exist nowhere else in this venue's public archive. **`ordCnt` per level** is the
count of resting orders making up that size — the difference between "50 BTC on the bid" and "50 BTC
from one participant". And **`exchTimeMs` beside `timeMs`** gives the venue's own stamp against the
capture's.

`public_tbt` is presumably tick-by-tick; the two stamps in row one are 2 ms apart. At 280 MB per
instrument-day gzipped it is by far the largest thing okx publishes.

**It cannot be addressed the way everything else is.** The bucket is `qp-pri-hk` — private, where
the public archive is `okg-pub-hk` — and the URL is *presigned* with an `Expires`, an
`OSSAccessKeyId` and a `Signature`. The path is stable and storable
(`qp-storage/public_tbt/<yyyymmdd>/<market>/<INSTID>.OK.csv.gz`) but the URL is minted per request
and expires, so it cannot be constructed: a fresh link has to be asked of the index each time.
Nothing else okx publishes is addressed this way. It comes from an undocumented endpoint on a
private bucket.

Confirmed on `BTC-USDT` and `ETH-USDT` spot, same shape and path both times. The same query for
`ETH-USDT-SWAP` returns no files, so it may be spot-only — unestablished.

### The books sit on two clouds, at two prefixes

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

#### `pro/` is a different host, not just a different prefix

**"Behind the same hostname" means `static.okx.com`, and only `static.okx.com`.** The Alibaba OSS
bucket is one of the two origins, so asking it for a `pro/` key is asking a bucket for something it
does not contain — and the answer is an ordinary `404` with no hint that the question was wrong:

```
static.okx.com/cdn/…/L2/400lv/daily/20260801/…      200   Tengine
static.okx.com/cdn/…/pro/L2/400lv/daily/20260801/…  200   AmazonS3
static.okx.com/cdn/…/pro/L2/400lv/daily/20260815/…  200   AmazonS3
static.okx.com/cdn/…/L2/400lv/daily/20260815/…      404   Tengine

okg-pub-hk.oss-…/cdn/…/L2/400lv/daily/20260801/…    200   AliyunOSS
okg-pub-hk.oss-…/cdn/…/pro/L2/400lv/daily/20260801/… 404  AliyunOSS
```

Checked across five instruments and both depths, `pro/` answers `404` at the OSS origin every time,
including for dates it serves at `static.okx.com`.

**So a date is not enough to name a book file.** The prefix decides the origin, and only
`static.okx.com` serves both. Since plain `L2/` runs to 2026-08-04, anything
at or below 2026-07 is reachable at the OSS origin under `L2/` alone; from 2026-08-05 the books are
reachable **only** through `static.okx.com`.

**The ETag case differs by origin**: Alibaba OSS answers the MD5 uppercase and S3 lowercase, for
the same bytes. It is a serving artifact, not a difference in the object.

**A `404` on a book path does not say whether the prefix or the date is wrong**: `5000lv` at
2026-08-12 answers `404` under `L2/` and `200` under `pro/L2/`.

**Only two depths exist.** `5, 10, 20, 25, 50, 100, 200, 500, 1000` and `2000` are all `404` under
`pro/L2/`; only `400lv` and `5000lv` answer.

### Where the symbols come from, and what each source knows

Three sources, none sufficient alone:

| source | covers | ranges |
|---|---|---|
| `api/v5/public/instruments?instType=` | **live only** — 1,354 spot | `listTime`, `expTime`, `state` |
| `priapi/v5/broker/public/trade-data/instruments?instType=` | **everything, dead included** — 2,170 spot | names only |
| `download-link` with `monthly` | everything | **exact months, definitive** |

**818 of 2,170 spot symbols are dead** — 38% — and the public API does not serve them at all:
asking for `AAC-USDT` by `instId` answers `51001 … doesn't exist`. So `listTime` is unavailable for
more than a third of the universe.

**But the index answers for dead symbols.** `AAC-USDT` returns four monthly files for 2022, which
makes the index the only complete source.

`instType` takes `SPOT`, `SWAP`, `FUTURES` and `OPTION`, matching the card's
Spot/Perpetual/Expiry/Options. Two traps in the answers:

- **The portal spells swaps without the suffix**, and it is the portal that is right. It returns
  `LAYER-USDT` where the public API says `LAYER-USDT-SWAP`, and the archive takes the portal's
  spelling with `-SWAP` appended by the *path*, not by the name — see below.
- **`FUTURES` and `OPTION` return underlyings, not contracts** — 129 and 6 — because files are
  published per chain. 121 of the 129 are `*-USD_UM_XPERP` on names like `MU`, `MRVL`, `SOXL` and
  `XAU`: tokenised equity and commodity perpetuals. **They publish, under
  `<name>-futureschain-<dataset>-…`** — see [the shape of the archive](#the-shape-of-the-archive).

#### The instrument is the family; the market is a suffix

`instFamily` is okx's canonical name and `instId` is that name with the market composed onto it.
Read straight off `api/v5/public/instruments`:

```
SPOT      instId='USDT-SGD'                instFamily=''
SWAP      instId='BTC-USD-SWAP'            instFamily='BTC-USD'
FUTURES   instId='BTC-USD-260828'          instFamily='BTC-USD'
OPTION    instId='BTC-USD-260828-42000-C'  instFamily='BTC-USD'
```

One family, three markets. **Spot alone has no family and is its own name**, so
`instFamily || instId` is the canonical symbol for every market and no per-market rule is needed.

The archive composes the same way, which is why the suffix belongs to the pattern rather than to the
symbol: `-SWAP` for perpetuals, `-futureschain` and `-optionchain` for the dated markets, nothing for
spot. A key that happens to equal an `instId` — `0G-USDT-SWAP-trades-2026-08-25.zip` — is incidental,
not the rule.

**`_UM_XPERP` is a family, not a contract.** 187 live futures contracts sit under 161 families, and
`BTC-USD_UM`, `BTC-USD_UM_XPERP` and `SOL-USD_UM_XPERP` are all `instFamily` values; the contracts
are those plus an expiry, `BTC-USD_UM_XPERP-310404`.

**A chain is one file, whatever is open inside it.** `BTC-USD` has eight live contracts and one file
a day, so two expiries running at once cannot collide — they share it by construction:

```
BTC-USD-futureschain-trades-2026-08-25.zip             200
BTC-USD_UM_XPERP-futureschain-trades-2026-08-25.zip    200
BTC-USD-optionchain-trades-2026-08-25.zip              200
BTC-USD-260828-trades-2026-08-25.zip                   404
BTC-USD-260925-futureschain-trades-2026-08-25.zip      404
```

So a new expiry under an existing family adds no file: it is published inside that chain's file.

### What the CDN tolerates, and how it refuses

Measured with sustained `HEAD` against `static.okx.com`:

| | |
|---|---|
| clean | **100/s** |
| refuses | **200/s** — 35 `403`s inside one pass |

**A refusal is a `403` and a missing key is a `404`, and they are never confused.** An invented
symbol and an impossible date both answer 404; 403 only ever means the cadence was exceeded. The
refusal carries `server: Tengine` and `cache: Error from cloudfront`, so **the ceiling is the CDN
edge, not the origin**.

**The refusal is sticky.** Once tripped, unrelated paths keep being refused for minutes, answering in
~40 ms, so a burst poisons the requests after it rather than only itself. The figures were measured
on one night at one edge location, and an edge figure is not a constant of the venue.

### Where the instrument lists disagree, and which to believe

Refreshed 2026-08-28, one call per market to
`priapi/v5/broker/public/trade-data/instruments` — note the response is `data.instList`, not `data`,
and it answers `50011 Too Many Requests` if the four calls are made back to back:

| market | full listing | v5 `public/instruments` |
|---|---|---|
| SPOT | 2,202 | 1,383 |
| SWAP | 655 | 459 |
| FUTURES | 162 | 187 contracts / 161 families |
| OPTION | 6 | by `uly` only |

**Options cannot be listed whole on v5.** `instType=OPTION` on its own answers `50015, Either
parameter uly or instFamily is required` — an empty list beside the error — so option families are
asked for one underlying at a time; there are four. The two parameters are not interchangeable:
`instFamily` answers for `BTC-USD` and `ETH-USD` and rejects `SOL-USD` and `XAU-USD` with `51000,
Parameter instFamily error`, while `uly` answers for all four, and `uly` is what the underlying
endpoint returns.

**The v5 lists throttle sooner than the archive does.** They refuse the second or third call in a
row: the eight calls it takes to list every market trip a `429` when made back to back.

**The test pairs are the one thing the full listing is missing and v5 has.** `XTESTA-USDT` and
`XTESTA-USDC` come back from v5 as `state: 'live'` — okx documents a `test` state and does not use it
for these — while the full listing omits them entirely, and the archive publishes nothing for them.
They are also the only two of 196 margin instruments that are not spot pairs. Their state does not
mark them: they are named by base, `XTESTA-*` in spot and margin and `TEST002-*` among the futures
families.

**Margin has no archive of its own.** 194 of 196 margin instruments are spot pairs, and the
archive's one margin dataset is the venue-wide `allmargin` borrowing rates. There is no
per-instrument margin file.

### A 404 is reliable, as far as anyone has checked

The claim is that the same URL has answered 404 and then 200 seconds later. **The evidence does not
support it.** 219 keys that had answered `404`, sampled across all eight datasets, were re-probed at
the origin, and none exists. A 404 that was spurious at the time would serve `200` today, so zero
hits is a real result rather than an inconclusive one.

Not disproven — 219 is a sample, and nobody has caught the alternating behaviour in the act.

### Periods are UTC+8

**A day or a month of trades or candlesticks is a UTC+8 one**; book files are UTC days (see
[what a book file holds](#what-a-book-file-holds)). The candlestick file dated 2020-06-15 holds
2020-06-14 16:00 → 2020-06-15 15:59 UTC, and the June 2020 monthly file 2020-05-31 16:00 →
2020-06-30 15:59 UTC (read off `BTC-USDT` and `BTC-USDC` on 2026-10-04). The timestamps inside are
plain epoch milliseconds; only which file holds a row is shifted — a UTC day's last eight hours
are in the next day's file. It is also why a download window ending `2021-09-05T23:59:59.999Z`
returned a 2021-09-06 file.

### Not yet established
- Where exactly the monthly window boundary falls: three months is accepted and a span of exactly
  six is refused, so the limit is inclusive of fewer months than the message implies.
- How far below 2023-04-03 the 400-level books of the futures chains reach.
- Where borrowing rates get their universe. They key on a currency rather than an instrument, so
  none of the instrument lists above enumerates them.
- Whether `module: 6` covers anything but spot. `ETH-USDT-SWAP` returned no files.
- Whether the order books have a monthly rendering. The form offers no period for them, but the
  tree carries a `daily/` segment, which is not how a venue names something with only one form.
- Whether the book window rolls. 2,295 pairs have 400-level books, and 2023-12-18 was served when
  it was about 2.6 years old; one observation cannot tell a rolling window from a fixed start. If
  the window rolls, the earliest months disappear.
- Whether files are ever added for past dates that once answered `404`.

### Layout

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
                                    plain `L2/` until 2026-08-04, `pro/` from ~2026-06 — and `pro/`
                                    resolves only at static.okx.com, never at the OSS origin

qp-storage/public_tbt/<yyyymmdd>/<market>/<INSTID>.OK.csv.gz
                                             the private bucket, qp-pri-hk, presigned only
```

**None of the three is reachable by guessing from another.** The books' prefix does not follow from
the `traderecords` layout, the `pro/` segment does not follow from the books' own older path, and
the tick-by-tick tree is on a different bucket entirely. The index answers with all three.

## REST

**How to read this section.** A statement with no mark is what the API answered when it was asked,
in October 2026. *(documented)* marks what okx's documentation states and was not tried.
*(not known)* marks what neither settled. Nothing here is inferred from another venue.

### The API

**One API**: `https://www.okx.com/api/v5`, in three families — `market/*` (bars, trades),
`public/*` (funding, instruments, funds, deliveries) and `rubik/stat/*` (statistics).

- **It is behind Cloudflare and says where it answered from**: the header `x-routed-to: TKY`.
- **An instrument is an `instId`**: `BTC-USDT` (spot, and the index of that name), `BTC-USDT-SWAP`,
  `BTC-USD-261225` (a dated future), `BTC-USD-261011-82750-C` (an option). A family is
  `instFamily`: `BTC-USDT`, `BTC-USD`.
- **Times are milliseconds**, strings in answers.
- **Every answer is `{code, msg, data}`** with HTTP 200; `code` `"0"` is success and anything else
  the error. Seen: `51001` "Instrument ID, Instrument ID code, or Spread ID doesn't exist".
- **A refusal for pace is the exception**: HTTP 429 with `{"msg":"Too Many Requests","code":"50011"}`.
- **Records are in `data`**, newest first. Three endpoints nest them: `data[0].details` on
  `insurance-fund` and `liquidation-orders`, `data[].details` on deliveries and settlements.

### Its limits

- **A budget for each endpoint, per 2 seconds, by address** *(documented, endpoint by endpoint)*;
  for some, by address and instrument, or by address and family. The figures are in the tables
  below.
- **No header reports it.** Only `public/market-data-history` carries `ratelimit-limit`,
  `ratelimit-remaining`, `ratelimit-reset`.
- **Beyond it**: HTTP 429, code `50011`, no `Retry-After`. One or two seconds later the endpoint
  answers, and nothing longer follows.
- **The figures hold to the call**: 20 calls to `history-candles` pass and the 21st is refused; the
  same for mark bars; 10 pass on `funding-rate-history` and on `open-interest-history`.
- **An endpoint's budget is its own**: with `history-candles` refused, mark bars and `candles`
  still answered.
- **A budget "by address" covers every instrument of the endpoint**: with `history-candles` refused
  for one pair, it was refused for another.
- **A budget "by address and instrument" is one per instrument**: with `funding-rate-history`
  refused for one swap, it answered for another; the same on `open-interest-history`.
- **One stated figure is not the real one**: `history-index-candles` is documented at 10 per
  2 seconds, and 20 calls passed in 1.5 seconds before the first refusal.

### How it is paged

- **Backward only.** `after=<time>` returns the records older than it, newest first; the next call
  passes the oldest time just received.
- **`before=<time>` alone returns the newest page**, whatever the time — it does not walk forward.
  With both, the answer is the newest page inside the window.
- **The statistics family says `end` and `begin`** for the same two.
- **A `limit` over the maximum is capped, silently**: 301 bars return 300, 500 statistics 100.
- **The end of a history is an empty `data`**, with `code` `"0"`.

### Endpoints that serve the past

**Bars — `GET /api/v5/market/history-candles`**
- **Ask**: `instId`, `bar` (`1s 1m 3m 5m 15m 30m 1H 2H 4H`; `6H 12H 1D 2D 3D 1W 1M 3M` opening at
  UTC+8, or the same with `utc` appended opening at UTC), `after`, `before`, `limit` ≤ 300.
- **Answer**: rows of strings `[ts, open, high, low, close, vol, volCcy, volCcyQuote, confirm]`.
- **Reaches**: BTC-USDT 2018-01-11; ETH-BTC and the three swaps tried, 2020-01-01. Of the listed
  spot pairs only four start before 2020. `bar=1M&limit=100` on BTC-USDT returned 100 bars, 2018-04
  to 2026-07. `1s` bars answered 120 days back; 3 months is what is
  stated.
- **Budget**: 20 per 2 seconds, by address.
- **`GET /api/v5/market/candles` is another endpoint**: the recent bars only; `after` in 2020 is
  empty.

**Mark price bars — `GET /api/v5/market/history-mark-price-candles`**
- **Ask**: `instId` (a swap or future), `bar` (without `1s`), `after`, `before`, `limit` — 300
  returned 300; 100 is the stated maximum.
- **Answer**: `[ts, open, high, low, close, confirm]`.
- **Reaches**: 2020-01-01 for BTC-USDT-SWAP and BTC-USD-SWAP. **Budget**: 20 per 2 seconds.

**Index bars — `GET /api/v5/market/history-index-candles`**
- **Ask**: `instId` — the index, `BTC-USDT` — `bar`, `after`, `before`, `limit` (300 returned 300).
- **Answer**: `[ts, open, high, low, close, confirm]`.
- **Reaches**: BTC-USD 2018-06; BTC-USDT and ETH-USDT 2021-07.
- **Budget**: 10 per 2 seconds as stated, 20 as seen.

**Funding — `GET /api/v5/public/funding-rate-history`**
- **Ask**: `instId`, `after`, `before`, `limit` ≤ 400.
- **Answer**: `{instId, instType, fundingRate, realizedRate, fundingTime, formulaType, method}`.
- **Reaches 3 months**: 308 records came back for a `limit` of 400, the oldest 102 days old, and
  `after` a year back is empty. **Budget**: 10 per 2 seconds, by address and instrument.

**Premium — `GET /api/v5/public/premium-history`**
- **Ask**: `instId`, `after`, `before`, `limit` ≤ 100. **Answer**: `{instId, premium, ts}`, about one
  a minute.
- **Reaches 6 months**: 150 days back answers, 240 does not. **Budget**: 20 per 2 seconds.

**Trades — `GET /api/v5/market/history-trades`**
- **Ask**: `instId`, `type` (`1` pages by `tradeId`, `2` by time), `after`, `limit` ≤ 100.
- **Answer**: `{instId, tradeId, px, sz, side, ts, source}`.
- **Reaches 3 months**: 100 days back is empty. **Budget**: 20 per 2 seconds.

**Open interest and ratios — `GET /api/v5/rubik/stat/contracts/open-interest-history`,
`long-short-account-ratio-contract`, `long-short-account-ratio-contract-top-trader`,
`long-short-position-ratio-contract-top-trader`, `GET /api/v5/rubik/stat/taker-volume-contract`**
- **Ask**: `instId` (a swap or future), `period` (`5m 15m 30m 1H 2H 4H`, and the daily and longer
  with or without `utc`), `end`, `begin`, `limit` ≤ 100.
- **Answer**: rows — open interest `[ts, oi, oiCcy, oiUsd]`; each ratio `[ts, ratio]`; taker volume
  `[ts, sellVol, buyVol]`.
- **Reaches the last 1,440 points of the period asked**: at `5m`, 2 days back answers and 7 does
  not; at `1H`, 30 days answers and 60 does not; at `1D`, back to 2024-02-04. The top-trader
  account ratio at `5m`: 2 days answers, 5 does not.
- **Taker volume fills the past with zeros**: 600 days back it returns 100 rows, each `"0","0"`.
- **Budget**: 10 per 2 seconds for open interest, 5 for the others, by address and instrument.

**Insurance fund — `GET /api/v5/public/insurance-fund`**
- **Ask**: `instType`, `instFamily` (or `uly`), `type`, `after`, `before`, `limit` ≤ 100.
- **Answer**: `data[0].details[]` of `{ts, balance, amt, ccy, type, adlType, decRate, maxBal,
  maxBalTs}`; a `regular_update` a minute.
- **Reaches 3 months**: 90 days back answers, 120 does not. **Budget**: 10 per 2 seconds.

**Deliveries and settlements — `GET /api/v5/public/delivery-exercise-history`,
`settlement-history`**
- **Ask**: `instType` and `instFamily`; `after`, `before`, `limit` ≤ 100.
- **Answer**: `{ts, details: [{insId, px, type}]}` and `{ts, details: [{instId, settlePx}]}`.
- **Reach 3 months**: 11 deliveries of BTC-USD, none 200 days back; 100 daily settlements.
- **Budget**: 40 per 2 seconds, by address and family.

**Liquidations — `GET /api/v5/public/liquidation-orders`**
- **Ask**: `instType`, `instFamily`, `state=filled`, `after`, `limit` ≤ 100.
- **Answer**: `data[0].details[]` of `{ts, side, posSide, sz, bkPx, bkLoss, ccy}`.
- **Reaches under a day**: `after` the last time received gives the next 100; `after` one day back
  is empty.
- **The documentation lists it as a websocket channel only.**

**The archive's index — `GET /api/v5/public/market-data-history`**: `module` (1 trades, 2 one-minute
bars, 3 funding, 4, 5 and 6 order books, 11 borrowing rates), `instType`, `instIdList` or
`instFamilyList`, `dateAggrType` (`daily`, `monthly`), `begin`, `end`. It answers the addresses of
the archive's files. Budget 5 per 2 seconds *(documented)*; its headers say 60 a second.

**The listing — `GET /api/v5/public/instruments?instType=`**: `SPOT`, `SWAP`, `FUTURES`, `OPTION`
(with `instFamily`); `{instId, instFamily, state, listTime, expTime, ctVal, …}`. **Listed
instruments only** — `live`, and on spot `preopen`. `listTime` is not the first bar: spot's
earliest `listTime` is in 2021 where bars start in 2018.

### Endpoints that do not

- **`public/open-interest?instType=SWAP`**: every swap's open interest now, in one answer —
  `{instId, oi, oiCcy, oiUsd, ts}`.
- **`public/option-trades`, `market/option/instrument-family-trades`**: the newest 100.
- **`public/block-trades`**: recent; empty for BTC-USDT-SWAP when asked.
- **`market/index-components?index=`**: an index's exchanges, prices and weights now.
- **`market/trades`, `market/tickers`, `market/books*`, `public/mark-price`, `public/funding-rate`,
  `public/opt-summary`, `public/price-limit`**: of now *(documented)*.
- **The currency-wide statistics** — `rubik/stat/taker-volume`, `margin/loan-ratio`,
  `contracts/long-short-account-ratio`, `contracts/open-interest-volume`, and the option ones — take
  `ccy`, `begin`, `end`, `period` (`5m`, `1H`, `1D`). **They hold the last two days at `5m` and the
  last 180 at `1D`**: without a window, 576 and 180 rows; a window in 2021 is `50030 Illegal time
  range`. 30 days at `1H` *(documented)*.
- **Lending rates — `GET /api/v5/finance/savings/lending-rate-history`**: `ccy`, `after`, `limit` ≤
  100; `{ccy, lendingRate, rate, amt, ts}`, one an hour. 1,500 days back answers (2022-08), 1,800
  does not.

### What a delisted instrument answers

**Nothing.** Bars, mark bars and funding all answer `51001` for a delisted swap or pair, as for a
name that never was.

**A dated future answers for a short while after it is delivered.** One delivered two weeks before
still gave its bars. Older ones are `50047`: "BTC-USD-260626 has already settled. To check the
relevant candlestick data, please use BTC-USD-260904" — the name is given to another contract.

### Against okx's own archive

**REST bars are the archive's bars**, number for number: the archive's `BTC-USDT` one-minute file
for 2026-01-01 and `history-candles` agree on every row checked. The file's day runs 16:00 to 16:00
UTC.

## WebSocket

Verified live on 2026-07-26 on `BTC-USDT-SWAP`: `trades`, `tickers`, `mark-price`,
`open-interest`, `funding-rate`, `bbo-tbt` and `instruments` all accept a subscription and stream.

```json
trades         {"instId":"BTC-USDT-SWAP","tradeId":"2805987683","px":"64472.1","sz":"0.02",
                "side":"buy","ts":"1785060302444","count":"1","source":"0","seqId":331550485845}
mark-price     {"instId":…,"instType":"SWAP","markPx":"64472.0","ts":"1785060301846"}
open-interest  {"instId":…,"oi":"3185878.69","oiCcy":"31858.79","oiUsd":"2054002894.90","ts":…}
funding-rate   {"fundingRate":"0.0000385651416411","fundingTime":…,"nextFundingTime":…,
                "premium":"-0.0005751117670039","interestRate":"0.0001","impactValue":"20000",
                "maxFundingRate":"0.00375","minFundingRate":"-0.00375","method":"current_period",…}
bbo-tbt        {"asks":[["64472.1","820.89","0","36"]],"bids":[["64472","262.68","0","30"]],"ts":…,"seqId":…}
```

**Every subscription names one instrument.** `instId: "ANY"`, `instType` without `instId`, and a
`trades-all` channel are all rejected with `60018`. Instrument-class data is split across four
channels, and `funding-rate` is unusually detailed — premium, interest rate, impact value, the
formula in use and the bounds.

**Limits, from OKX's documentation and not measured:** 3 connection requests per second per IP;
480 subscribe, unsubscribe or login requests per connection per hour; and, for book channels,
under 30 per connection.
