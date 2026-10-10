# KuCoin

KuCoin as a source of market data: what it publishes, where, and how it behaves when asked.

## Archives

What kucoin's published archive holds, measured against the bucket.

### One bucket, listed where it is served

`historical-data.kucoin.com` answers the standard S3 listing API on the same host that serves the
files, with a size, a last-modified and an md5 ETag for every key. Everything sits under `data/`,
and every file is a day: there is no monthly tree. A `.CHECKSUM` sits beside every archive.

**No limit found.** Measured 2026-09-29 and 30 with `HEAD` requests: 3,951 a second from one machine
and 3,602 from a remote one, without a single throttling answer, on keys the edge had cached. A
missing key goes to the origin and takes 270–700 ms.

### The tree

```
data/<market>/daily/[depth/]<dataset>/<SYMBOL>/[<interval>/]<file>-<yyyy-mm-dd>.zip
```

| market | datasets |
|---|---|
| `spot` | `klines`, `trades`, `depth/orderbooklv50` |
| `futures` | `klines`, `index`, `mark`, `trades`, `fundingRates`, `depth/orderbooklv50` |

`klines`, `index` and `mark` have a directory for each interval.

**`futures` is kucoin's perpetuals** — `XBTUSDTM` and the rest, with the `M` suffix it gives them —
and a handful of quarterly contracts in the same tree, named by a month code and a two-digit year
(`XBTMU26`). Nothing in a path separates the two.

**The books are whole books**, one a row: fifty levels a side, and no deltas. The depth is in the
dataset's name, and `depth/` is the only place this tree is three deep before the instrument.

### Futures klines at `1d` are published broken

Every file under `futures/daily/klines/<SYMBOL>/1d/` declares `time,open,high,low,close,volume` and
then writes five fields a row: the volume is not empty, it is absent. A file fetched fresh is
byte-identical to an earlier copy and matches the MD5 kucoin publishes beside it, so it is the
archive that is wrong.

It is the interval and not the venue. Futures klines at every other interval carry six fields and
six values, spot klines seven and seven, and `index` and `mark` five and five at every interval —
correctly, since a mark-price bar has no volume. Checked across forty symbols: `1d` is six and five
everywhere. The `1m` series is published whole over the same range.

### A name in the API is not always the name in a path

| | the API | the archive |
|---|---|---|
| spot, `klines` and `trades` | `0G-USDT` | `0GUSDT` — no dash |
| spot, books | `0G-USDT` | `0G-USDT` |
| bitcoin perpetuals | `XBTUSDTM`, `XBTUSDM`, `XBTUSDCM` | `BTCUSDTM`, `BTCUSDM`, `BTCUSDCM`, in every tree |
| dated bitcoin contracts | `XBTMU26` | `XBTMU26`, and `BTCMU26` under books |

No contract the API lists begins with `BTC`. The spellings above are as the bucket lists them on
2026-10-08.

**The dash goes back in from the quote currency.** All 1,775 dashed names in the archive, and all
1,007 the API lists, are rebuilt exactly from their dashless form by splitting off the longest quote
that fits: `USDT`, `USDC`, `USD1`, `USDG`, `TUSD`, `DOGE`, `BTC`, `ETH`, `KCS`, `EUR`, `TRX`, `BRL`,
`DAI`, `GBP`, `THB`, `TRY`. The last four are retired — no listed pair uses them — and the archive
still does. 23 of the archive's 2,419 dashless spot names end in a quote kucoin no longer lists at
all, and cannot be split.

## REST

**How to read this section.** A statement with no mark is what the API answered when it was asked,
in October 2026. *(documented)* marks what kucoin's documentation states and was not tried.
*(not known)* marks what neither settled. Nothing here is inferred from another venue.

### The API

**Three surfaces on two hosts**, all behind Cloudflare:

| surface | host and base | serves |
|---|---|---|
| classic spot | `https://api.kucoin.com/api/v1` (listing at `/api/v2`) | spot bars, trades, listing |
| classic futures | `https://api-futures.kucoin.com/api/v1` | futures bars, trades, funding, index, premium, listing |
| unified ("UTA") | `https://api.kucoin.com/api/ua/v2/market` | bars, trades and funding for both, and open interest |

- **Names**: `BTC-USDT` on spot; `XBTUSDTM` a USDT-margined perpetual, `XBTUSDM` a coin-margined
  one; an index is `.KXBTUSDT`, a premium index `.XBTUSDTMPI`.
- **Times differ by surface**: seconds on classic spot bars (`startAt`, `endAt`, and the bar's own
  time); milliseconds on classic futures; nanoseconds on a spot trade's `time`. The unified bars
  want seconds.
- **Every answer is `{code, data}`**; `"200000"` is success. Errors seen: `400100` "Unsupported
  trading pair" with HTTP 200, `148025` "Parameter 'startAt' is invalid. Must be seconds." with
  HTTP 400. An empty history is `data: null` on funding.
- **The documentation is indexed for machines**: `https://www.kucoin.com/docs-new/llms.txt` lists
  every page as markdown, and each page states its limit pool and weight.

### Its limits

- **One pool for every public call: 2,000 weight per 30 seconds, by address** *(documented)*. The
  account's level changes the private pools only.
- **Every answer reports it**: `gw-ratelimit-limit: 2000`, `gw-ratelimit-remaining`,
  `gw-ratelimit-reset` — milliseconds left in the window.
- **Both hosts draw on the same pool**: the remaining figure ran on from 1982 on `api` to 1979 on
  `api-futures`.
- **Weights** *(documented; seen for bars, 30 calls taking 90, and for open interest, 200 calls
  taking 2,000)*: spot bars 3, spot trades 3, futures bars 3, futures trades 5, funding 5, premium
  index 3, index 2, interest index 5, unified bars 3, open interest 10, announcements 20.
- **Beyond it**: HTTP 429, `{"code":"429000","msg":"Too many requests. User-level rate limit
  exceeded."}`, with `gw-ratelimit-remaining: 0`. **It stays refused until the window ends** —
  `gw-ratelimit-reset` says how long — and every other weighted call on both hosts is refused with
  it. `/api/v1/timestamp` still answers.

### How it is paged

- **Spot bars**: `startAt` and `endAt`. A window holding more than a page returns its **newest**
  1,500, newest first; so the walk is backward, the next `endAt` being the oldest time received.
- **Futures bars**: `from` and `to`. A window returns its **oldest** 200, oldest first; so the walk
  is forward.
- **Funding**: `from` and `to`. A window returns its newest 100, newest first; backward.
- **Index and premium**: `startAt`, `endAt`, `maxCount` ≤ 100, with `offset`, `forward` and
  `reverse` *(documented)*; the answer carries `hasMore`.

### Endpoints that serve the past

**Spot bars — `GET api.kucoin.com/api/v1/market/candles`**
- **Ask**: `symbol`, `type` (`1min 3min 5min 15min 30min 1hour 2hour 4hour 6hour 8hour 12hour 1day
  1week 1month`), `startAt`, `endAt`.
- **Answer**: rows of strings `[time, open, close, high, low, volume, turnover]` — close comes
  before high.
- **Page**: 1,500; without a window, the newest 100.
- **A bar exists only for a minute that traded**: 316 bars in the 25 hours from 2018-01-01.
- **Volume and turnover count one side of each trade**: half of what the archive and the unified
  endpoint say for the same bar.
- **Reaches the pair's first trade**: BTC-USDT's first week is 2017-10-19, and its `1min` bars of
  2018 and 2020 answer. The earliest first week of any listed pair is 2017-10-05.
- **A delisted pair does not exist**: `400100`.

**Futures funding — `GET api-futures.kucoin.com/api/v1/contract/funding-rates`**
- **Ask**: `symbol`, `from`, `to`.
- **Answer**: `{symbol, fundingRate, timepoint}`; 100 at most.
- **Reaches**: XBTUSDTM 2020-03-26, four days before its listing date; XBTUSDM, listed 2019-03-15,
  has none for its first month and has it by 2020-01.
- **A delisted contract still answers.**

**Futures bars — `GET api-futures.kucoin.com/api/v1/kline/query`**
- **Ask**: `symbol`, `granularity` in minutes (`1 5 15 30 60 120 240 480 720 1440 10080`), `from`,
  `to`.
- **Answer**: rows of numbers `[time, open, high, low, close, volume, turnover]`.
- **Page**: 200 came back; 500 is what is stated.
- **Reaches less for short bars**: `1` answers on 2024-12-24 and not on 2024-11-08; `60` answers in
  2024-11 and not in 2024-04; `480` answers in 2021-01; weekly from 2020-03-30.
- **A delisted contract still answers.**

**Bars of any kind, unified — `GET api.kucoin.com/api/ua/v2/market/kline`**
- **Ask**: `tradeType` (`SPOT`, `FUTURES`), `symbol`, `interval` (`1min` … `8hour` … `1week`),
  `klineType` (`TRADE`; on futures also `MARK_PRICE`, `INDEX_PRICE`, `PREMIUM_INDEX`), `startAt`,
  `endAt` in **seconds**.
- **Answer**: `data.list[]` of rows `[time, open, high, low, close, volume, turnover]` as strings,
  newest first — high before close, unlike the classic spot rows. 200 a page on futures, 1,500 on
  spot. A window holding more than a page returns its newest page.
- **Mark, index and premium bars reach as far as futures bars do**: `MARK_PRICE` at `1min` answers
  660 days back (2024-12-19) and not 700; at `8hour` it answers in 2021. "For intervals shorter than
  8 hours, only data after 2025-01-01" is what is stated.
- **Spot through it is the classic spot's history**: the same 316 bars for 2018-01-01, and a
  delisted pair is `138004 Unsupported trading pair`.
- **But its volume is twice the classic endpoint's.** For the same hour of BTC-USDT the unified row
  says volume 116.52778808 and turnover 9,733,398.87, the classic row 58.26389404 and 4,866,699.44:
  the classic endpoint counts one side of each trade *(documented: "Only one-sided trading volume
  is counted")*.
- **The archive's bars carry the unified figure** — 116.52778808 for that hour — in the classic
  column order: `time, open, close, high, low, volume, turnover`.

**Premium index — `GET api-futures.kucoin.com/api/v1/premium/query`**
- **Ask**: `symbol` (`.XBTUSDTMPI`), `startAt`, `endAt`, `maxCount` ≤ 100.
- **Answer**: `data.dataList[]` of `{symbol, granularity: 60000, timePoint, value}` — one a minute.
- **Reaches**: 2,300 days back at least (2020-06).

### Endpoints that hold only the newest

- **Index — `GET api-futures.kucoin.com/api/v1/index/query`**: `symbol` (`.KXBTUSDT`), as premium;
  `{symbol, granularity: 1000, timePoint, value, decomposionList: [{exchange, price, weight}]}` —
  one a second. 100 days back answers, 120 does not; 3 months is what is stated.
- **Open interest — `GET api.kucoin.com/api/ua/v2/market/open-interest`**: `symbol`, `interval`
  (`5min 15min 30min 1hour 4hour 1day`), `pageSize` ≤ 200, `startAt`, `endAt`;
  `{openInterest, ts}`. At `5min`, 6 days back answers and 8 does not; at `1day`, 69 rows.
- **Trades — `/api/v1/market/histories`, `/api/v1/trade/history`**: the newest 100.
  Spot's is `{sequence, tradeId, price, size, side, time}`.
- **`/api/v1/interest/query`**, the interest rate index a minute *(documented)*; not tried.
- **`/api/v1/mark-price/{symbol}/current`**: of now *(documented)*.
- **Unified funding — `GET api.kucoin.com/api/ua/v2/market/funding-rate-history`**: `symbol`,
  `startAt`, `endAt` in milliseconds; `data.list[]` of `{fundingRate, ts}`; the same history as the
  classic endpoint.
- **Announcements — `GET api.kucoin.com/api/ua/v2/market/announcement`**: `annType`
  (`delistings`, `new-listings`, …), `lang`, `pageSize` ≤ 50; `{id, title, type, description,
  releaseTime, url}`.

### What the listings carry

- `GET api.kucoin.com/api/v2/symbols`: listed pairs, with no listing date.
- `GET api-futures.kucoin.com/api/v1/contracts/active`: `{symbol, type, firstOpenDate, expireDate,
  status, fundingRateGranularity, …}`; listed contracts only.

### The listings

Spot is `api.kucoin.com/api/v2/symbols` and futures `api-futures.kucoin.com/api/v1/contracts/active`.

**Neither states an ending.** Spot's `enableTrading` is a halt rather than a delisting — one symbol
of a thousand — and the futures endpoint returns only what is active. A symbol leaving the list is
the only ending either of them states.
