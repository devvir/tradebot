# REST: what the venues' APIs offer of history

The survey a REST collector waits on. Seven venues, asked what their public, free APIs serve of the
past, each answer set against what that venue's archive already holds. Done twice over, on
2026-10-09 and 10: once to find what there is, once to read every documented endpoint again and
to run each venue into its limits.

**History that goes back years is rare over REST, and it is mostly derived prices.** Mark and index
bars at four venues, funding at three, open interest at one. Nearly everything else an API serves
of the past is a window of days or months.

**Where each fact is written.** What a venue's API is — hosts, limits, paging, every endpoint, its
record and how far back it goes — is in that venue's doc, `docs/venues/<VENUE>.md`, under `REST`,
with each statement marked as seen, documented or not known. This document compares the venues,
sizes what is worth fetching, and says what a collector has to cope with. The short version is
`docs/REST.md`.

---

## Why REST, and where it sits

A venue can be collected from three places, preferred in this order:

| | | cost |
|---|---|---|
| 1 | **archives** — files the venue publishes | cheapest: one file is hours of an API |
| 2 | **REST history** — paginated endpoints | rate-limited; what is one file there is hours of pages here |
| 3 | **websocket** — live streams | dearest: what is not collected while it is down is gone |

**History only, public and free.** An endpoint that answers "as of now" is listed only where
polling it is the sole way to have that dataset at all.

## The answer

### History that goes back years, and the archive lacks

"At the limit" is the time to fetch all of it at the venue's rate limit; "stored" is the answers
gzip-compressed, as they travelled. How these are worked out is under *What is seen, what is
computed* below.

| venue | dataset | reaches back to | for which instruments | pages | at the limit | stored |
|---|---|---|---|---|---|---|
| **bybit** | funding | first funding (2018-11) | every contract, delisted too | 16k | 2 min | 0.03 GB |
| | open interest, 5 min | 2020-08-05 | **listed contracts only** | 789k | 1.8 h | 3.5 GB |
| | long/short account ratio, 5 min | 2020-08-05 | listed only | 316k | 44 min | 1.9 GB |
| | mark bars, 1 m | the contract's first day | every contract, delisted too | 1,111k | 2.6 h | 24 GB |
| | index bars, 1 m | the contract's first day | every contract, delisted too | 1,111k | 2.6 h | 24 GB |
| | premium bars, 1 m | the contract's first day | listed (a delisted one's were zeros) | 1,058k | 2.5 h | 7.4 GB |
| | spot bars, 1 m, before its trades archive | 2021-07 → 2022-11 | every pair, delisted too | ≤ 114k | 16 min | ≤ 2.2 GB |
| | historical volatility, hourly | 2020-10 at least | a base coin | few | — | small |
| **okx** | mark bars, 1 m | 2020-01 | **listed instruments only** | 1,661k | 46 h | 8.5 GB |
| | index bars, 1 m | 2018-06 (BTC-USD), 2021-07 (USDT indices) | listed only | ~1,576k | 44 h | 9 GB |
| | swap bars before the archive's | 2020-01 → 2021-09 | listed only | 128k | 3.5 h | 1.3 GB |
| **bitget** | mark bars, 1 m | the contract's first month (2019-07) | listed only | 3,179k | 44 h | 12 GB |
| | index bars, 1 m | the contract's first month | listed only | 3,179k | 44 h | 9.5 GB |
| **kucoin** | spot bars, 1 m, before its archive | 2017-10 → 2022-12 | **listed pairs only** | ≤ 236k | 3 h | ≤ 9 GB |
| | futures funding | 2020-01 at least | every contract, delisted too | 19k | 24 min | 0.01 GB |
| | futures premium index, 1 m | 2020-06 at least | listed (delisted not tried) | 6,736k | 84 h | 5.4 GB |
| **htx** | funding | first funding (2020-03) | listed contracts only | 3.9k | 1 min | 0.01 GB |
| **gate** | index bars, 1 m, of its option underlyings | 2022-05 (BTC) | the 12 underlyings | ≤ 14k | 12 min | ≤ 0.5 GB |
| | option settlements | 2022-09 | an underlying | few | — | small |
| **binance** | — | | | | | |

- **Binance's API has no history its archive lacks.** Its spot trades over REST even start later
  than the archive's, on 2022-09-02.
- **Trades are in no API**, beyond a window — binance spot's reach 2022-09-02, short of its
  archive. The archives are where trades are.
- **"Listed only" is a deadline, not a detail.** At okx, bitget, htx and kucoin's spot a delisted
  instrument answers as if it never existed, and at bybit its open interest and ratios are gone. What
  is not fetched while the instrument is listed cannot be fetched afterwards.

### What is only a window

Not history: each is the last so many days or points, and older is refused or empty.

| venue | what | how much |
|---|---|---|
| binance | open interest, long/short ratios, taker volume, basis | 30 days |
| | futures trades | 2 days |
| | option exercise records | 6 to 9 months |
| bybit | option delivery prices | the last 50 |
| okx | funding, trades, insurance fund, deliveries and settlements | 3 months |
| | premium | 6 months |
| | open interest and ratios, by instrument | 1,440 points: 5 days at 5 min, 60 at 1 h; daily since 2024-02 |
| | open interest and ratios, by currency | 2 days at 5 min, 180 at 1 d |
| | liquidations | under a day |
| gate | bars of every kind | 10,000 points: a week at 1 m |
| | funding, contract statistics, futures trades, premium index | 180 days |
| | liquidation orders | about 11 months |
| | spot trades | 30 days |
| htx | spot bars; mark, index, premium, estimated-rate and basis bars | the last 2,000 points |
| | liquidation orders, settlements | 90 days |
| | open interest | 200 points |
| kucoin | futures bars below 8 hours — trade, mark, index, premium | since 2024-12 |
| | index at 1 second, with constituents | about 100 days |
| | open interest | 7 days |
| bitget | funding, trades | 90 days |
| | recent bars (`candles`), interest rate | a month |
| | liquidations | 3 days |
| | ratios, taker volume | 30 points |

### What no REST API gives at all

- **Liquidations** at binance, whose endpoint is gone, and at bybit and kucoin, which document
  none.
- **Open interest finer than a day and older than six months**, anywhere but bybit — and binance's
  archive.
- **Open interest as a history** at bitget: the value now is all there is.

## How it was established

- The venue's documentation, fetched and kept as text, every endpoint in it read, and every
  statement that bears on history tried.
- A live call for each claim: the request, the status, the timings, the headers and the body, all
  recorded. About 15,000 calls, two thirds of them in the runs into the limits.
- For a dataset the archive also has, a file from the archive set against the same period over REST.
- Each venue run into its limit on purpose, once per budget, to see the refusal and how long it
  lasts.

### What is seen, what is computed, what is assumed

**Seen** — answered so by the API: every depth, page size, record, error and refusal stated in the
venue docs without a mark, and every limit in the table of limits below.

**Documented, not tried** — marked so in the venue docs. The ones that matter: binance's 418 ban,
bybit's ten-minute wait (not met when its limit was), okx's 30 days of hourly currency statistics.

**Computed**, from what was seen:

- **Instrument-days**: the sum, over a venue's instruments, of the days each has existed. From the
  venue's listing where it carries dates (bybit, gate, htx, kucoin futures). Where it does not, from
  the first bar of every instrument, one call each (kucoin spot, okx, bitget, bybit spot). Where a
  venue forgets delisted instruments, they are not in the count — and not fetchable either.
- **Records** = instrument-days × records a day: 1,440 for 1-minute bars, 288 for 5-minute series.
- **Pages** = records ÷ the page size seen. **At the limit** = pages ÷ the limit seen.
- **Stored** = records × the gzip-compressed bytes per record of a page actually received.

**Assumed**, and so the softest numbers here:

- **Funding at 4 records a day** on average, between the 3 of an 8-hour contract and the 6 of a
  4-hour one. Half of bybit's and kucoin's contracts are now on 4 hours.
- **Bars as dense**: every minute of an instrument's life counted. Kucoin's spot bars exist only
  for minutes that traded, so its figures are upper bounds, marked ≤.
- **One okx index for each swap.** The number of indices was not counted.
- **A delisted instrument counted as living to now** in the first-bar sweeps (bybit spot): an upper
  bound, marked ≤.

**The link, not the venue, sets the real time for most of it.** One connection does 1.5 to 4 pages a
second, a round trip being 250 to 700 ms. From this machine 5 connections did 12.6 pages a second
of 1,500 bars, 10 did 27 small calls a second, and with nothing else on the line 64 did 130. The
exceptions, where the venue's limit binds first: okx (10 pages a second on bars), bitget (5 a
second on trade bars, 20 on mark and index), binance futures (4 pages of 1,500 a second).

---

## Binance

### The API

- **A service per margin, each its own host and limit.** `api.binance.com` (spot, `/api/v3`),
  `fapi.binance.com` (USDⓈ-margined, `/fapi/v1` and `/futures/data`), `dapi.binance.com`
  (coin-margined, `/dapi/v1`), `eapi.binance.com` (options, `/eapi/v1`).
- **Limits are weight a minute, by address**, read from `exchangeInfo.rateLimits`: spot 6,000,
  futures 2,400, options 400. Each call costs a weight that grows with its `limit`: futures bars cost
  10 for 1,500, spot bars 2 for 1,000. `x-mbx-used-weight-1m` reports the minute so far. The window
  is the clock's minute.
- **`fapi` and `dapi` share one counter**: a run that left `fapi` at 790 was answered 800 by the
  first call to `dapi`. `data-api.binance.vision` shares spot's.
- **A refused call still costs its weight**, an over-limit `limit` included.
- **`/futures/data/*` and `fundingRate` report no weight at all.** The documentation gives
  `fundingRate` 500 calls per 5 minutes, shared with `fundingInfo`.
- **Refusal, seen on all three budgets**: HTTP 429, `code -1003`, with `Retry-After` counting the
  seconds to the minute's turn, when the service answers again. Going on regardless earns 418 and a
  ban of 2 minutes to 3 days *(documented)*; not met.
- **Outside the weight budget altogether**: `/futures/data/*` took 1,300 calls in 44 seconds and
  `fundingRate` 700 in 31, unrefused, the latter against a documented 500 per 5 minutes.
- **Pagination by time, oldest first**: `startTime` and `limit`. `startTime=0` is taken as absent on
  `fundingRate` (`1` works). The `/futures/data/*` family is the exception: it returns the newest
  rows whatever `startTime` says, so it is walked backward by `endTime`.
- **Servers.** Spot, USDⓈ futures and options answer from CloudFront (edge BCN50), 240 ms behind
  it. `dapi` and `data-api.binance.vision` resolve straight to AWS `ap-northeast-1`: 225 ms to
  connect.

### Datasets

| dataset | endpoint | page | from | in the archive? | verdict |
|---|---|---|---|---|---|
| bars, spot | `/api/v3/klines` | 1,000 | 2017-08 | yes, the same 12 columns | nothing to collect |
| trades, spot | `/api/v3/historicalTrades`, `aggTrades` | 1,000, by id | **2022-09-02** | yes, from 2017 | archive is fuller |
| block trades, spot | `/api/v3/historicalBlockTrades` | 1,000, by id | 2026-06 | no | 4 records for BTCUSDT |
| bars, futures | `/fapi/v1/klines`, `continuousKlines` | 1,500 | 2019-09 | yes | nothing |
| index, mark, premium bars | `/fapi/v1/{index,mark}PriceKlines`, `premiumIndexKlines` | 1,500 | 2019-12 | yes | nothing |
| funding | `/fapi/v1/fundingRate` | 1,000, all symbols at once | 2019-09 | yes | REST adds `markPrice`; the archive has the interval |
| trades, futures | `/fapi/v1/aggTrades` | 1,000 | **2 days** | yes | archive |
| open interest, ratios | `/futures/data/openInterestHist`, `*LongShort*Ratio` | 500 | 30 days | yes, since 2020-09 | REST adds taker volumes in absolute terms |
| basis | `/futures/data/basis` | 500 | 30 days | no | rolling |
| delivery prices | `/futures/data/delivery-price` | all at once | 2022-12 | no | 18 rows a pair |
| liquidations | `/fapi/v1/allForceOrders` | — | **gone (404)** | until 2024-10 | websocket only |
| option exercises | `/eapi/v1/exerciseHistory` | 100 | 6–9 months | no | rolling |
| option bars, trades | `/eapi/v1/klines`, `trades` | 1,000 | **listed contracts only** | no | an expired option answers nothing |
| snapshots | `insuranceBalance`, `constituents`, `fundingInfo`, `eapi/mark` | — | now | no | polled or not had |

- **Spot trades start on 2022-09-02 over REST.** `fromId=0` and `fromId=1000` both return trade
  1,741,118,880 of that midnight for BTCUSDT, and windows in 2017 and 2020 are empty. A pair listed
  later starts at id 0. Nothing documents it.
- **`fundingRate` without a symbol returns every symbol**, in time order, 1,000 a page: the whole
  venue's funding is 4,000 pages. One instant now holds over 500 records, spread over two
  milliseconds.

### Documentation

- **Spot: excellent**, plain markdown on GitHub. **Futures and options: unreadable by a script** —
  the site answers with a challenge — but Binance's own connector repository carries each
  endpoint's notes.
- **Differs from it**: the 2022-09-02 floor; `openInterestHist` returns 1,000 where 500 is the stated
  maximum; `fundingRate` answers an over-limit `limit` with HTTP 200 and an error body, returns at
  most 500 without `startTime`, and is not held to its stated 500 calls per 5 minutes; coin-margined
  bars answer a window of 1,157 days where 200 is the stated most.

### Behaviour

2,629 calls, no failure but the refusals provoked. Futures bars at 1,500 a page: 2.4 pages a second
on one connection, p50 483 ms; 12.6 a second on five. The weight ceiling is 4 such pages a second,
for `fapi` and `dapi` together.

**Also there, and not in the archive**: coin-margined index, mark and premium bars (from 2020), as
on the USDⓈ service; and Binance Alpha, a separate market of unlisted tokens with public 1-minute
bars from each token's listing.

---

## Bybit

### The API

- **One API, one host**: `api.bybit.com/v5/market/*`, asked a `category` at a time — `spot`,
  `linear`, `inverse`, `option`. `api.bytick.com` answers the same.
- **One limit for everything: 600 calls per 5 seconds by address.** Public calls carry no limit
  header; the `X-Bapi-Limit-*` headers are for signed ones.
- **Refusal, seen**: HTTP 403, plain text, "Access too frequent. Please try again later.", after
  some 290 calls a second. It did not last — the host answered the next call, and one 30 seconds
  later — where a wait of at least 10 minutes is what is stated.
- **Errors are HTTP 200** with `retCode` other than 0. An over-limit `limit` is silently capped.
- **Lists come newest first.** Two ways through them: a time window (`start`/`end`, or
  `startTime`/`endTime`), and for open interest and ratios also a cursor.
- **Servers**: CloudFront (edge BCN50), 187 ms behind it.

### Datasets

| dataset | endpoint | page | walked | from | in the archive? | verdict |
|---|---|---|---|---|---|---|
| bars | `kline` | 1,000 | forward by `start` | linear 2020-03, inverse 2018-11, spot 2021-07 | 5 intervals, a few symbols, to 2025-11 | **every contract, to now** |
| mark, index, premium bars | `mark-price-kline`, `index-price-kline`, `premium-index-price-kline` | 1,000 | forward | 2020-03 | index and premium for a few symbols, to 2024-09 | **collect** |
| funding | `funding/history` | 200 | backward by `endTime` | 2018-11 / 2020-03 | no | **collect** |
| open interest | `open-interest` | 200 | cursor or window | 2020-08-05 | no | **collect, before delisting** |
| long/short ratio | `account-ratio` | 500 | cursor or window | 2020-08-05 | no | **collect, before delisting** |
| historical volatility | `historical-volatility` | 30-day window | by window | 2020-10 at least | no | small |
| delivery prices | `delivery-price` | 200 | cursor | 2021-06 | no | small |
| trades | `recent-trade` | 1,000 (spot 60) | — | now | yes | archive |
| instruments | `instruments-info` | 1,000 | cursor | — | — | `status=Closed` lists delisted contracts, with launch and delivery times |

- **A delisted spot pair keeps its bars too**, though the listing shows only what trades.
- **A delisted contract keeps its bars and its funding, and loses its open interest and ratios**:
  for `10000000AIDOGEUSDT`, closed 2025-04-28, trade, mark and index bars and funding answer, and
  the last two are empty. So those two are a history only for what is still listed. Its premium
  bars answer too, and every one tried was zero.
- **`funding/history` needs a symbol and an `endTime`**: `startTime` alone is refused, and there is
  no call for all symbols.
- **`start=1` is not honoured** on linear and inverse bars — the newest page comes back. A real
  past time is.
- **REST bars are the archive's bars.** Of 600 rows of the archive's `BTCUSDT` 1 m file for 2020-05,
  all 600 are in REST with the same prices and volume, three hours earlier — the archive stamps
  UTC+3. REST adds turnover.

### What there is

From `instruments-info`, launch to delivery:

| | contracts | instrument-days | by year |
|---|---|---|---|
| linear perpetuals, listed | 859 | 530,522 | 2021: 8k · 2022: 42k · 2023: 57k · 2024: 90k · 2025: 149k · 2026: 180k |
| linear perpetuals, delisted | 327 | 176,354 | 2022: 19k · 2023: 30k · 2024: 53k · 2025: 60k |
| linear dated, delisted | 691 | 28,203 | |
| inverse, listed and delisted | 76 | 36,483 | |
| spot, listed and delisted, by first bar | 1,051 | ≤ 79,064 before 2022-11 | 2021: 9k · 2022: 90k |

Two thirds of the contracts' days are 2025 and 2026. Funding is every 8 hours for 440 perpetuals, every 4 for 417.

| dataset | records | pages | at the limit | at 20/s | stored | raw JSON |
|---|---|---|---|---|---|---|
| funding | 3.0M | 16k | 2 min | 13 min | 0.03 GB | 0.25 GB |
| open interest, 5 min | 158M | 789k | 1.8 h | 11 h | 3.5 GB | 14.8 GB |
| open interest, 1 h | 13M | 66k | 9 min | 55 min | 0.3 GB | 1.2 GB |
| long/short ratio, 5 min | 158M | 316k | 44 min | 4.4 h | 1.9 GB | 14.2 GB |
| mark bars, 1 m | 1,111M | 1,111k | 2.6 h | 15.4 h | 24 GB | 64 GB |
| index bars, 1 m | 1,111M | 1,111k | 2.6 h | 15.4 h | 24 GB | 64 GB |
| premium bars, 1 m | 1,058M | 1,058k | 2.5 h | 14.7 h | 7.4 GB | 58 GB |
| spot bars, 1 m, 2021-07 → 2022-11 | ≤ 114M | ≤ 114k | 16 min | 1.6 h | ≤ 2.2 GB | ≤ 7 GB |

### Documentation

Good: static pages, current, every parameter stated. **Differs from it**: volatility is said to
reach 2 years and answered at 6; the ban after a 403 is said to last ten minutes and did not last
thirty seconds; nothing says a closed contract's open interest is gone.

### Behaviour

2,943 calls, no failure but the one refusal provoked. One connection: 1.7 pages a second, with answers
either near 205 ms or near 800. Four connections 8 a second; eight, 23 a second, p50 204 ms.

---

## OKX

### The API

- **One API**: `/api/v5` on `www.okx.com` — `market/*` for bars and trades, `public/*` for funding,
  instruments and funds, `rubik/stat/*` for statistics.
- **A limit for each endpoint, per 2 seconds, by address**; some by address and instrument
  (`funding-rate-history`, `open-interest`, the contract statistics). 20 per 2 s for bars and mark
  bars, 10 for index bars and funding, 5 for most statistics.
- **No limit header**, except on `public/market-data-history`.
- **Refusal seen, on four endpoints**: HTTP 429, `{"msg":"Too Many Requests","code":"50011"}`, no
  `Retry-After`. One or two seconds later the endpoint answers; nothing longer follows.
- **The stated figures hold to the call** — 20 pass, the 21st does not — and each endpoint's budget
  is its own. A budget "by instrument" is one for each instrument: refused for one swap, funding
  answered for another.
- **Every walk is backward.** `after=<time>` returns what is older, newest first. `before` alone
  returns the newest page, so it cannot walk forward.
- **A delisted instrument does not exist**: bars, mark bars and funding all answer `51001`.
  `public/instruments` lists what is live.
- **Servers**: Cloudflare (edge MAD); `x-routed-to: TKY` on every answer, 270 ms behind the edge.

### Datasets

| dataset | endpoint | page | per 2 s | from | in the archive? | verdict |
|---|---|---|---|---|---|---|
| bars | `market/history-candles` | 300 | 20 | spot 2018-01 (BTC-USDT; most pairs 2020-01), swaps 2020-01 | spot 2019-12, swaps 2021-09, the same numbers | **the 20 months of swaps before the archive** |
| mark bars | `market/history-mark-price-candles` | 300 | 20 | 2020-01 | no | **collect** |
| index bars | `market/history-index-candles` | 300 | 10 | BTC-USD 2018-06, USDT indices 2021-07 | no | **collect** |
| premium | `public/premium-history` | 100 | 20 | 6 months | no | rolling |
| funding | `public/funding-rate-history` | 400 | 10 an instrument | 3 months | since 2021-09 | archive; REST adds `realizedRate` |
| trades | `market/history-trades` | 100 | 20 | 3 months | yes | archive |
| open interest | `rubik/stat/contracts/open-interest-history` | 100 | 10 an instrument | **1,440 points**: 5 m → 5 days, 1 H → 60 days, 1 D → 2024-02-04 | no | rolling |
| long/short ratios | `rubik/stat/contracts/long-short-*` | 100 | 5 an instrument | the same 1,440 points | no | rolling |
| liquidations | `public/liquidation-orders` | 100 | — | under a day | no | rolling, fast |
| insurance fund | `public/insurance-fund` | 100 | 10 | 3 months, a record a minute | no | rolling |
| deliveries, settlements | `public/delivery-exercise-history`, `settlement-history` | 100 | 40 | 3 months | no | rolling |
| open interest, now | `public/open-interest?instType=SWAP` | all 500 swaps in one call | 20 | now | no | cheapest thing to poll |

- **`rubik/stat/taker-volume-contract` pads the past with zeros**: 600 days back it still returns
  100 rows, each `"0","0"`. A zero there is not a measurement.
- **REST bars are the archive's bars**, number for number, for BTC-USDT on 2026-01-01. The archive's
  day runs 16:00 to 16:00 UTC.
- **`public/market-data-history` is the archive's index**: it returns the files' addresses.

### What there is

First month of every listed instrument, from one call each:

| | instruments | instrument-days | before the archive | by year |
|---|---|---|---|---|
| swaps | 500 | 328,401 | 26,567 before 2021-09 | 2022: 30k · 2023: 36k · 2024: 50k · 2025: 73k · 2026: 104k |
| spot | 1,152 | 619,063 | 2,737 before 2019-12 | 2023: 56k · 2024: 89k · 2025: 123k · 2026: 252k |

| dataset | records | pages | at the limit | stored | raw JSON |
|---|---|---|---|---|---|
| mark bars, 1 m | 498M | 1,661k | 46 h | 8.5 GB | 31 GB |
| index bars, 1 m, taking one index a swap | 473M | 1,576k | 88 h as documented, 44 h as observed | 9 GB | 31 GB |
| swap bars, 2020-01 → 2021-09 | 38M | 128k | 3.5 h | 1.3 GB | 4 GB |
| premium, 6 months | 130M | 1,296k | 36 h | 1.8 GB | 10 GB |

**The limit is what binds here, not the link**: 10 pages a second is all `history-candles` allows.

### Documentation

Complete, one page, every endpoint with its limit and its rule. **Differs from it**:

- index bars are documented at 10 per 2 s, and 20 calls passed in 1.5 s before the first refusal —
  the one figure of five tried that did not hold;
- mark bars return 300 where 100 is the stated maximum;
- 1-second bars answered 120 days back where 3 months is stated;
- `public/liquidation-orders` answers over REST and is documented only as a websocket channel;
- open-interest history is described by dates, and is in fact the last 1,440 points of each period.

### Behaviour

2,174 calls, no failure but the refusals provoked. One connection 3.4 pages a second, p50 284 ms,
p90 300: the steadiest of the seven.

---

## Gate

### The API

- **One API**: `https://api.gateio.ws/api/v4`, families by path — `/spot`, `/futures/{settle}`,
  `/delivery/{settle}`, `/options`.
- **200 calls per 10 seconds for each endpoint, by address**, and every answer counts down:
  `x-gate-ratelimit-limit`, `-requests-remain`, `-reset-timestamp`. **Seen**: the 201st call in ten
  seconds is HTTP 429, `TOO_MANY_REQUESTS … (003)`; it answered again seconds later.
- **Errors are HTTP 400** with a label. An over-limit `limit` is refused, not capped.
- **Windows in seconds**, `from` and `to`. Bars and statistics come oldest first, trades and
  liquidations newest first.
- **No edge in front of it**: the host resolves to 27 addresses in AWS `ap-northeast-1`. A new
  connection costs 226 ms to connect and 468 ms more for TLS, before a 231 ms answer.
- **Futures answers are not compressed.** A page of 2,000 statistics is 1.24 MB and took 3.5 to 13
  seconds to arrive.

### Datasets — nearly every one a window

| dataset | endpoint | page | how far back | in the archive? | verdict |
|---|---|---|---|---|---|
| bars | `/spot/candlesticks`, `/futures/{s}/candlesticks` | 1,000 / 2,000 | **the last 10,000 points**: 7 days of 1 m | yes, for years | newest days only |
| mark, index bars | `candlesticks?contract=mark_…`, `index_…` | 2,000 | the last 10,000 points | mark ticks, yes | newest days only |
| premium index | `/futures/{s}/premium_index` | 1,000 | 180 days | no | rolling |
| trades | `/spot/trades`, `/futures/{s}/trades` | 1,000 | 30 days / 180 days | yes | archive |
| funding | `/futures/{s}/funding_rate` | 30 days a call | 180 days | yes, since 2019 | archive |
| **contract statistics** | `/futures/{s}/contract_stats` | 2,000 | 180 days | no | **collect, rolling** |
| **liquidation orders** | `/futures/{s}/liq_orders` | 1,000, a window of an hour | about 11 months (330 d yes, 350 d no) | no | **collect, rolling** |
| insurance | `/futures/{s}/insurance` | 31 daily rows | a month | no | rolling |
| **index bars of the option underlyings** | `/options/underlying/candlesticks` | a window; 2,001 bars came in one | **2022-05** (BTC), no 10,000-point limit | index ticks since 2023-12 | **collect** |
| option settlements | `/options/settlements` | 1,000 | 2022-09 | no | small |
| loan rates, hourly | `/unified/history_loan_rate` | 100, page number | 2024-06 at least | no | small |

- **One statistics record is the whole of what the archive lacks**: open interest in contracts and
  dollars, mark price, long/short ratios by taker, by account and for top traders, and liquidation
  size and value by side — 620 bytes of JSON every five minutes.
- **`liq_orders` takes no contract and returns the venue's**: an hour is one call. A busy hour holds
  more than the 1,000 a call returns, and has to be cut finer.
- **`funding_rate` returns 30 days whatever `limit` says**: 90 records at 8 hours.
- **Nothing lists a delisted contract.** `contracts` holds the 1,027 listed, 100 a page.

### What there is

1,027 USDT perpetuals; within the window, 185,000 instrument-days.

| dataset | records | pages | at the limit | here | size |
|---|---|---|---|---|---|
| contract statistics, 5 min, 180 d | 53M | 26.6k | 22 min | 0.14 pages a second on one connection: 53 h; several times less on several | 33 GB, uncompressed on the wire |
| contract statistics, 1 h, 180 d | 4.4M | 2.2k | 2 min | 4.4 h on one connection | 2.75 GB |
| liquidation orders, 330 d | 2M to 4M | ~8k calls | 7 min | 35 min | 0.3 to 0.5 GB |

### Documentation

The site's page gives the general rules and the changelog; the endpoint reference was taken from
Gate's SDK repository, which marks what needs no signature: 10 endpoints on spot, 14 on futures, 8
on delivery, 12 on options. **Not stated anywhere read**: the 10,000-point limit on bars, the 180-day
limit on funding and statistics, and that futures answers are not compressed.

### Behaviour

717 calls, no failure but the refusals provoked. Small calls on eight connections: 24 a second
until the 200-per-10-seconds wall.

---

## HTX

### The API

- **Two hosts, and a path tree per family.** `api.huobi.pro` for spot. `api.hbdm.com` for
  derivatives: `/linear-swap-api` and `/linear-swap-ex` (USDT-margined), `/swap-api` and `/swap-ex`
  (coin-margined swaps), `/api/v1` and `/market` (coin-margined futures), and
  `/index/market/history/*` for derived bars.
- **Derivatives, as documented**: 240 calls per 3 seconds by address for everything that is not
  market data, 800 a second for market data. The first is reported — `ratelimit-limit: 240`,
  `ratelimit-interval: 3000`, `ratelimit-remaining`; market-data calls carry nothing. Spot states no
  figure for public calls.
- **Refusal, seen**: HTTP 200 with `err_code 1032`, "Maximum number of access attempts exceeded",
  until the 3-second window turns. The coin-margined tree has a budget of its own, of 120.
- **Market data was not refused** at 132 calls a second on derivatives or 126 on spot.
- **Errors are HTTP 200** with `status: error`.
- **Three ways to page, by endpoint**: a window of at most 2,000 bars (`from`/`to`, seconds); a page
  number (`page_index`, with the total stated); or no paging at all, only `size`.
- **Servers**: spot is on CloudFront and this machine was sent to its New York edge (JFK52), 90 to
  145 ms to connect. Derivatives are on Tencent EdgeOne, 13 ms to connect, 243 ms behind it.

### Datasets

| dataset | endpoint | page | how far back | in the archive? | verdict |
|---|---|---|---|---|---|
| bars, spot | `/market/history/kline` | 2,000, `size` only | **the last 2,000 bars**: 33 h of 1 min | yes | nothing |
| trades, spot | `/market/history/trade` | 2,000 | hours | yes | nothing |
| bars, swaps | `/linear-swap-ex/market/history/kline` | 2,000, window | 2020-10, in full | yes | nothing |
| mark, index, premium, estimated rate, basis bars | `/index/market/history/*` | 2,000, `size` only; a window is ignored | the last 2,000 points | mark and index yes; the others no | rolling |
| **funding** | `/linear-swap-api/v1/swap_historical_funding_rate` | 100, page number | **each contract's first day** | only since 2026-02 | **collect** |
| liquidations | `/linear-swap-api/v3/swap_liquidation_orders` | 50, a window of 2 hours, a contract at a time | 90 days | no | rolling, dear |
| open interest | `swap_his_open_interest` | 200, `size` only | 8 days of 1 h; 6 months of 1 d | no | rolling |
| elite ratios | `swap_elite_account_ratio`, `_position_ratio` | 30 points | 2.5 h of 5 min | no | rolling |
| settlements | `swap_settlement_records` | 50, page number | 90 days | no | rolling |

- **Spot has no history over REST at all**: `from` and `to` are ignored, and the last 2,000 bars
  come back.
- **Funding is complete**: 6,538 records for BTC-USDT back to 2020-10-21, 7,168 for coin-margined
  BTC-USD. The archive's funding starts in 2026.
- **A delisted contract does not exist**: `LUNA-USDT` is `invalid symbol`.
- **Two endpoints are switched off**: the v1 liquidation orders ("The interface is offline") and the
  insurance fund ("Function suspended").

### What there is

382 USDT-margined contracts listed, 116,947 instrument-days since 2020-10, two fifths of them in
2026. Five coin-margined swaps, eight futures.

| dataset | records | pages | at the limit | at 4/s | stored |
|---|---|---|---|---|---|
| funding | 0.35M | 3.9k | 1 min | 16 min | 0.01 GB |
| liquidations, 90 d | not known | 413k calls | 86 min | 29 h | not known |

### Documentation

The static pages read are the older site; the current portal is a script and was not read. They
state limits and parameters fully. **Differs from it**: the two endpoints switched off;
`/api/v1/timestamp` reports 100 a second where 240 per 3 is stated.

### Behaviour

4,238 calls, most of them the runs at pace; no failure but the refusals provoked. Bars at 2,000 a page: 1.4 pages a second on one connection, p50 689 ms.

---

## KuCoin

### The API

- **Three surfaces.** Classic spot on `api.kucoin.com`, classic futures on `api-futures.kucoin.com`,
  and the unified one, `/api/ua/v2/market/*`, which repeats bars, trades and funding and adds open
  interest.
- **One pool for every public call: 2,000 weight per 30 seconds, by address**, shared by both hosts.
  Bars cost 3, funding 5, the premium index 3, open interest 10. Every answer reports `gw-ratelimit-limit`, `-remaining`
  and `-reset`.
- **Refusal, seen**: HTTP 429, code `429000`, and it stays refused until the 30-second window ends
  — 20 seconds, when tried — for every weighted call on both hosts.
- **Three ways to page**: a window (`startAt`/`endAt` in seconds on spot, `from`/`to` in
  milliseconds on futures), returning the newest of what fits; an offset; or nothing.
- **Servers**: Cloudflare (edge MAD), 266 ms behind it.

### Datasets

| dataset | endpoint | page | weight | from | in the archive? | verdict |
|---|---|---|---|---|---|---|
| **bars, spot** | `/api/v1/market/candles` | 1,500 | 3 | **2017-10** | since 2022-12 | **collect the five years before** |
| trades | `/api/v1/market/histories`, `/api/v1/trade/history` | 100 | 3 / 5 | now | yes | archive |
| bars, futures | `/api/v1/kline/query` | 200 | 3 | 1 min from 2024-12; 8 h from the first day | since 2023-01 | archive |
| mark, index, premium bars | `/api/ua/v2/market/kline?klineType=` | 200 | 3 | as futures bars: 1 min from 2024-12 | mark and index since 2023-01 | archive |
| **funding** | `/api/v1/contract/funding-rates` | 100 | 5 | 2020-01 at least | since 2023-01 | **collect what is before 2023** |
| premium index, 1 min | `/api/v1/premium/query` | 100 | 3 | 2020-06 at least | no | large, of small worth |
| index, 1 s, with constituents | `/api/v1/index/query` | 100 | 2 | about 100 days | 1 m bars | rolling, very large |
| open interest | `/api/ua/v2/market/open-interest` | 200 | 10 | 5 min: 7 days; 1 d: 70 days | no | rolling |

- **Spot bars exist only for minutes that traded**: 316 bars in the 25 hours of 2018-01-01. And
  their columns run open, close, high, low.
- **The classic spot endpoint counts half the volume.** For the same hour its bar says 58.26 where
  the unified endpoint and the archive's file both say 116.53. To continue the archive's series
  backward, the bars have to come from the unified endpoint, or be doubled.
- **A delisted spot pair does not exist** ("Unsupported trading pair"); a delisted futures contract
  still answers bars and funding.
- **Funding returns the newest 100 of a window**, so it is walked backward by `to`. XBTUSDTM's
  starts four days before its listing date; XBTUSDM, listed 2019-03, has none for its first month
  and has it by 2020-01.

### What there is

| | instruments | instrument-days | before the archive | by year |
|---|---|---|---|---|
| spot, first week of each asked | 969 | 1,093,312 | **245,574 before 2022-12** | 2018: 10k · 2019: 24k · 2020: 35k · 2021: 71k · 2022: 116k |
| futures, from the listing | 692 | 467,751 | 50,645 before 2023-01 | 2023: 49k · 2024: 79k · 2025: 128k · 2026: 161k |

| dataset | records | pages | at the limit | stored | raw JSON |
|---|---|---|---|---|---|
| spot bars before 2022-12 | 354M at most | 236k | 2.9 h | 9 GB at most | 28 GB at most |
| funding before 2023-01 | 0.15M | 2.2k | 3 min | — | 0.01 GB |
| funding, all of it | 1.9M | 19k | 24 min | 0.01 GB | 0.13 GB |
| premium index, 1 min | 674M | 6,736k | 84 h | 5.4 GB | 59 GB |

### Documentation

**The best of the seven for a machine**: an index of every page as markdown, each stating its pool
and its weight. **Differs from it**: futures bars return 200 a page where 500 is stated; 1-minute
futures bars answer from 2024-12-24 where "after 2025-01-01" is stated.

### Behaviour

1,384 calls, no failure but the refusals provoked. Four connections: 12 pages of 1,500 bars a second, p50 305 ms. The pool
allows 22.

---

## Bitget

### The API

- **One host, two generations side by side**: v2 (`/api/v2/spot/market/*`, `/api/v2/mix/market/*`
  with a `productType`) and v3 (`/api/v3/market/*` with a `category`). v3 has no mark or index
  history.
- **A limit for each endpoint, per second, by address**, reported as what is left:
  `x-mbx-used-remain-limit` starts at 19 for most, 9 for spot trade history, **4 for history bars**,
  0 for the four ratio endpoints. **Seen**: the sixth history-bar call in a second is HTTP 429,
  `{"code":"429","msg":"Too Many Requests"}`; at 4 a second, 40 calls passed.
- **Errors are HTTP 400** with a code.
- **Walked backward by `endTime`**; funding by page number.
- **A delisted contract does not exist**: `40309 The symbol has been removed`.
- **Servers**: Cloudflare (edge MAD), 259 ms behind it.

### Datasets

| dataset | endpoint | page | a second | from | in the archive? | verdict |
|---|---|---|---|---|---|---|
| bars | `mix/market/history-candles`, `spot/market/history-candles` | 200 | 5 | futures 2020-06, spot 2018-07 | yes, 1 m | nothing |
| **mark, index bars** | `mix/market/history-mark-candles`, `history-index-candles` | 200 | 20 | 2019-07 | no | **collect** |
| funding | `mix/market/history-fund-rate` | 100 | 20 | **90 days** (270 records) | no | rolling |
| trades | `fills-history` | 1,000 | 20 / 10 | 90 days | yes | archive |
| ratios, taker volume | `long-short`, `account-long-short`, `position-long-short`, `taker-buy-sell` | 30 points | 1 | 2.5 h of 5 min | no | rolling, short |
| liquidations | `/api/v3/market/liquidations` | 100 | 5 | 3 days | no | rolling, short |
| recent bars, with mark and index | `mix/market/candles?kLineType=` | 1,000 | 20 | a month at 1 m | — | the tail |
| open interest | `open-interest` | — | 20 | now | no | polled or not had |
| risk reserve | `/api/v3/market/risk-reserve`, `-hour` | 30 | 20 | 30 days / 30 hours | no | rolling |

### What there is

820 USDT futures listed, with no launch date in the listing. First month of each, asked: 811 with
history, the earliest 2019-07; 441,518 instrument-days — 2023: 41k · 2024: 68k · 2025: 128k ·
2026: 172k.

| dataset | records | pages | at the limit | stored | raw JSON |
|---|---|---|---|---|---|
| mark bars, 1 m | 636M | 3,179k | 44 h | 12 GB | 45 GB |
| index bars, 1 m | 636M | 3,179k | 44 h | 9.5 GB | 45 GB |
| funding, 90 d | 0.2M | 3k | 3 min | — | 0.02 GB |

### Documentation

**Readable only by taking the site apart.** It is a script that returns one page for every address;
its content is an OpenAPI document for each group of endpoints, bundled into the site's scripts,
and those were fetched and read. They state a limit for every endpoint and little about depth.
**Differs from it**: `history-candles` is stated at 20 calls a second and takes 5.

### Behaviour

979 calls, no failure but the refusals provoked. 3.5 pages a second on one connection, p50 275 ms.

---

## Across the venues

### Where the servers are, and how they hold

| venue | in front | behind it | fresh connection | answer, small call | failures |
|---|---|---|---|---|---|
| binance | CloudFront, Barcelona; `dapi` none | Tokyo for `dapi`; not said for the rest | 180 ms; `dapi` 480 | 240 ms | 0 of 2,629 |
| bybit | CloudFront, Barcelona | not said | 130 ms | 187 ms | 0 of 2,943 |
| okx | Cloudflare, Madrid | Tokyo, by its header | 140 ms | 270 ms | 0 of 2,174 |
| gate | none | AWS Tokyo | **690 ms** | 231 ms | 0 of 717 |
| htx | CloudFront, New York (spot); EdgeOne (derivatives) | not said | 130 to 300 ms | 243 ms | 0 of 4,238 |
| kucoin | Cloudflare, Madrid | not said | 150 ms | 266 ms | 0 of 1,384 |
| bitget | Cloudflare, Madrid | not said | 130 ms | 259 ms | 0 of 979 |

**Nothing failed.** No timeout, no 5xx, no dropped body in some 15,000 calls, at up to 290 a
second; every refusal was one asked for. **Nothing is fast either**: an answer is a quarter of a
second at best. So a connection is worth 4 pages a second, and throughput is the number of
connections kept open, up to the venue's limit or the link's. Gate alone makes a new connection
dear.

### Pagination: five schemes

| scheme | where | what the collector must know |
|---|---|---|
| **forward by time** — "from here, the next N" | binance; bybit bars; htx swap bars; gate; kucoin futures bars | the start; the last time seen |
| **backward by time** — "the N before here" | okx (all of it); bitget; bybit funding; kucoin spot bars and funding; binance `/futures/data` | the end; the oldest time seen; when to stop |
| **by id** | binance spot trades | the last id |
| **by page number**, total stated | htx funding and settlements; bitget funding | the page; that new records shift the pages |
| **by cursor** | bybit open interest, ratios, instruments | the cursor |

And two things that are not paging: **the fixed window** — the last N points, no way to move it
(htx spot, htx derived bars and ratios, bitget ratios, okx's 1,440 points) — and **the snapshot**.

**Direction is not a detail.** A backward walk has no natural resume point: what is new arrives at
the end it started from. A history walked backward is done once to its floor, and then followed
forward from its newest record — two walks of one dataset.

**Order inside a page is separate from direction**: bybit walks bars forward and returns each page
newest first.

### Rate limits: four kinds, all seen at work

| venue | the budget | keyed by | reported | when it is spent | back after |
|---|---|---|---|---|---|
| binance | weight a minute for each service: 6,000 spot, 2,400 both futures together, 400 options | address | used so far: `x-mbx-used-weight-1m` | 429, `-1003`, `Retry-After` | the minute's turn |
| bybit | 600 calls per 5 s for the host | address | nothing | 403, plain text | under 30 s |
| okx | each endpoint its own, per 2 s: 20 bars, 20 mark bars, 10 funding, 10 open interest | address; some by address and instrument | nothing | 429, `50011` | 1 to 2 s |
| gate | 200 calls per 10 s for each endpoint | address | limit, remaining, reset | 429, `TOO_MANY_REQUESTS` | 2 s |
| htx | 240 calls per 3 s for reference data (120 on the coin-margined tree); market data not refused at 130 a second | address | limit, remaining, reset — on reference data only | **HTTP 200**, `err_code 1032` | the 3 s window's turn |
| kucoin | 2,000 weight per 30 s for every public call on both hosts | address | limit, remaining, ms to reset | 429, `429000` | the 30 s window's turn |
| bitget | each endpoint its own, per second: 20 for most, 5 for trade bars, 1 for ratios | address | remaining this second | 429, `"code":"429"` | the next second |

- **Every refusal was harmless**: the longest wait was a minute, at binance, and none grew into a
  ban. Binance alone documents one, for going on after a 429.
- **Three report nothing on the calls that matter** (bybit, okx, htx market data): there the pace
  has to be kept by counting, not by reading.
- **Four report the budget on every answer** (binance, gate, kucoin, bitget), and a collector can
  pace itself against that, as scribe did against BitMEX's.
- **A budget keyed by address and instrument multiplies** (okx funding, open interest, statistics):
  a sweep of the venue is limited by how many instruments it asks about at once, not by the stated
  figure.
- **Budgets that look separate may be one** (binance's two futures hosts; kucoin's two hosts), and
  ones that look shared may be separate (okx and bitget, endpoint by endpoint).
- **A refusal is not always a status**: htx says it in the body of a 200.
- **Scribe's several identities do not carry over.** These are public calls limited by address,
  and an account adds nothing. Addresses would.

### What a dataset's description has to say

Beyond what scribe (`services/.deprecated/scribe`) needed for BitMEX — a path, a page size, static parameters, a symbol
resolver, a floor, the clock it is ordered by:

- **its scheme**, of the five, and the names and units of its bounds — seconds at gate, htx and
  kucoin spot; milliseconds elsewhere;
- **which way it walks, and which way a page is ordered**;
- **its depth**: unbounded, a date, a number of days, a number of points — and so whether it is a
  backfill, a window to be read every so often, or a snapshot;
- **what it is asked by**: a symbol, a pair and contract type, an index name, a family, or nothing
  — binance funding and gate liquidations return the whole venue;
- **where the records are** in the answer, and whether a record is an object or a row;
- **what ok looks like**: four venues answer errors with HTTP 200;
- **which budget it draws on, and its cost**;
- **whether a delisted instrument still answers**, which decides if its history can wait.

And what stays a hook, because it was met once:

- records sharing one instant across a page boundary (binance funding, all symbols);
- a window that silently returns less than it holds (gate liquidations, capped at 1,000 an hour);
- zeros that are padding (okx taker volume);
- bars only where there were trades (kucoin spot);
- a column order of its own (kucoin: open, close, high, low);
- a floor that is a date nobody states (binance spot trades).

## What was not established

- **HTX's current documentation portal**, a script; the older static pages were read.
- **The number of OKX indices**: index bars are sized at one index a swap.
- **What limits binance's `/futures/data` and `fundingRate`**, and bybit's, htx's and kucoin's market
  data above what this link could send: none refused.
- **Where bybit, htx, kucoin and bitget keep their servers**: only the delay behind the edge.
- **Dated futures and options** beyond a look: bars and settlements exist for them at bybit, okx
  and gate; none was sized. Options' bars and trades at gate answered empty for the contract tried.
- **Whether kucoin's premium index survives delisting**, and the floor of its funding between
  2019-04 and 2020-01.
- **Binance Alpha's limits.**
