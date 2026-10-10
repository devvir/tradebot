# Binance

Binance as a source of market data: what it publishes, where, and how it behaves when asked.

## Archives

What Binance's published archive actually contains, established by asking Binance rather than by
reading its documentation — except where the documentation says something that cannot be measured,
which is noted as such.

### Publication cadence

From [Binance Academy](https://www.binance.com/en/academy/articles/how-to-get-trading-data-via-the-binance-api):

> Daily files are updated and available **the day after** trading happens, while monthly files are
> compiled and released on the **first Monday of each month**.

Both halves matter for anything deciding when a period is safe to treat as final:

- A day is not published until the following day, so "today" is never available and yesterday may
  not be either, depending on the hour.
- A month is not published on the 1st but on the **first Monday**, which can be as late as the 7th.
  Anything expecting a month to appear at the month boundary will find a gap of up to a week and may
  read it as missing data rather than as data not yet published.

Neither is verified here; both are Binance's own claim.

### Two renderings of the same period

Most datasets are published **both** as monthly files and as that month's days, for the same
history. They are the same trades in two shapes, so taking both stores everything twice.

The distinction is a path segment — `data/spot/monthly/…` against `data/spot/daily/…` — which is
what the prospector's `tagOf` reads. Where a consumer draws the line between them is its own
policy; the catalog records both and takes no view.

Not every dataset has both: `metrics` and `bookDepth` publish days only.

### Files carry checksums, and half of every listing is one

Every `.zip` has a `.zip.CHECKSUM` beside it, SHA-256. Consequences:

- A listing page of 1000 keys is only ~500 files. Anything reasoning about page counts against file
  counts must halve one of them.
- The sidecars are never catalogued: `.CHECKSUM` is excluded at every venue, before any venue's
  `inspectUrl` sees the path.

### Binance announces its own corrections

The [binance-public-data](https://github.com/binance/binance-public-data/) repository keeps an
**Updates** section:

> Archived files may be updated at a later date as a result of recently discovered issues.

Corrections are dated and packaged — a 2022-08-08 "fixed inconsistent data", a 2022-04-21
realignment to a change in spot aggregate trades — with the affected files published under an
`/updates` folder as, for example, `2022-08-08_kline_updates.zip`, each with its checksums.

**This is the only venue here that tells us which already-published files changed.** It is the cheap
answer to the one case a marker-based refresh structurally cannot see: an in-place change, where the
key stays and the bytes move. Worth using when in-place changes start mattering — treated as a hint
rather than truth, like every venue-published index we have examined, and kept behind a generic
"does this venue announce changes" seam rather than a branch in shared code.

### Layout

```
data/spot/{daily,monthly}/{aggTrades,klines,trades}/<SYMBOL>/[<INTERVAL>/]<SYMBOL>-…-<date>.zip
data/futures/{um,cm}/{daily,monthly}/<dataset>/<SYMBOL>/[<INTERVAL>/]…
data/option/daily/{BVOLIndex,EOHSummary}/<SYMBOL>/…
```

#### `um` and `cm` are one market and two archives

**UM is USDⓈ-margined futures, CM is coin-margined** — binance's own words — and they are two
products, not two folders for one. UM answers at `fapi`, CM at `dapi`, and **every contract is
domiciled in exactly one of them**. The archive mirrors that split: `data/futures/um/` and
`data/futures/cm/`.

The catalog collapses both into the canonical market `perp`, which is right for answering questions:
both are perpetual swaps, and a consumer asking for `perp` wants both. It is wrong for *creating*
series, because the two are separate keyspaces — a contract listed by `fapi` can never have a key
under `cm/`.

So the instruments hook records **which endpoint listed a contract** as its `category`, the adapter's
`categoryOf` reads the margin segment back out of a pattern, and the preamble refuses the pairs that
disagree. Nothing is inferred from the symbol, and the reason is measured rather than stylistic:

- **`marginAsset` does not separate them.** `ETHBTC` is a UM contract margined in BTC, a coin — so
  "margined in a coin ⇒ CM" misclassifies it.
- **Nor does the ticker.** CM symbols are USD-quoted (`BTCUSD_PERP`, `LTCUSD`), but 43 UM symbols end
  in `USD` too, because BUSD does — `BTCBUSD`, `FTMBUSD`, `MATICBUSD`.
- **The endpoint is exact and free.** It is binance's own assignment, known at the moment the
  contract is read.

Binance is [integrating CM into UM's architecture](https://developers.binance.com/en/docs/products/derivatives-trading-coin-futures/Important-CM-UM-Integration-Notice)
— progressive from 2026-06-24, fully effective 2026-06-30 — sharing rate limits, merging market-data
streams, and letting some endpoints accept both symbol types. The `exchangeInfo` endpoints stay
separate and each contract keeps one domicile, but it is another reason not to pin this to a naming
convention: conventions under active unification are exactly what breaks quietly.

Left unfiltered this cost real work. The one perp listed on 2026-08-31 got **260 series — 130 of them
under `cm/`**, describing keys that market has never held; each is a `404` a day for ever, since a
series that has never published has no end to reach and nothing retires it.

CM is also small and closed: 30 contracts over 20 base assets, all `underlyingType: COIN`. UM is 883
and growing, spanning `COIN, EQUITY, CN_EQUITY, HK_EQUITY, KR_EQUITY, COMMODITY, INDEX, PREMARKET`
with a `TRADIFI_PERPETUAL` contract type — equity and commodity perps live there.

**Surveyed from the bucket root, and nothing is stripped.** Starting at `data/` would make
`data3/liquidationSnapshot/` permanently invisible, and descent recovers nothing above where it is
told to begin. Paths therefore keep their leading segment and stay self-describing, reconstructing
as `base` + `/` + `path` — which a stripped multi-root scheme could not do, since it would not know
which root to put back.

The archive is addressed at its bucket, `s3-ap-northeast-1.amazonaws.com/data.binance.vision`, for
listing, probing and downloading alike. `data.binance.vision` is CloudFront in front of the same
bucket — the same files, byte for byte (MD5 = ETag on both) — and nothing here goes through it.

What the adapter refuses, since surveying the root also reaches things that are not archive:

```
data2/…                 staging
data3/<file>            a stray key directly under data3; only its subdirectories hold data
```

The browsing UI's own assets need no rule — `index.html` and friends carry no date, so they are
declined for the same reason checksums are.

Dates trail the filename — `…-2025-03-31.zip` for a day, `…-2025-03.zip` for a month — so keys sort
by symbol first and date last, and a month's files are scattered across a walk rather than
contiguous.

#### Prefixes outside `data/` — one of them holds data that exists nowhere else

The bucket root holds more than `data/`: `data2/`, `data3/`, a `/`-prefixed variant, and the web
assets serving the browsing UI (`index.html`, `bootstrap.min.css`, …).

The distinction that matters is **offered against merely reachable**. `data/` is what binance's own
site presents, and carries whatever assurance an announced service implies. Everything beside it is
publicly reachable and promised to nobody — it may be removed, rewritten or left inconsistent
without notice. That is not a reason to ignore it; it is a reason to take it *sooner*, since nothing
says it will be there next month.

**`data3/liquidationSnapshot/` is real, and unique.** 311 symbols, hundreds of daily files each with
`.CHECKSUM` sidecars, back to mid-2023 — order 60k files. The symbols are USDT-margined, and the
measurement that settles it:

| | |
|---|---|
| `data/futures/um/daily/liquidationSnapshot/` | **0 symbol directories — does not exist** |
| `data/futures/cm/daily/liquidationSnapshot/` | exists, coin-margined only |
| `data3/liquidationSnapshot/1000FLOKIUSDT/` | exists; the same symbol is absent from `data/` |

**Every liquidation row is written twice.** The files of all three families — `data3/`, and
coin-margined perpetuals and dated contracts under `data/futures/cm/` — share ten columns, `time, side,
order_type, time_in_force, original_quantity, price, average_price, order_status, last_fill_quantity,
accumulated_fill_quantity`, and hold each row twice in a row: `BTCUSDT` 2023-06-25 has 1,720 rows of
which 860 repeat the one before, `BTCUSD_PERP` 2024-10-14 100 and 50.

So the USDT-margined liquidation snapshots live *only* in `data3/`. This also corrects an earlier
note that "liquidationSnapshot exists only under `cm`" — true of `data/`, false of the bucket.

### Shapes that stopped, and shapes that never started

**`bookTicker` and `liquidationSnapshot` ended, cleanly and per service.** Every USDⓈ-margined
symbol's last file is 2024-03-30 for quotes and 2024-03-31 for liquidations; every coin-margined
one's is 2024-10-02 and 2024-10-14. A cliff shared by every symbol of a service is a product
decision, not an outage, and nothing has been written to either tree since.

**`data/option/daily/EOHSummary/` ran five months** — an end-of-hour summary of the options market,
one file a day for each of BTCUSDT, ETHUSDT, BNBUSDT, XRPUSDT and DOGEUSDT, from 2023-05-18 to
2023-10-23. Five series in total; no sixth underlying ever appeared.

None of these is derivable from anything else binance publishes, so the files are catalogued and
kept. What ends is the asking: their eight shapes are **seeded retired** at the dates above, because
an instrument binance still lists otherwise keeps its dead shapes open for ever.

**The `1w`, `3d` and `1mo` intervals are an abandoned experiment, and are refused outright.** They
exist on every interval dataset — `klines`, `markPriceKlines`, `indexPriceKlines`,
`premiumIndexKlines` — and publish nowhere reliably:

- the futures daily trees stop on 2023-06-12 and then emit a single 334-byte file on 2026-06-29,
  uploaded in July 2026;
- spot carries them only in the monthly tree, months behind, ending on a different date for each
  symbol and each interval — `BTCUSDT/3d` at 2026-07 while `BTCUSD/3d` stops at 2026-04;
- spot's *daily* tree never had them at all.

Every one of them is an aggregate of the `1m` variant of the same dataset, which binance publishes
complete and this catalog holds — spot even has `1s`. `3d` is not a calendar period either: it is a
stride from an arbitrary epoch, so it cannot be re-cut to anything else. `accepts` drops the
interval as a path segment, which covers both trees and all four datasets in one rule.

Left live they were the venue's largest single waste: 3,761 series whose tips sat frozen fifteen
days behind the frontier, re-asking every open day, for **some 55% of the whole nightly update**.
Refused, they are 51 patterns and 22,155 series fewer.

**`data2/` is a staging area** and can be ignored: uncompressed `.csv` files sitting beside their
own `.zip` for the same period, a `.DS_Store`, everything dated 2020-10 to 2020-12.

```
data2/data/spot/klines/1INCHUSDT/12h/1INCHUSDT-12h-2020-12.csv
data2/data/spot/klines/1INCHUSDT/12h/1INCHUSDT-12h-2020-12.zip
data2/data/spot/trades/.DS_Store
```

The lesson generalises past binance: **descent guarantees nothing above where it is told to
start**, so a hardcoded root reintroduces one level up precisely the omission descent exists to
prevent. Binance now surveys from the bucket root and filters, which is why `data3/` is visible at
all. HTX was checked the same way and was hiding a second archive six years deep, so it surveys from
its root too. KuCoin was checked and is clean — its bucket root holds `data/` and nothing else.

#### The `/`-prefixed tree — a frozen snapshot, refused

**There are no directories in S3.** Keys are flat strings and `/` is a convention that
`delimiter=/` renders as folders, so a key whose first character is a slash is perfectly legal. All
of them group under a `CommonPrefix` of exactly `/`, which is why the bucket root appears to serve
one alongside `data/`, `data2/` and `data3/`. It is not a folder; it is the shadow of keys that begin
with a slash — most likely a path-join bug in whatever uploaded them.

What is under it, measured:

```
/data/spot/{aggTrades,klines}/<SYMBOL>/[<INTERVAL>/]…-<yyyy-mm>.zip
137,212 files, 86.7 GB      2017-07 → 2021-01, then nothing
```

Both trees fetch with `200`. The reconstructed URL keeps the double slash —
`data.binance.vision//data/spot/…` — and resolves, because the key genuinely starts with one.

##### Every filename is duplicated, and so is every value inside

Compared across the whole tree, mapping `/data/spot/X` to `data/spot/monthly/X`:

| | |
|---|---|
| files under `/data/spot/` | 137,212 |
| with a same-named counterpart under `data/spot/monthly/` | **137,212 — all of them** |
| with the same `etag` | **0** |

Different bytes throughout, which for a long time was where the question stopped: a different
`etag` at the same `size` is consistent with recompression, a different size is not, and nobody had
opened a file from either tree.

**Opened, they turn out to hold the same data.** The bytes differ for two reasons, neither of them
new information.

**Decimal padding.** Every value matches; only the rendering moved. Binance re-issued the archive in
2021-05 — visible in the zips' own internal timestamps, 2021-01-16/17 against 2021-05-05 — and
trimmed the trailing zeros:

```
/data/spot/…   0,0.14000000,74.30000000,0,0,1553659205228,False,True
data/spot/…    0,0.14,74.3,0,0,1553659205228,False,True
```

Three `aggTrades` pairs compared in full: same row counts, and **byte-identical once the padding is
normalised**.

**Truncation, where the freeze caught a month in flight.** `1INCHBTC-1d-2021-01` holds 12 rows here
against the official 31, ending 2021-01-12 rather than 2021-01-31 — and its last row is a *partial*
candle, same open, lower high, a third of the volume, 4,383 trades against 11,192.

So the tree is a **snapshot of the spot archive frozen around 2021-01-12**. It carries no file the
official tree lacks and no value it lacks either; where the two disagree it holds strictly less.

**It is refused, in `accepts`.** A key beginning with `/` is not surveyed, so nothing re-adds it, and
the 137,212 rows an earlier walk recorded were deleted along with their 16 patterns and 11,239
series. This is the rare exclusion of something that *is* historical data — earned not by the
`etag` comparison, which says only that the bytes differ, but by reading both renderings and finding
one to be the other with less of it.

### Discovery

A standard S3 listing: `prefix`, `marker` and `delimiter` all honoured. `max-keys` caps at **1000** —
larger values are echoed back in `<MaxKeys>` and never applied, so a response looks like it worked.
`NextMarker` is returned only when a `delimiter` is sent; without one, pagination continues from the
last key of the page.

Ten `delimiter=/` requests map the whole archive, and doing it that way rather than listing datasets
in code is what surfaced `option/`, `BVOLIndex`, `EOHSummary` and `aggTrades` — none of which were
being collected.

### Rate limits

**None documented, and none signalled in responses.** No `x-ratelimit-*`, no `retry-after`, and
notably no `x-mbx-used-weight` — that header and the documented 429 → 418 ban ladder belong to
`api.binance.com`, which is a different service with its own weight accounting. The archive is an
anonymous public S3 bucket fronted by CloudFront.

The [binance-public-data](https://github.com/binance/binance-public-data/) repo documents no limits,
throttling policy or concurrency guidance either. The one relevant community report
([Download limits for data.binance.vision](https://dev.binance.vision/t/download-limits-for-https-data-binance-vision-data-spot/20275))
has a user hitting `SSLEOFError` on bulk downloads which support attributed to rate limiting, but no
Binance staff ever stated a threshold — and that was the CloudFront download host, not the S3
listing endpoint.

**Measured 2026-09-29, from one machine, ramping until something gave:**

| request at the bucket | reached | throttling answers | p50 |
|---|---|---|---|
| LIST (`max-keys=1`) | 1,562/s sustained | none in ~1.4 M requests | 272 ms, flat |
| HEAD on a file | 1,788/s | none in ~290 k requests | 267 ms, flat |

From a remote machine the same requests reached about 1,200 a second, with no throttling answer
either. Every run ended at the client's own ceiling — 500 requests in flight at ~270 ms each — not at the
bucket's. S3's published ceiling is 5,500 GET/HEAD a second per partitioned prefix.

**The connect timeouts that once looked like a limit were the client.** The bucket is ~260 ms away,
and Node's default connection behaviour gives each resolved address 250 ms before trying the next: a
new connection abandoned seven of the bucket's eight addresses just short of their reply and took
~2 s. With that off, a new connection takes one round trip.

A limit that exists and was never reached is still possible. Transport errors and 5xx/429 are
retried with jittered exponential backoff, so throttling would degrade into slowness rather than
lost data.

### Scale

Order 10⁸ keys across the whole bucket, of which about half are checksum sidecars. At 1000 keys a
listing page, that is order 10⁵ pages to walk the bucket whole — which is why it is catalogued by
prefix walks rather than by asking each of ~3,700 symbols what it holds for each month.

### Its raw cannot be reclaimed yet

Binance was downloaded **symbol-first rather than month-first**, so it holds symbols complete from
their start through 2026-07 and **no closed months at all**. Month-completeness is the unit cold
storage works in, so none of it is packable and none of it is evictable.

The files are the right files in the right paths — nothing about them is wrong and nothing about
them should be deleted. It becomes evictable as the month-first flow closes those months one at a
time.

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

**Liquidations — `GET /fapi/v1/allForceOrders`**: gone; 404 with an HTML page.

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

Verified live on 2026-07-26, while surveying what a WebSocket collector would add to the archive.

**The futures endpoint is `wss://fstream.binance.com/public/ws`, and a wrong path fails silently.**
`/public/ws` with a `SUBSCRIBE` frame streams. `/ws` with the same frame connects, acknowledges the
subscription with `{"result":null,"id":1}`, and never sends a frame; `/stream?streams=…`,
`/ws/btcusdt@aggTrade` and `/public/stream?streams=…` connect and send nothing either.

**Binance acknowledges subscriptions it will never honour.** `btcusdt@nonsense` is answered exactly
as a real stream is, so neither a successful connection nor an acknowledgement is evidence that
data will flow — only counting frames is. Every other venue surveyed rejects an unknown channel.

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

So an archive of `@depth` frames alone cannot be replayed: it needs periodic REST snapshots
interleaved with the diffs, and `U`/`u`/`pu` kept so a reader can check continuity.
