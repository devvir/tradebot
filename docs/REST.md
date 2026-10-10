# REST: the endpoints worth knowing

What the seven venues' public APIs serve of the past, at a glance: the endpoints that hold real
history, with what each gives, how it is asked and how far back it goes.

**Everything here needs no key and costs nothing.** Each venue's full account — every endpoint, its
record, its errors, and which statements were seen and which only documented — is under `REST` in
`docs/venues/<VENUE>.md`.

**Two words carry most of it.** *Deep* is history from the instrument's first day, or years of it.
A *window* is the last so many days or points and nothing older; windows are listed in a line at
the end of each venue, since they are not history.

---

## The whole of it in one table

Deep history that the venue's archive does not have.

| venue | funding | open interest | mark and index bars | trade bars before the archive | other |
|---|---|---|---|---|---|
| binance | in the archive | in the archive | in the archive | — | — |
| bybit | **deep** | **deep, 5 min, from 2020-08** | **deep** | spot, 2021-07 → 2022-11 | long/short ratio, volatility |
| okx | 3 months | 1,440 points | **deep, from 2020 / 2018** | swaps, 2020-01 → 2021-09 | — |
| gate | 180 days | 180 days | index of 12 option underlyings, from 2022 | — | option settlements |
| htx | **deep** | 200 points | 2,000 points | — | — |
| kucoin | **deep, from 2020** | 7 days | from 2024-12 | **spot, 2017-10 → 2022-12** | premium index, from 2020 |
| bitget | 90 days | now only | **deep** | — | — |

**Trades are not history over REST**: a window of 2 days to 6 months by venue, or only the newest
few hundred. Binance spot's go back to 2022-09-02, and its archive further. **A delisted instrument
answers nothing** at okx, htx, bitget and kucoin's spot; at bybit it keeps bars and funding and
loses open interest and ratios.

---

## Binance

`api.binance.com/api/v3` (spot), `fapi.binance.com/fapi/v1` (USDⓈ futures), `dapi.binance.com/dapi/v1`
(coin futures), `eapi.binance.com/eapi/v1` (options). Paged forward by `startTime`; rows are bare
arrays.

**Its archive already has everything below**; the API is for the newest day.

| endpoint | gives | page | reaches |
|---|---|---|---|
| `/api/v3/klines` | spot bars, down to `1s` | 1,000 | the pair's first trade |
| `/fapi/v1/klines`, `/dapi/v1/klines` | futures bars | 1,500 | the contract's first trade |
| `/fapi/v1/markPriceKlines`, `indexPriceKlines`, `premiumIndexKlines` | derived bars | 1,500 | 2019-12 |
| `/fapi/v1/fundingRate` | funding; **without `symbol`, every symbol at once** | 1,000 | 2019-09 |
| `/api/v3/aggTrades`, `historicalTrades` | spot trades | 1,000, by id | **2022-09-02 only** |
| `/futures/data/delivery-price` | delivery prices of a pair | all | 2022-12 |

- **Windows**: `/futures/data/*` (open interest, ratios, taker volume, basis) 30 days; futures
  `aggTrades` 2 days; option exercises 6 to 9 months.
- **Gone**: liquidations (`allForceOrders` is 404).
- **Limit**: weight a minute by address — 6,000 spot, 2,400 for both futures hosts together, 400
  options — reported in `x-mbx-used-weight-1m`. A page of 1,500 futures bars costs 10. Spent: 429
  with `Retry-After`, back when the minute turns.

## Bybit

`api.bybit.com/v5/market/*`, with a `category`: `spot`, `linear`, `inverse`, `option`. Lists come
newest first. **The one API that is a second archive.**

| endpoint | gives | page | walked | reaches |
|---|---|---|---|---|
| `funding/history` | funding | 200 | backward by `endTime`; a symbol at a time | first funding, 2018-11 |
| `open-interest` | open interest, 5 min to 1 d | 200 | cursor | **2020-08-05** |
| `account-ratio` | long/short account ratio | 500 | cursor | 2020-08-05 |
| `mark-price-kline`, `index-price-kline`, `premium-index-price-kline` | derived bars | 1,000 | forward by `start` | the contract's first day |
| `kline` | trade bars: spot, linear, inverse | 1,000 | forward by `start` | first trade; spot 2021-07 |
| `historical-volatility` | hourly volatility of a base coin | a 30-day window | by window | 2020-10 at least |
| `instruments-info?status=Closed` | delisted contracts, with launch and delivery times | 1,000 | cursor | — |

- **Open interest and the ratio are lost when a contract delists**: its list comes back empty. Bars
  and funding stay, for contracts and spot pairs alike.
- **`funding/history` refuses `startTime` alone**; `start=1` is ignored on bars, a real past time is
  not.
- **Windows**: option delivery prices, the last 50. **None**: liquidations, trades.
- **Limit**: 600 calls per 5 seconds for the host, reported nowhere. Spent: 403 "Access too
  frequent", gone within 30 seconds.

## OKX

`www.okx.com/api/v5`: `market/*`, `public/*`, `rubik/stat/*`. **Everything is walked backward** with
`after=<time>`; a `limit` over the maximum is silently capped.

| endpoint | gives | page | per 2 s | reaches |
|---|---|---|---|---|
| `market/history-mark-price-candles` | mark bars | 300 | 20 | 2020-01 |
| `market/history-index-candles` | index bars | 300 | 10 stated, 20 seen | 2018-06 (BTC-USD), 2021-07 (USDT indices) |
| `market/history-candles` | trade bars | 300 | 20 | 2020-01; four pairs from 2018 |

- **Listed instruments only**: a delisted one is `51001`, for every endpoint.
- **Its bars are the archive's**, so only the swaps' 20 months before the archive (2020-01 →
  2021-09) are new.
- **Windows**: funding, trades, insurance fund, settlements 3 months; premium 6 months; open
  interest and ratios 1,440 points of whatever period (5 days at 5 min; daily since 2024-02);
  liquidations under a day.
- **`public/open-interest?instType=SWAP`** gives every swap's open interest now in one answer.
- **Limit**: each endpoint its own, per 2 seconds, by address — funding and statistics by address
  and instrument. Reported nowhere. Spent: 429 `50011`, back in a second or two.

## Gate

`api.gateio.ws/api/v4`: `/spot`, `/futures/{settle}`, `/delivery/{settle}`, `/options`. Windows in
seconds, `from` and `to`. **Nearly everything is a window.**

| endpoint | gives | page | reaches |
|---|---|---|---|
| `/options/underlying/candlesticks` | index bars of an option underlying, 1 m | a window; 2,001 came in one | **2022-05** (BTC); 12 underlyings |
| `/options/settlements` | option settlements | 1,000 | 2022-09 |
| `/unified/history_loan_rate` | hourly loan rate of a currency | 100, by page | 2024-06 at least |

- **Windows**: bars of every kind 10,000 points (a week at 1 m); funding, futures trades, premium
  index and `contract_stats` 180 days; `liq_orders` about 11 months; spot trades 30 days.
- **`/futures/{settle}/contract_stats`** is the richest record of the seven — open interest, mark
  price, long/short ratios, liquidation totals, every 5 minutes — but 180 days of it.
- **`/futures/{settle}/liq_orders`** without a contract returns the whole venue's liquidations, an
  hour a call.
- **No edge in front of it** (AWS Tokyo): a new connection costs 0.7 seconds. Futures answers are
  not compressed.
- **Limit**: 200 calls per 10 seconds for each endpoint, by address, counted down in
  `x-gate-ratelimit-requests-remain`. Spent: 429, back in 2 seconds. A `limit` over the maximum is
  refused, not capped.

## HTX

`api.huobi.pro` (spot), `api.hbdm.com` (derivatives: `/linear-swap-api` and `/linear-swap-ex` for
USDT-margined, `/swap-api` and `/swap-ex` for coin-margined). **Every answer is HTTP 200**; the
error is in the body.

| endpoint | gives | page | reaches |
|---|---|---|---|
| `/linear-swap-api/v1/swap_historical_funding_rate`, `/swap-api/v1/…` | funding | 100, by page number, newest first | **first funding**, 2020-03 |
| `/linear-swap-ex/market/history/kline`, `/swap-ex/…` | swap bars | a window of 2,000 | first trade — in the archive too |

- **Its archive's funding starts in 2026**; the API's is complete, for listed contracts.
- **Spot has no history over REST**: the last 2,000 bars, `from` and `to` ignored. The same for
  mark, index, premium, estimated-rate and basis bars.
- **Windows**: liquidation orders (v3, 2 hours a call) and settlements 90 days; open interest 200
  points; elite ratios 30.
- **Limit**: 240 calls per 3 seconds for reference data (funding is that), 120 on the coin-margined
  tree, reported in `ratelimit-remaining`; market data unreported and not refused at 130 a second.
  Spent: HTTP 200 with `err_code 1032`, until the window turns.

## KuCoin

`api.kucoin.com` (spot, and the unified `/api/ua/v2/market/*`), `api-futures.kucoin.com` (futures).

| endpoint | gives | page | walked | reaches |
|---|---|---|---|---|
| `/api/ua/v2/market/kline?tradeType=SPOT` | spot bars | 1,500 | backward by `endAt`, seconds | **2017-10** |
| `/api/v1/market/candles` | spot bars, classic | 1,500 | backward | 2017-10 |
| `api-futures…/api/v1/contract/funding-rates` | funding | 100 | backward by `to`, ms | 2020-01 at least |
| `api-futures…/api/v1/premium/query` | premium index, 1 min | 100 | by window | 2020-06 at least |

- **The archive starts in 2022-12**; spot bars for the five years before are only here, for pairs
  still listed.
- **The classic spot endpoint counts half the volume**, and orders its columns open, close, high,
  low. The unified one agrees with the archive on volume and runs open, high, low, close. Use the
  unified one.
- **A spot bar exists only for a minute that traded.**
- **Windows**: futures bars below 8 hours — trade, mark, index, premium — since 2024-12; the
  1-second index about 100 days; open interest 7 days.
- **Limit**: 2,000 weight per 30 seconds for every public call on both hosts; bars cost 3, funding
  5. Reported in `gw-ratelimit-remaining`. Spent: 429 `429000` until the window ends.

## Bitget

`api.bitget.com`: v2 at `/api/v2/mix/market/*` and `/api/v2/spot/market/*`, v3 at
`/api/v3/market/*`. **Walked backward by `endTime`.**

| endpoint | gives | page | a second | reaches |
|---|---|---|---|---|
| `/api/v2/mix/market/history-mark-candles` | mark bars | 200 | 20 | the contract's first month (2019-07) |
| `/api/v2/mix/market/history-index-candles` | index bars | 200 | 20 | the contract's first month |
| `/api/v2/mix/market/history-candles`, `/api/v2/spot/market/history-candles` | trade bars | 200 | **5** | first trade — in the archive too |

- **Listed contracts only**: a delisted one is `40309`.
- **Small pages make it slow**: 200 bars a call, so a day of one contract is 8 calls.
- **Windows**: funding and trades 90 days; `candles` (with `kLineType=mark|index`) a month;
  liquidations 3 days; ratios 30 points. **Open interest is the value now and nothing else.**
- **Limit**: each endpoint its own, per second, by address, reported in `x-mbx-used-remain-limit`.
  Spent: 429, back the next second. The documentation says 20 for trade bars; it is 5.

---

## The limits, side by side

| venue | budget | reported | spent | back after |
|---|---|---|---|---|
| binance | weight a minute for each service | used so far | 429 + `Retry-After` | the minute's turn |
| bybit | 600 calls / 5 s, whole host | nothing | 403 | under 30 s |
| okx | each endpoint, per 2 s | nothing | 429 | 1 to 2 s |
| gate | 200 calls / 10 s, each endpoint | remaining | 429 | 2 s |
| htx | 240 calls / 3 s on reference data | remaining | HTTP 200, error in the body | 3 s |
| kucoin | 2,000 weight / 30 s, everything | remaining | 429 | up to 30 s |
| bitget | each endpoint, per second | remaining | 429 | 1 s |

**All by address; none bans for one overrun.** An answer takes a quarter of a second from any of
them, so a connection is worth about four pages a second and the rest is how many are kept open.
