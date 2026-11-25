# Binance

Binance as a source of market data: what it publishes, where, and how it behaves when asked.

## Archives

What Binance's published archive contains, established by asking the archive itself. Where
Binance's documentation says something that was not measured, that is marked.

### Publication

From [Binance Academy](https://www.binance.com/en/academy/articles/how-to-get-trading-data-via-the-binance-api):

> Daily files are updated and available **the day after** trading happens, while monthly files are
> compiled and released on the **first Monday of each month**.

**Daily files, measured.** From the files' own `Last-Modified`, measured on 2026-09-25 over the
457,671 files dated 2026-09-15 to 21, a day's file appears this many hours after the start of the
day it is dated:

| p50 | p99 |
|---|---|
| 32.0 h | 33.6 h |

A file dated D appears between about 08:00 and 09:40 UTC on the day after D.

**Monthly files** are Binance's claim only: the first Monday, which can be as late as the 7th.

### Two renderings of the same period

Most datasets are published **both** as monthly files and as that month's days, for the same
history: the same rows in two shapes. The distinction is a path segment — `data/spot/monthly/…`
against `data/spot/daily/…`.

Not every dataset has both: `metrics`, `bookDepth` and `liquidationSnapshot` publish days only,
and `fundingRate` months only.

### Files carry checksums

Every `.zip` has a `.zip.CHECKSUM` beside it, holding its SHA-256. A listing page of 1,000 keys is
therefore about 500 files.

### Binance announces its own corrections

The [binance-public-data](https://github.com/binance/binance-public-data/) repository keeps an
**Updates** section:

> Archived files may be updated at a later date as a result of recently discovered issues. Below
> is an exhaustive list of updates performed to the archive, containing the file path for
> reference, and CHECKSUMs of the replaced file and the replacement file

Each correction is a dated changelog file in that repository's `updates/` folder. Two are listed:
2022-08-08 `kline_updates.zip`, "Fixed inconsistent data", and 2022-04-21
`aggregate_trade_updates.zip`, aligning to a change in spot aggregate trades. Binance publishes
which already-published files changed; a file corrected in place keeps its key.

### Layout

```
data/spot/{daily,monthly}/{aggTrades,klines,trades}/<SYMBOL>/[<INTERVAL>/]<SYMBOL>-…-<date>.zip
data/futures/{um,cm}/{daily,monthly}/<dataset>/<SYMBOL>/[<INTERVAL>/]…
data/option/daily/{BVOLIndex,EOHSummary}/<SYMBOL>/…
data3/liquidationSnapshot/<SYMBOL>/<SYMBOL>-liquidationSnapshot-<date>.zip
```

Dates trail the filename — `…-2025-03-31.zip` for a day, `…-2025-03.zip` for a month — so keys sort
by symbol first and date last, and a month's files are scattered across a listing rather than
contiguous.

#### `um` and `cm` are two services and two archives

**UM is USDⓈ-margined futures, CM is coin-margined** — Binance's own words — and they are two
services: UM answers at `fapi`, CM at `dapi`, each with its own `exchangeInfo`, and **every
contract is listed by exactly one of them**. The archive mirrors the split: a contract listed by
`fapi` has keys under `data/futures/um/` and none under `data/futures/cm/`, and no symbol has
directories in both.

Neither the margin asset nor the ticker tells them apart:

- **`marginAsset` does not.** `ETHBTC` is a UM contract margined in BTC, a coin.
- **Nor does the ticker.** CM symbols are USD-quoted (`BTCUSD_PERP`, `LTCUSD_210326`), but 41 UM symbol
  directories end in `USD` too, because they end in `BUSD` — `BTCBUSD`, `FTMBUSD`, `MATICBUSD`.

The service that lists a contract is the only exact source.

Binance has [integrated CM into UM's architecture](https://developers.binance.com/en/docs/products/derivatives-trading-coin-futures/Important-CM-UM-Integration-Notice):
`fapi` and `dapi` count into one request-weight budget (see [Its limits](#its-limits)), while
`exchangeInfo` stays separate per service and each contract is listed by one.

As listed in 2026-08, CM held 30 contracts over 20 base assets, all `underlyingType: COIN`; UM held
883, spanning `COIN, EQUITY, CN_EQUITY, HK_EQUITY, KR_EQUITY, COMMODITY, INDEX, PREMARKET`, with a
`TRADIFI_PERPETUAL` contract type — equity and commodity perpetuals are UM contracts.

#### The bucket and its CDN

The archive is the S3 bucket `s3-ap-northeast-1.amazonaws.com/data.binance.vision`.
`data.binance.vision` is CloudFront in front of it: the same files, byte for byte (MD5 = ETag on
both). Only the bucket answers the S3 listing API; Binance's own browsing page lists through the
bucket address and links each file at `data.binance.vision`.

#### Prefixes outside `data/` — one of them holds data that exists nowhere else

The bucket root holds `data/`, `data2/`, `data3/`, a `/`-prefixed tree, and the assets of the
browsing page (`index.html`, `bootstrap.min.css`, `list.js`, …).

`data/` is what Binance's browsing page presents. Everything beside it is publicly reachable and
promised to nobody: it may be removed, rewritten or left inconsistent without notice. Listing
descends only from where it starts, so nothing outside `data/` shows in a listing of `data/`:
`data3/` sits beside `data/` at the bucket root.

**`data3/liquidationSnapshot/` holds the only USDⓈ-margined liquidation snapshots.** 311 symbols —
USDT- and BUSD-margined perpetuals and dated contracts such as `BTCUSDT_240329` — one daily file
each from 2023-06-25 to 2024-03-31, with `.CHECKSUM` sidecars:

| | |
|---|---|
| `data/futures/um/daily/liquidationSnapshot/` | does not exist |
| `data/futures/cm/daily/liquidationSnapshot/` | exists, coin-margined contracts only |
| `data3/liquidationSnapshot/1000FLOKIUSDT/` | exists; the symbol has no liquidation files under `data/` |

Nothing else is under `data3/`.

**`data2/` is a staging area** for spot `aggTrades`, `klines` and `trades`: uncompressed `.csv`
files, many of them beside a `.zip` of the same period, `.CHECKSUM` sidecars and `.DS_Store`
files, all under `data2/data/`.

```
data2/data/spot/klines/1INCHUSDT/12h/1INCHUSDT-12h-2020-12.csv
data2/data/spot/klines/1INCHUSDT/12h/1INCHUSDT-12h-2020-12.zip
data2/data/spot/.DS_Store
```

#### The `/`-prefixed tree is a frozen snapshot of spot

**There are no directories in S3.** Keys are flat strings and `/` is a convention that
`delimiter=/` renders as folders, so a key whose first character is a slash is legal. All of them
group under a `CommonPrefix` of exactly `/`, which is why the bucket root appears to hold one
beside `data/`, `data2/` and `data3/`. The same happens inside `data/`: a stray key
`data/spot/daily//.zip.CHECKSUM` renders as a folder `data/spot/daily//`.

What is under `/`:

```
/data/spot/{aggTrades,klines}/<SYMBOL>/[<INTERVAL>/]…-<yyyy-mm>.zip
137,212 files, 86.7 GB, dated 2017-07 → 2021-01, every key written in 2021-02
```

They fetch with `200`. The URL keeps the double slash — `…/data.binance.vision//data/spot/…`
— because the key starts with one.

**Every file has a same-named counterpart under `data/spot/monthly/`, and none has the same
bytes.** Mapping `/data/spot/X` to `data/spot/monthly/X`, a sample of 150 files found a counterpart
for all of them and the same `etag` for none.

**Opened, they hold the same data or less of it.** In every pair opened, each row under `/` is a
row of its counterpart, value for value:

- **Identical rows in a different zip.** `ELFBTC-aggTrades-2020-12`, `LINKBTC-aggTrades-2018-06`
  and `ETHBTC-1h-2019-03` hold byte-identical CSV; only the zip around it differs, its internal
  timestamp earlier under `/`.
- **Decimal padding.** `BNBBTC-aggTrades-2019-03` holds the same 2,887,541 rows, padded with
  trailing zeros under `/` and trimmed under `data/`:

  ```
  /data/spot/…   32350757,0.00269590,2.00000000,37276017,37276017,1551398401922,False,True
  data/spot/…    32350757,0.0026959,2.0,37276017,37276017,1551398401922,False,True
  ```

- **Missing rows.** `BTCUSDT-1d-2020-05` holds 20 days, from 2020-05-12, against 31.
  `1INCHBTC-1d-2021-01` holds 12 against 31, ending 2021-01-12, and its last row is a *partial*
  candle: the same open, a lower high, under half the volume, 4,383 trades against 11,192.

So the tree is a **snapshot of the spot archive taken around 2021-01-12**. It carries no file and
no value that `data/spot/monthly/` lacks; where the two disagree it holds strictly less.

### Headers

- **Spot files have no header**, in every dataset and over the whole history: trades, aggregated
  trades and klines from 2017-08 to today all start with a data row.
- **Futures trades, aggregated trades, klines and the mark, index and premium klines grew a header
  partway through.** Sampled one file a month on both services, the files are headerless until
  2022, with scattered earlier ones carrying a header (on UM from 2020); every file carries one
  from 2022-06 in the UM monthly trees, from 2022-07 in the CM monthly trees and from 2022-08 in
  the daily trees. No date separates the two eras exactly; only a file's first line says which it is.
- **Every other futures dataset has always had a header**: `bookTicker`, `bookDepth`, `metrics`,
  `fundingRate` and `liquidationSnapshot` carry one from their first file on.

### Spot timestamps change unit in 2025-01

Spot `trades`, `aggTrades` and `klines` carry integer epoch **milliseconds** through the files of
2024-12 and **microseconds** from the files of 2025-01, daily and monthly alike, with no change of
filename or column order, and still no header:

```
BTCUSDT-trades-2024-12-31   4356587539,92792.05000000,0.00129000,119.70174450,1735603200213,False,True
BTCUSDT-trades-2025-01-01   4359935386,93576.00000000,0.00136000,127.26336000,1735689600010866,True,True
BTCUSDT-1m-2025-01          1735689600000000,93576.00000000,…,1735689659999999,…
```

A kline's close time is its open time plus the interval minus one tick, so it ends `…999` before
the change and `…999999` after. Futures files did not change: they carry milliseconds before and after.

### Liquidation snapshots write every row twice

The liquidation files of all three families — `data3/`, and coin-margined perpetuals and dated
contracts under `data/futures/cm/` — share one header of ten columns, `time, side, order_type,
time_in_force, original_quantity, price, average_price, order_status, last_fill_quantity,
accumulated_fill_quantity`, and hold each row twice in a row: `BTCUSDT` 2023-06-25 has 1,720 rows,
860 of them a repeat of the row before; `BTCUSD_PERP` 2024-10-14 has 100 and 50; `BTCUSD_241227`
2024-10-14 has 10 and 5.

### Datasets that ended

Each of these ended on the same date for every symbol checked; nothing has been written to these
trees since. Checked 2026-11-25:

| service | dataset | where | last daily file | last monthly file |
|---|---|---|---|---|
| USDⓈ-margined | `bookTicker` | `data/futures/um/` | 2024-03-30 | 2024-04 |
| USDⓈ-margined | `liquidationSnapshot` | `data3/` | 2024-03-31 | none published |
| coin-margined | `bookTicker` | `data/futures/cm/` | 2024-10-14 | 2024-10 |
| coin-margined | `liquidationSnapshot` | `data/futures/cm/` | 2024-10-14 | none published |
| options | `EOHSummary` | `data/option/daily/` | 2023-10-23 | none published |

The USDⓈ-margined monthly `bookTicker` tree holds a 2024-04 file although its daily tree ends on
2024-03-30.

**`EOHSummary`**, an end-of-hour summary of the options market, has one daily file for each of
BTCUSDT, ETHUSDT, BNBUSDT, XRPUSDT and DOGEUSDT, the first from 2023-05-18. No other underlying
appears.

None of these datasets is derivable from anything else Binance publishes.

### The `1w`, `3d` and `1mo` intervals publish irregularly

They exist on every interval dataset — `klines`, `markPriceKlines`, `indexPriceKlines`,
`premiumIndexKlines` — and no tree carries them on a schedule. Checked 2026-11-25:

- **Futures daily trees** stop in 2023, at different dates per symbol, dataset and interval, with
  scattered later files: UM `BTCUSDT` `klines/1w` ends 2023-06-12 and `klines/3d` has files for
  2023-08-16 and 2023-12-08; CM `BTCUSD_PERP` ends in 2023-09; UM `BTCUSDT` `markPriceKlines/1w`
  has a lone file for 2026-06-29, written 2026-07-23.
- **Futures monthly trees** end around 2024-01 (UM `BTCUSDT`), written in batches — 2023-07 to
  2023-12 all on 2024-01-08 — with gaps and strays: CM `BTCUSD_PERP` `3d` holds 2023-06, 2023-09,
  2023-10 and then 2024-10.
- **Spot monthly trees** carry them late and in batches: `BTCUSDT` and `ETHBTC` hold 2026-07 to
  2026-10, all four months written on 2026-11-10.
- **Spot daily trees** never had them.

Each is an aggregate of the `1m` file of the same dataset, which every tree publishes daily and
complete — spot also has `1s`. `3d` is not a calendar period: it is a stride from a fixed epoch, so
it cannot be re-cut from or into calendar months.

### Discovery

A standard S3 listing: `prefix`, `marker` and `delimiter` all honoured. `max-keys` caps at **1000** —
larger values are echoed back in `<MaxKeys>` and never applied, so a response looks like it worked.
`NextMarker` is returned only when a `delimiter` is sent; without one, the next page starts from
the last key of the page.

A handful of `delimiter=/` requests map the whole archive, down to `option/`, `BVOLIndex`,
`EOHSummary` and `aggTrades`.

### Rate limits

**None documented, and none signalled in responses.** No `x-ratelimit-*`, no `retry-after`, and no
`x-mbx-used-weight` — that header and the documented 429 → 418 ban ladder belong to the REST API
(see [REST](#rest)), which has its own weight accounting.

The [binance-public-data](https://github.com/binance/binance-public-data/) repository documents no
limits, throttling policy or concurrency guidance either. The one relevant community report
([Download limits for data.binance.vision](https://dev.binance.vision/t/download-limits-for-https-data-binance-vision-data-spot/20275))
has a user hitting `SSLEOFError` on bulk downloads, which support attributed to rate limiting; no
Binance staff ever stated a threshold, and that was the CloudFront host, not the bucket.

**Measured 2026-09-29, from one machine, ramping until something gave:**

| request at the bucket | reached | throttling answers | p50 |
|---|---|---|---|
| LIST (`max-keys=1`) | 1,562/s sustained | none in ~1.4 M requests | 272 ms, flat |
| HEAD on a file | 1,788/s | none in ~290 k requests | 267 ms, flat |

From a second machine the same requests reached about 1,200 a second, with no throttling answer
either. Every run ended at the client's own ceiling — 500 requests in flight at ~270 ms each — not
at the bucket's. S3's published ceiling is 5,500 GET/HEAD a second per partitioned prefix. A limit
that exists and was never reached is still possible.

### Scale

Order 10⁸ keys across the whole bucket, about half of them checksum sidecars, so order 10⁵ listing
pages to walk it whole. In 2026-11 the spot trees held about 3,770 symbols, and the whole archive
about 4,600.

## REST

**How to read this section.** A statement with no mark is what the API answered when it was asked,
in October 2026. *(documented)* marks what binance's documentation states and was not tried.
*(not known)* marks what neither settled. Nothing here is inferred from another venue.

### The API

**A service per margin, each with its own host, base path and budget.**

| service | host and base | also |
|---|---|---|
| spot | `https://api.binance.com/api/v3` | `data-api.binance.vision` answers the same public calls |
| USDⓈ-margined futures | `https://fapi.binance.com/fapi/v1` | statistics under `https://fapi.binance.com/futures/data` |
| coin-margined futures | `https://dapi.binance.com/dapi/v1` | statistics under `https://dapi.binance.com/futures/data` |
| options | `https://eapi.binance.com/eapi/v1` | |

- **Spot has more hosts** *(documented)*: `api-gcp.binance.com`, `api1`–`api4.binance.com`.
- **Where they answer from.** `api`, `fapi` and `eapi` are behind CloudFront. `dapi` and
  `data-api.binance.vision` are not: they resolve to AWS `ap-northeast-1`.
- **Times are milliseconds**, in requests and answers.
- **A successful answer is the data itself** — a bare JSON array or object, no envelope.
- **An error is an HTTP status with `{"code": <negative>, "msg": "…"}`.** Seen: 400 `-1130` (a
  parameter out of range), 400 `-1120` (invalid interval), 400 `-1121` (no such symbol), 400 `-4166`
  (window too old), 401 `-2014` (key wanted), 404 with an HTML page (endpoint gone).
- **One endpoint breaks that**: `fundingRate` answers an over-limit `limit` with HTTP 200 and
  `{"status":"ERROR","type":"GENERAL","code":"99099990","errorData":"illegal params."}`.

### Its limits

**Weight per minute, by address**, as `exchangeInfo.rateLimits` states for each service:

| service | `REQUEST_WEIGHT` a minute | header reporting it |
|---|---|---|
| spot | 6,000 (and 300,000 raw requests per 5 minutes) | `x-mbx-used-weight`, `x-mbx-used-weight-1m` |
| USDⓈ-margined | 2,400 | `x-mbx-used-weight-1m` |
| coin-margined | 2,400 | `x-mbx-used-weight-1m` |
| options | 400 | `x-mbx-used-weight-1m` |

- **The header is the weight used so far in the current minute**, and the minute is the clock's:
  mid-run the figure fell from 62 to 24 as a minute turned.
- **`fapi` and `dapi` count into one budget.** A run that left `fapi` at 790 was answered 800 by the
  next call, to `dapi`.
- **`data-api.binance.vision` counts into spot's**: 58 on `api`, then 60.
- **A refused call costs its weight**: a `limit` of 1,501 added 10, a refused `aggTrades` 20, a
  keyless `historicalTrades` 200.
- **Some endpoints report no weight and are outside the budget**: everything under `/futures/data`,
  and `fundingRate` and `fundingInfo`. With `fapi` refused, both still answered.
  - `/futures/data/openInterestHist` took 1,300 calls in 44 seconds without a refusal. What limits
    it *(not known)*.
  - `fundingRate` took 700 calls in 31 seconds without a refusal; 500 per 5 minutes, shared with
    `fundingInfo`, is what is stated *(documented)*.
- **Beyond the budget, the next call is HTTP 429** with `{"code":-1003,"msg":"Too many requests;
  current limit of IP(<address>) is 2400 requests per minute. …"}` — on spot, "Too much request
  weight used; current limit is 6000 request weight per 1 MINUTE". Seen on spot at 6,250, on futures
  at 2,410, on options at 405.
- **`Retry-After` is the seconds left in the clock's minute**, and the service answers again when
  the minute turns. A refused call keeps adding to the header's figure.
- **Going on after a 429** earns 418 and a ban by address, growing from 2 minutes to 3 days
  *(documented)*; not met. 403 is the firewall *(documented)*. Limits are by address, not by key
  *(documented)*.

### How it is paged

- **By time, forward.** `startTime` with `limit` returns the oldest rows from `startTime`; the next
  call starts after the last row. `endTime` alone returns the newest rows up to it. With neither,
  the newest.
- **`startTime=0`** is honoured on bars and taken as absent on `fundingRate`, where `1` gives the
  oldest.
- **By id**, for trades: `fromId` is inclusive, and the next call is the last id plus one.
- **`/futures/data/*` ignores where a window starts**: it returns the newest `limit` rows of
  whatever is asked, so it is walked backward by `endTime`.
- **A `limit` over the maximum** is refused on futures (400 `-1130`) and silently capped on spot and
  options.

### Spot — `https://api.binance.com`

**Bars — `GET /api/v3/klines`**
- **Ask**: `symbol`, `interval` (`1s 1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 3d 1w 1M`), `startTime`,
  `endTime`, `limit` ≤ 1,000 (1,001 returns 1,000).
- **Answer**: rows `[openTime, open, high, low, close, volume, closeTime, quoteVolume, trades,
  takerBuyBase, takerBuyQuote, "0"]`, oldest first — the archive's twelve columns.
- **Reaches**: the pair's first bar; BTCUSDT `1s` from 2017-08-17T04:00:28Z. **Costs** 2.

**Trades — `GET /api/v3/historicalTrades`, `GET /api/v3/aggTrades`**
- **Ask**: `symbol`, `fromId`, `limit` ≤ 1,000; `aggTrades` also takes `startTime`, `endTime`.
- **Answer**: `{id, price, qty, quoteQty, time, isBuyerMaker, isBestMatch}`; aggregated
  `{a, p, q, f, l, T, m, M}` — aggregate id, price, quantity, first and last trade id, time, buyer
  is maker, best match.
- **Reaches 2022-09-02T00:00:00Z and no further**, for a pair older than that: `fromId=0` and
  `fromId=1000` both return BTCUSDT's trade 1,741,118,880 of that instant, ETHBTC's first is of the
  same midnight, and `aggTrades` windows in 2017 and 2020 are empty. A pair listed later starts at
  id 0 (PEPEUSDT, 2023-05-05).
- **No key is asked for.** **Costs** 25, and 4 aggregated.

**Block trades — `GET /api/v3/historicalBlockTrades`**: `symbol`, `fromId`, `limit` ≤ 1,000;
`{id, price, qty, quoteQty, time, isBuyerMaker}`; from id 0 (BTCUSDT has four, the first of
2026-06-04). Costs 25.

**The listing — `GET /api/v3/exchangeInfo`**: `symbols[]` with `status`; no listing date. Costs 20.

### USDⓈ-margined futures — `https://fapi.binance.com`

**Bars — `GET /fapi/v1/klines`**
- **Ask**: `symbol`, `interval` (as spot, without `1s`), `startTime`, `endTime`, `limit` ≤ 1,500.
- **Answer**: the same twelve-column rows, oldest first.
- **Reaches**: the first bar; BTCUSDT 2019-09-08T17:57Z.
- **Costs** 10 at 1,500 and 5 at 1,000; 2 from 100 and 1 below *(documented)*.

**Bars of a pair's contract type — `GET /fapi/v1/continuousKlines`**: `pair`, `contractType`
(`PERPETUAL`, `CURRENT_QUARTER`, `NEXT_QUARTER`), otherwise as bars. `CURRENT_QUARTER` of BTCUSDT
from 2021-02-03T08:20Z; `PERPETUAL` equals the perpetual's own bars.

**Index, mark and premium bars — `GET /fapi/v1/indexPriceKlines`, `markPriceKlines`,
`premiumIndexKlines`**
- **Ask**: `pair` for the index, `symbol` for the other two; otherwise as bars; `limit` ≤ 1,500.
- **Answer**: twelve-column rows whose volume columns are `"0"`; the ninth is the count of samples.
- **Reaches**: BTCUSDT index and mark 2019-12-23T11:58Z, premium 2019-12-24T03:26Z. **Costs** 10.

**Funding — `GET /fapi/v1/fundingRate`**
- **Ask**: `symbol` (optional), `startTime`, `endTime`, `limit` ≤ 1,000.
- **Answer**: `{symbol, fundingTime, fundingRate, markPrice, rateType}`, oldest first. `markPrice`
  is `""` on records of 2019 and 2020 and filled on recent ones; `rateType` was `"Regular"` on
  every record seen.
- **Without `symbol` it returns every symbol's funding in time order.** One instant now holds over
  500 records, and their `fundingTime` is spread over two or three milliseconds (`…000`, `…001`).
- **Without `startTime` at most 500 come back**, whatever `limit` says.
- **Reaches**: the first funding; BTCUSDT 2019-09-10T08:00Z. No weight header.

**Delivery prices — `GET /futures/data/delivery-price`**: `pair`; `{deliveryTime, deliveryPrice}`,
newest first, all in one answer (18 for BTCUSDT, from 2022-12-30).

**Statistics — `GET /futures/data/openInterestHist`, `globalLongShortAccountRatio`,
`topLongShortAccountRatio`, `topLongShortPositionRatio`, `takerlongshortRatio`, `basis`**
- **Ask**: `symbol` (`basis`: `pair` and `contractType`), `period` (`5m 15m 30m 1h 2h 4h 6h 12h
  1d`), `limit`, `startTime`, `endTime`.
- **Answer**, oldest first within the page:
  - open interest `{symbol, sumOpenInterest, sumOpenInterestValue, CMCCirculatingSupply, timestamp}`;
  - the three ratios `{symbol, longAccount, shortAccount, longShortRatio, timestamp}`;
  - taker `{buySellRatio, buyVol, sellVol, timestamp}`;
  - basis `{pair, contractType, futuresPrice, indexPrice, basis, basisRate, annualizedBasisRate,
    timestamp}`.
- **Page**: 500 *(documented)*; `openInterestHist` returned 501 and 1,000 when asked.
- **Reaches 30 days.** A `startTime` or `endTime` older is 400 `-1130`. No weight header.

**Trades — `GET /fapi/v1/aggTrades`**: `{a, p, q, nq, f, l, T, m}`, 1,000 a page. **Two days and no
more**: an older window, or `fromId=1`, is 400 `-4166` "Search window is restricted to recent 2
days only". Costs 20. `GET /fapi/v1/trades` is the newest 1,000. `GET /fapi/v1/historicalTrades`
wants a key (401 `-2014`).

**Liquidations — `GET /fapi/v1/allForceOrders`**: 404 with an HTML page.

**The listing — `GET /fapi/v1/exchangeInfo`**: `symbols[]` with `contractType`, `onboardDate`,
`deliveryDate`, `status`. Costs 1.

**Answers that are only of now**: `fundingInfo` (cap, floor and interval of each symbol),
`insuranceBalance` (a balance for each group of symbols), `constituents?symbol=` (an index's
exchanges, prices and weights), `indexInfo`, `assetIndex`, `premiumIndex`, `openInterest`.

### Coin-margined futures — `https://dapi.binance.com`

- **Bars — `GET /dapi/v1/klines`**: as the USDⓈ service; `limit` ≤ 1,500; BTCUSD_PERP from
  2020-08-11T07:02Z with `startTime=1`. A window of 200 days at most is what is stated; a window of
  1,157 days answered in full.
- **Index, mark and premium bars — `GET /dapi/v1/indexPriceKlines` (`pair`), `markPriceKlines`,
  `premiumIndexKlines`**: BTCUSD index from 2020-06-09T09:32Z, BTCUSD_PERP mark from
  2020-08-11T07:30Z, premium from 2020-11-04T09:23Z. `continuousKlines` `CURRENT_QUARTER` of BTCUSD
  from 2020-06-11T02:06Z. 1,500 a page, weight 10.
- **Funding — `GET /dapi/v1/fundingRate`**: `symbol`, `startTime`, `limit` ≤ 1,000; the same
  record; BTCUSD_PERP from 2020-08-10T16:00Z. It reports weight, 1 a call.
- **Statistics — `GET /futures/data/*`** on this host take `pair` (and `contractType` where the
  USDⓈ ones take none): `openInterestHist` `{pair, contractType, sumOpenInterest,
  sumOpenInterestValue, timestamp}`; `globalLongShortAccountRatio` `{pair, longAccount,
  shortAccount, longShortRatio, timestamp}`; `takerBuySellVol` `{pair, contractType, takerBuyVol,
  takerSellVol, takerBuyVolValue, takerSellVolValue, timestamp}`; `basis`. 30 days, as seen for
  `openInterestHist`.
- **Delivery prices — `GET /futures/data/delivery-price?pair=BTCUSD`**: 18, from 2022-12-30.
- **`aggTrades`**: two days, as above. **`allForceOrders`**: 404.

### Options — `https://eapi.binance.com`

- **Exercises — `GET /eapi/v1/exerciseHistory`**: `underlying`, `startTime`, `endTime`, `limit` (100
  *(documented)*; 101 returned 101); `{symbol, strikePrice, realStrikePrice, expiryDate,
  strikeResult}`, newest first. A window 180 days back answers; one 270 days back is empty. Costs 3.
- **Bars — `GET /eapi/v1/klines`**: `symbol`, `interval`, `limit` (1,500 asked, 1,000 returned);
  twelve-column rows. **Only for a listed contract**: an expired one is 400 `-1121`. Costs 1.
- **Trades — `GET /eapi/v1/trades`**: the newest 100 of a listed contract; an expired one returns
  `[]`. `{id, tradeId, symbol, price, qty, quoteQty, side, time}`. Costs 5.
- **Block trades — `GET /eapi/v1/blockTrades`**: the newest 100, across contracts. Costs 5.
- **Of now only**: `mark` (mark price, implied volatilities and greeks of every contract),
  `openInterest?underlyingAsset=&expiration=`, `exchangeInfo` (`optionSymbols[]`).

### Alpha — `https://www.binance.com/bapi/defi/v1/public`

A separate market, of tokens not listed on spot, with its own public endpoints.

- **Bars — `GET /alpha-trade/klines`**: `symbol` (`ALPHA_<id>USDT`), `interval`, `startTime`,
  `limit` ≤ 1,000. The answer is `{code: "000000", data: [...]}` with the twelve-column rows as
  strings. 1-minute bars from the token's listing, with `startTime=1`.
- **The listing — `GET /wallet-direct/buw/wallet/cex/alpha/all/token/list`**: `{alphaId, symbol,
  name, listingTime, …}` for each token.
- **Also** `alpha-trade/agg-trades`, `ticker`, `fullDepth`, `get-exchange-info` *(documented)*.
- **Its limits** *(not known)*.

### What wants a key

`/sapi/v1/margin/*` (pairs, delist and list schedules, price index) and `/sapi/v1/equity/market/*`
are marked `MARKET_DATA`: an API key, no signature *(documented)*. Not tried.

### The instrument listings

Four hosts, because binance runs a service per margin:

| | endpoint |
|---|---|
| spot | `api.binance.com/api/v3/exchangeInfo` |
| USDⓈ-margined futures | `fapi.binance.com/fapi/v1/exchangeInfo` |
| coin-margined futures | `dapi.binance.com/dapi/v1/exchangeInfo` |
| options | `eapi.binance.com/eapi/v1/exchangeInfo` |

**Names pass through.** The archive files an instrument under the name the API returns — `0GBNB`,
`DOGSUSDT`, `BTCUSDT_230630`.

**A contract's type decides its market, and the service that listed it decides its archive.** Both
futures services mix perpetuals and dated contracts in one answer, told apart by `contractType`;
and every contract is domiciled in exactly one of the two, which is the `um` or `cm` of its path.
Whether it is trading is `status` on one service and `contractStatus` on the other — the same field
under two names.

**Options are listed by contract and filed by underlying**: the 1,862 contracts listed collapse to
the handful of underlyings the archive holds.


## WebSocket

Verified live on 2026-07-26.

**Spot streams at `wss://stream.binance.com:9443/ws`; futures at
`wss://fstream.binance.com/public/ws`, and a wrong futures path fails silently.** `/public/ws` with
a `SUBSCRIBE` frame streams. `/ws` with the same frame connects, acknowledges the subscription with
`{"result":null,"id":1}`, and never sends a frame; `/stream?streams=…`, `/ws/btcusdt@aggTrade` and
`/public/stream?streams=…` connect and send nothing either.

**Subscribing is one frame per request, acknowledged by request id alone:**

```
→ {"method":"SUBSCRIBE","params":["btcusdt@aggTrade"],"id":"btcusdt-aggTrade"}
← {"result":null,"id":"btcusdt-aggTrade"}
← {"e":"aggTrade","E":…,"s":"BTCUSDT",…}
```

- **The ack does not name the channel.** It carries `result` and the request's `id`, nothing else.
- **The id must be an integer or a string matching `^[a-zA-Z0-9-_]{1,36}$`.** A raw stream name as
  the id (`btcusdt@aggTrade`, with its `@`) closes the socket with code 1008.
- **A subscription is not validated.** `btcusdt@nonsense` is answered exactly as a real stream is,
  so neither a successful connection nor an acknowledgement is evidence that data will flow — only
  frames arriving are.

**Not every data frame names its event.** `bookTicker` and partial-depth frames carry no `e`, and
`…@arr` streams send arrays.

**Only summary streams cover every symbol.** `!miniTicker@arr` streams arrays across the whole
market; `!ticker@arr` and `!bookTicker` are acknowledged and send nothing. There is no all-symbol
`aggTrade` or `depth`, so trades and books are one subscription per instrument.

**Mark price is futures-only.** `btcusdt@markPrice` on spot sent nothing in 25 s while `trade` and
`bookTicker` streamed on the same socket.

```json
trade       {"e":"trade","E":…,"s":"BTCUSDT","t":6534153222,"p":"64511.89","q":"0.00288","T":…,"m":false,"M":true}
aggTrade    {"e":"aggTrade","E":…,"s":"BTCUSDT","a":4022483483,"p":"64511.89","q":"0.00288","f":…,"l":…,"T":…,"m":false,"M":true}
bookTicker  {"u":97856816298,"s":"BTCUSDT","b":"64511.88","B":"0.47198","a":"64511.89","A":"8.11666"}
```

`m` — buyer is maker — gives the side.

### A book from `@depth` needs a REST snapshot

`@depth` streams **diffs**, and quantities in each event are absolute for that level — zero removes
it, and being told to remove a level you do not hold is normal. A book is only reconstructible
with the documented snapshot-plus-diff procedure:

1. Subscribe to `<symbol>@depth` and buffer the events.
2. Fetch `https://fapi.binance.com/fapi/v1/depth?symbol=<SYMBOL>&limit=1000` for `lastUpdateId`.
3. Discard buffered events with `u < lastUpdateId`.
4. The first event applied must satisfy `U <= lastUpdateId AND u >= lastUpdateId`.
5. Every later event's `pu` must equal the previous event's `u`; if not, start again from a snapshot.

So `@depth` frames alone do not determine a book: it takes a REST snapshot to start from, and
`U`/`u`/`pu` to check continuity.
