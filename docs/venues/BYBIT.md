# Bybit

Bybit as a source of market data: what it publishes, where, and how it behaves when asked.

## Archives

What bybit's published archive contains, established by asking the archive itself.

**Bybit is two servers, not one.** Everything below except the order books comes from
`public.bybit.com` and the bucket behind it; the order books live on `quote-saver.bycsi.com`, a
separate server with a different tree, a different format and limits of its own — see
[A second host: the order books](#a-second-host-the-order-books).

### Publication

From the files' own `Last-Modified`, measured on 2026-09-25 over the 16,571 files dated 2026-09-15
to 21, a day's file appears this many hours after the start of the day it is dated:

| p50 | p99 |
|---|---|
| 25.2 h | 26.0 h |

The trees publish at different hours. Read on 2026-11-25, over the days 2026-11-10 to 19: `BTCUSDT`'s
`trading/` file for day D appeared between 01:09 and 01:15 UTC on D+1, its `spot/` daily file at
about 02:00, and `BTC`'s option trades within seconds of midnight.

### The CDN answers no listing API; the bucket does

`public.bybit.com` is CloudFront, and **every query parameter is ignored**: `?prefix=`,
`?list-type=2`, `?marker=` all return the same thing as `/` — the browsable HTML index a plain file
server renders. It names files and says nothing about them.

The bucket behind it is **publicly listable**, and answers the ordinary S3 listing API with `prefix`,
`delimiter`, `max-keys` and `marker` all honoured:

```
https://s3.ap-southeast-1.amazonaws.com/public.bybit.com/?prefix=trading/&delimiter=/&max-keys=1000
```

Its listings carry a size, a last-modified and an ETag with every key, and the ETag is the file's
MD5. The bucket serves the files too.

**Path-style only.** `public.bybit.com.s3-ap-southeast-1.amazonaws.com` puts the bucket's own dots
into the hostname, where the wildcard certificate does not reach and TLS fails outright. Addressed
as a path, `s3.ap-southeast-1.amazonaws.com/public.bybit.com/`, the hostname is clean.

### What is in the bucket but is not archive

- `backup/` is a copy: one symbol's (`ZKUSDT`) `trading/` files, served under `trading/` as well.
- **The bucket root holds one key of its own, `index.html`**, the page of the browsing UI; every
  other key sits below a directory. An `index.html` also sits *inside* directories —
  `kline_for_metatrader4/BTCUSDT/2020/index.html`, `trading/BTCUSDU21/index.html` — one per
  instrument per dataset.
- `backup/` is also a zero-byte key of its own, beside the keys beneath it.

No tree carries checksum files.

### Four shapes, and none of them is the obvious one

Every tree names its instrument and its date differently:

| tree | shape |
|---|---|
| `trading/`, `premium_index/`, `spot_index/` | the instrument runs **straight into** the date — `BTCUSD2019-10-01_premium_index.csv.gz` |
| `spot/` | monthly and daily files in one directory, told apart by the separator — `-2026-08` monthly, `_2026-08-03` daily |
| `trade/option/`, `mark_kline/option/` | dated **first**, keyed by the underlying coin — `2026-08-03_BTC_USDT.trades.csv.zip` |
| `kline_for_metatrader4/` | a whole month named by **both its ends** — `ADAUSDT_15_2021-01-01_2021-01-31.csv.gz` |

**An instrument's name is letters, digits, dashes and underscores** — match-outcome markets are
listed as `WC_ARG_ALG_USDT-17JUN26` — so its own punctuation says nothing about where it ends. The
date does.

**The metatrader tree is monthly, not a range.** All 5,731 of its files (2026-11-25) cover exactly
one whole calendar month, from 2020-04 to 2025-11, at five intervals, with no exceptions: the second
date is always the month's last day.

**The metatrader klines are the USDT perpetuals, stamped in UTC+3.** The files are headerless:
`datetime, open, high, low, close, volume`. The datetimes (`2024.11.01 00:00`) are the MetaTrader
server's zone, with no daylight-saving switch: `BTCUSDT`'s 1h bars equal the perpetual trades summed
per hour, exactly, on every hour of 2020-10 and 2020-12 (over 1,000 hours), and only with the bar
labelled 03:00 holding the trades of 00:00–01:00 UTC. A month's file is therefore a UTC+3 month: it
opens with the previous UTC month's last three hours, and its month ends three hours before the UTC
month does.

**A metatrader file also ends with the next month's first bar.** `BTCUSDT`'s 1h file for 2020-10
closes with the bar `2020.11.01 00:00`, and the 2020-11 file opens with the same row, value for
value.

**Four metatrader months are truncated.** `BTCUSDT`'s 1h files for 2023-12, 2024-01 and 2024-03
hold 200 bars and 2024-02 holds 400, against 721–745 for a whole month; the 1m file of 2024-03 holds
200 bars (2024-03-01 00:00 → 03:19). Every other month from 2021-01 to 2024-11 is complete.
Checked on `BTCUSDT` only, on 2026-10-04.

### Columns

| tree | header |
|---|---|
| `trading/` | `timestamp, symbol, side, size, price, tickDirection, trdMatchID, grossValue, homeNotional, foreignNotional[, RPI]` |
| `spot/` | `id, timestamp, price, volume, side[, rpi]` |
| `premium_index/`, `spot_index/` | `start_at, symbol, period, open, high, low, close` |
| `kline_for_metatrader4/` | none |

`timestamp` is fractional seconds in `trading/` (`1743379200.0609`) and integer milliseconds in
`spot/` (`1743379200057`). `start_at` is whole seconds.

**A last column was appended in 2025-03 and 2025-04.** `trading/` files carry `RPI` from 2025-04-03
(`BTCUSDT`, `ETHUSDT`, the inverse `BTCUSD`), and `spot/` daily files carry `rpi` from 2025-03-13
(`BTCUSDT`, `ETHUSDT`).

**`spot/` monthly files kept the old header.** From 2025-03-13 on, their rows carry six values under
the five names `id, timestamp, price, volume, side`. `BTCUSDT-2025-03` mixes the two: 26,701,545
rows of five values, then 15,401,750 of six from 2025-03-13 00:00 UTC. In `BTCUSDT-2025-04`, every
row but the header has six. The monthly files of 2025-06, 2025-12 and 2026-06 are the same.

### The 2021 expiries are abandoned

`trading/` holds 44 dated futures directories. Forty of them — every expiry from 2022 on — carry
197 to 205 daily files each, a contiguous history. **The four 2021 ones do not**, and bybit's own
download form offers nothing older than 2022:

| directory | files | what is in them |
|---|---|---|
| `BTCUSDU21`, `ETHUSDU21` | 2 | one day, 2021-07-26, and nothing else |
| `BTCUSDZ21`, `ETHUSDZ21` | 29 | that same day, 27 days from 2021-12-06, one empty file |

A December-2021 contract traded for months before December, so 27 days is a fragment of it, and a
September-2021 contract with one July day is not a series at all.

**The single day is served twice and the two copies disagree.** `…2021-07-26_v2.csv`, uncompressed,
is the whole day, 28,828 rows; `…2021-07-26_v2.csv.gz` beside it holds 307 rows, of which 137 carry
a different `tickDirection` for the same `trdMatchID`. Whatever `_v2` meant, one of the two is wrong
and nothing says which.

#### Eight empty files, all written on one day

Across all 7,424 files in those 44 directories, exactly eight are under 100 bytes. Every one is 44
bytes, is a gzip of **nothing**, and is stamped **2022-12-12** — one per contract live or recent
that day, in `BTCUSDZ21`, `ETHUSDZ21` and the six 2022 expiries.

Two of them fall inside the 2021 directories. They are 44 bytes rather than zero: only the file
itself says it is empty.

### A directory can be renamed out from under its files

`trading/DATAOLD01USDT/` holds 527 files named `DATAUSDT2023-12-20.csv.gz` to
`DATAUSDT2025-05-29.csv.gz`. Bybit renamed the instrument, moved the directory and left every
filename as it was. `trading/DATAUSDT/` exists as well, but holds only files from 2026-07-09 on.

So **the directory is not evidence of the instrument's name**; the filename is.

### Limits

**The bucket: none found.** Measured 2026-09-30 with `HEAD` requests: about 1,190 a second from a
remote machine and 1,800 from a home link, without a single throttling answer.

**The CDN bans an address that asks too fast.** `public.bybit.com` refuses with CloudFront's own
HTML `403` page ("Request blocked"), names no key, and gives no budget in any header. While the ban
lasts the whole host — file downloads *and* index pages — answers `403`, and nothing distinguishes
it from a permanent block. The ban covers `public.bybit.com` alone: the bucket,
`s3.ap-southeast-1.amazonaws.com/public.bybit.com`, answered `200` for the same file throughout.

Bybit's published limits are for its API, not for the archive: see [Its limits](#its-limits).

**Where the line falls is not separated.** Two measurements:

- **3,855 requests in about 103 seconds**, by a client capped at 50 a second: refused at 39 requests
  in the last second, 39 a second over the last five and 40 over the last ten. The refusal of
  `https://public.bybit.com/trading/ANKRUSDT/ANKRUSDT2021-12-12.csv.gz` carried `Server: CloudFront`,
  `X-Cache: Error from cloudfront` and no S3 error code.
- **Tested directly on 2026-10-07.** Paced `GET`s of real files of about 25 KB (`premium_index` and
  `spot_index`, 2021), over HTTP/2 on four connections to `public.bybit.com`, thirty seconds at each
  rate:

  | asked | answered |
  |---|---|
  | 10, 20, 30 a second | every request `200` |
  | 40 a second | every request `200`, 124 ms at the median once the edge had the files |
  | 50 a second | 256 answered `200`, then `403` for the remaining 1,244 |

  It tripped about five seconds into the 50-a-second stage, after roughly 3,250 requests in 128
  seconds.

"More than 40 a second" and "about 3,000 in two minutes" both fit both measurements.

**A ban lasts some five to ten minutes.** On 2026-10-07 it ran from about 14:13:20 UTC to 14:18:39,
when the same requests were answered `200` again; earlier bans lapsed roughly ten minutes after they
began.

**A request with no `User-Agent` is refused outright**: at 10 a second from a client that sent none,
`403` on every one of 300 requests, with no ban involved — curl was answered `200` at the same
moment.

### The trees

```
trading/<SYMBOL>/<SYMBOL><yyyy-mm-dd>.csv.gz                    derivatives trades
spot/<SYMBOL>/<SYMBOL>-<yyyy-mm>.csv.gz                         spot, monthly
                <SYMBOL>_<yyyy-mm-dd>.csv.gz                    spot, daily
premium_index/<SYMBOL>/<SYMBOL><date>_premium_index.csv.gz
spot_index/<SYMBOL>/<SYMBOL><date>_index_price.csv.gz
kline_for_metatrader4/<SYMBOL>/<year>/<SYMBOL>_<interval>_<from>_<to>.csv.gz
trade/option/<UNDERLYING>/<date>_<UNDERLYING>_USDT.trades.csv.zip
mark_kline/option/<UNDERLYING>/<date>_<UNDERLYING>_USDT.OHLC.csv.zip
```

**The last two are options, and the HTML indexes expose neither.** They are keyed by underlying
rather than by symbol, and are the only trees on this host in `.csv.zip`.

**The index and mark trees are one-minute bars, and say so.** Each `premium_index` and `spot_index`
file carries a `period` column reading `1`, and its rows are 60 seconds apart — 1,440 a day, checked
across twelve files of each. Option mark bars are a uniform 60,000 ms between `open_time` values.

### Renderings told apart by filename alone

**`spot/` publishes the same month twice in one directory**, told apart by nothing but the filename:

```
spot/BTCUSDT/  BTCUSDT-2022-11.csv.gz      monthly
               BTCUSDT_2026-08-03.csv.gz   daily
```

Hyphen against underscore: a monthly file is `<SYMBOL>-YYYY-MM`, a daily one `<SYMBOL>_YYYY-MM-DD`.

**MetaTrader klines publish one period at five intervals at once** — `1`, `5`, `15`, `30`, `60`,
which MetaTrader counts in minutes — all in the same year directory. Only the interval in the
filename tells two files for one month apart.

### Dates are not at the end of a name

The date is not the last token of a name: a suffix follows it (`_premium_index`, `_index_price`).
Bybit also runs the symbol straight into the date (`BTCUSDT2020-03-25`), and gives MetaTrader files
two dates. The **first** date in a filename is the date of its contents — a MetaTrader file's second
is its month's last day — and a monthly `spot/` file carries a month with no day.

### The misfiled file

`trading/DOTUSD/DOTUSDT2021-12-06.csv.gz` is genuinely served: a file named for `DOTUSDT`, in
`DOTUSD`'s folder. It holds DOTUSDT rows and is a shorter copy of the day served whole at
`trading/DOTUSDT/DOTUSDT2021-12-06.csv.gz`:

| | bytes | trades | from | timestamps |
|---|---|---|---|---|
| under `DOTUSDT/` | 2,185,333 | 55,249 | 00:00:02 UTC | with fractions of a second |
| under `DOTUSD/` | 1,758,646 | 45,780 | 06:06:23 UTC | whole seconds |

Every trade id of the shorter one is in the whole one (2026-10-07). One misfiled artifact, not a
pattern.

### A second host: the order books

Order books are not in the trees above and are not on that host at all:

```
base    https://quote-saver.bycsi.com
root    orderbook/
layout  orderbook/{linear,inverse}/<SYMBOL>/<yyyy-mm-dd>_<SYMBOL>_ob<depth>.data.zip
```

**A separate server means a separate everything.** Different address, different tree, browsable HTML
indexes instead of a bucket listing, and its own limits. The host carries `linear/` and `inverse/`
and no third market.

**The indexes name files and state nothing else** — no size, no last-modified, no checksum. They are
generated rather than stale; `orderbook/linear/` was rewritten the morning it was checked.

**The depth changed mid-history.** `linear/BTCUSDT/` holds:

```
ob500     946 files   2023-01-18 → 2025-08-20
ob200     353 files   2025-08-21 → 2026-08-08
```

No date carries both, so bybit switched from 500 levels to 200 on 2025-08-21.

**No limit found.** Measured 2026-09-30: 5,496 `HEAD`s a second from a remote machine on keys the
edge had cached, and 3,870 a second from a home link on missing ones, which the edge passes to the
origin (~220 ms), without a single throttling answer.

**A missing key's `404` carries neither a `Content-Length` nor chunked encoding**, so over HTTP/1.1
its end is the connection closing. The host speaks HTTP/2, where each request is a stream of its own.

#### What a book file holds

The `.data.zip` holds one file of a JSON record a line:

```
{"topic":"orderbook.200.XAUTUSDT-19JUN26","type":"snapshot","ts":1780272001020,
 "data":{"s":"XAUTUSDT-19JUN26","b":[["4518.3","1.178"],…],"a":[…],"u":1,"seq":13314825492},"cts":…}
```

`type` is `snapshot` where the stream opens — twice in each of three files read — and `delta` after.
`b` and `a` are `[price, size]` levels, and a size of `0` removes the level. `ts` is in milliseconds,
unique and rising through a file. `seq` rises through a file; `u` starts over at each snapshot.

#### Its origin bucket is not findable

- A missing key returns S3's own 404 through the edge, but it carries only `Code`, `Key`,
  `RequestId` and an opaque `HostId`, and no `BucketName` field.
- The primary's convention does not hold. `public.bybit.com` is literally a bucket name, but
  `quote-saver.bycsi.com`, `quote-saver`, `bycsi.com` and `bybit-quote-saver` all answer
  `NoSuchBucket` from `s3.amazonaws.com`, where a bucket in another region would answer
  `PermanentRedirect` and name itself. The S3 namespace is global, so those names exist nowhere.

## REST

**How to read this section.** A statement with no mark is what the API answered when it was asked,
in October 2026. *(documented)* marks what bybit's documentation states and was not tried.
*(not known)* marks what neither settled. Nothing here is inferred from another venue.

### The API

**One API on one host**: `https://api.bybit.com/v5/market/<endpoint>`, asked a `category` at a time —
`spot`, `linear` (USDT and USDC contracts), `inverse` (coin-margined), `option`.

- **`api.bytick.com` answers the same**, and both are behind CloudFront. Regional hosts exist
  *(documented)*: `api.bybit.tr`, `.kz`, `.ae`, `.eu`, `.id`, `api.bybitgeorgia.ge`.
- **Times are milliseconds**, in requests and answers; in answers they are strings.
- **Every answer is HTTP 200** with `{retCode, retMsg, result, retExtInfo, time}`. `retCode` 0 is
  success; anything else is the error, and the header `ret_code` repeats it. Seen: `10001` with
  `params error: Time Is Invalid`, `Symbol Invalid`, `status invalid`.
- **Records are in `result.list`**, except historical volatility, where `result` is the list.
- **Lists come newest first.**

### Its limits

- **600 calls per 5 seconds for the whole host, by address** *(documented)*.
- **Beyond it: HTTP 403**, `text/plain`, "Access too frequent. Please try again later." — met after
  some 290 calls a second over 96 connections. **It did not last**: another call to the same host
  right after it answered, and so did one 30 seconds later. A wait of at least 10 minutes is what
  is stated *(documented)*.
- **Public calls carry no limit header.** Their headers are `traceid`, `timenow`, `ret_code`,
  `x-cld-src`. The `X-Bapi-Limit`, `X-Bapi-Limit-Status` and `X-Bapi-Limit-Reset-Timestamp` headers,
  and the `retCode` 10006 "Too many visits!", belong to signed calls, limited per account
  *(documented)*.
- **Kept without complaint**: 23 calls a second over 8 connections, for 400 calls.

### How it is paged

- **A `limit` over the maximum is capped, silently**: 1,001 bars return 1,000, 201 fundings 200.
- **Bars, by `start`**: with `start` alone the answer is the first `limit` bars at or after it —
  still newest first inside the page. So a walk is forward, and the next `start` is the newest
  bar's time plus one interval. With `end` alone it is the `limit` bars up to `end`.
- **`start=1` is not honoured** on `linear` and `inverse` bars: the newest page comes back. A real
  past time (`1500000000000`) returns the instrument's first bars. On `spot`, `start=1` does.
- **Funding, by `endTime`**: the `limit` records up to it; a walk is backward, and the next
  `endTime` is the oldest record's time minus one. `startTime` alone is refused; both together
  work.
- **Open interest and ratios, by cursor**: `result.nextPageCursor` (for example
  `lastid%3D3548695%26lasttime%3D1791525300`) passed back as `cursor` gives the next older page.
  A `startTime`/`endTime` window works as well.

### Endpoints that serve the past

**Bars — `GET /v5/market/kline`**
- **Ask**: `category` (`spot`, `linear`, `inverse`), `symbol`, `interval` (`1 3 5 15 30 60 120 240
  360 720 D W M`), `start`, `end`, `limit` ≤ 1,000.
- **Answer**: rows of strings `[startTime, open, high, low, close, volume, turnover]`.
- **Reaches the instrument's first bar**: `linear` BTCUSDT 2020-03-25T10:36Z, `inverse` BTCUSD
  2018-11-14T16:00Z, `spot` BTCUSDT 2021-07-05T12:00Z.
- **A delisted contract still answers** (a perpetual closed in 2025, a dated future delivered in
  2026), **and so does a delisted spot pair**.

**Mark, index and premium bars — `GET /v5/market/mark-price-kline`, `index-price-kline`,
`premium-index-price-kline`**
- **Ask**: as bars. Mark takes `linear`, `inverse`, `option` (500 a page for options); index takes
  `linear`, `inverse`; premium takes `linear`.
- **An option's mark bars exist while it is listed**: an expired option is `10001 PARAMS_ERROR`.
- **Answer**: rows `[startTime, open, high, low, close]`.
- **Reaches**: BTCUSDT mark 2020-03-25T08:41Z, index 07:57Z, premium 08:41Z.
- **A delisted contract still answers** mark and index; its premium bars came back all `"0"`.

**Funding — `GET /v5/market/funding/history`**
- **Ask**: `category` (`linear`, `inverse`), `symbol` — required — `startTime`, `endTime`, `limit`
  ≤ 200.
- **Answer**: `{symbol, fundingRate, fundingRateTimestamp}`.
- **Reaches the first funding**: BTCUSD 2018-11-15T00:00Z, BTCUSDT 2020-03-25T16:00Z.
- **A delisted contract still answers.**

**Open interest — `GET /v5/market/open-interest`**
- **Ask**: `category` (`linear`, `inverse`), `symbol`, `intervalTime` (`5min 15min 30min 1h 4h
  1d`), `startTime`, `endTime`, `limit` ≤ 200, `cursor`.
- **Answer**: `{openInterest, singleOpenInterest, timestamp}`, and `result.nextPageCursor`.
- **Reaches 2020-08-05** at 5 minutes for BTCUSDT (a window in 2020-05 is empty); `inverse` BTCUSD
  daily from 2020-08-04.
- **A delisted contract answers an empty list.**

**Long/short ratio — `GET /v5/market/account-ratio`**
- **Ask**: `category` (`linear`, `inverse`), `symbol`, `period` (`5min 15min 30min 1h 4h 1d`),
  `startTime`, `endTime`, `limit` ≤ 500, `cursor`.
- **Answer**: `{symbol, buyRatio, sellRatio, timestamp}`.
- **Reaches 2020-08-05** (daily, BTCUSDT); 5-minute windows of 2021 and 2023 answer.
- **A delisted contract answers an empty list.**

**Historical volatility — `GET /v5/market/historical-volatility`**
- **Ask**: `category=option`, `baseCoin`, `period` (days), `startTime`, `endTime` — a window of 30
  days at most *(documented)*.
- **Answer**: `result` is `[{period, value, time}]`, one an hour.
- **Without a window it returned nothing**; with one, 480 rows for 20 days.
- **Reaches**: 2,200 days back at least (2020-10); 2 years is what is stated.

**Delivery prices — `GET /v5/market/delivery-price`**
- **Ask**: `category` (`linear`, `inverse`, `option`), `symbol`, `limit` ≤ 200, `cursor`.
- **Answer**: `{symbol, deliveryPrice, deliveryTime}`.
- **Reaches**: `inverse` 2021-06-25, all 44 in one page; `linear` 2023-03-24, 258 over two pages.
  `option` returns only contracts being delivered *(documented)*; it was empty.
- **Options have their own — `GET /v5/market/new-delivery-price`**: `category=option`, `baseCoin`;
  `{deliveryPrice, deliveryTime}`, the most recent 50, one a day.

**Delisted instruments** are listed by [the instrument listing](#the-instrument-listing).

**Announcements — `GET /v5/announcements/index`**: `locale`, `type` (`delistings`, `new_crypto`,
…), `page`, `limit`; `result.list[]` of `{title, description, type, tags, url, dateTimestamp, …}`
and `result.total` — 483 delistings when asked. Where a delisted spot pair's name can be found.

### Endpoints that do not

- **`recent-trade`**: the newest 1,000, or 60 on spot, and nothing older.
  `{execId, symbol, price, size, side, time, isBlockTrade, isRPITrade, seq}`.
- **`insurance`**: the pools' balances now, `{coin, symbols, balance, value}`.
- **`index-price-components?indexName=`**: an index's exchanges, prices and weights now.
- **`tickers`, `orderbook`, `risk-limit`, `adlAlert`, `fee-group-info`, `order-price-limit`**: of
  now *(documented)*.
- **Liquidations**: the market endpoints listed in the documentation hold none.
- **`/v5/spot-margin-trade/interest-rate-history`** wants a key ("apiKey is missing").
- **`/v5/spread/market/*`** — spread instruments, their book, recent trades and tickers
  *(documented)*; no history among them.

### Against bybit's own archive

**REST bars are the archive's bars.** Of the first 600 rows of the archive's `BTCUSDT` 1-minute file
for 2020-05, all 600 are in REST with the same open, high, low, close and volume, three hours
earlier: the archive stamps UTC+3. REST adds turnover.

### The instrument listing

**`GET /v5/market/instruments-info`**, asked a `category` at a time — `spot`; `linear` (settled in
USDT or USDC) and `inverse` (settled in the base coin), each holding perpetuals and dated futures;
and `option`, answered one underlying at a time — with `status`, `baseCoin`, `limit` ≤ 1,000 and
`cursor`. Option defaults to `baseCoin=BTC` and there is no public way to enumerate the underlyings
(eight, when asked in October 2026).

**Names are the archive's.** All 549 live spot symbols and 859 of 862 live perpetuals are in the
archive under exactly the name the API returns; the three that were not had been listed that day.

**Derivatives state an ending; spot does not.** `status=Closed` lists delisted contracts of `linear`
and `inverse`, with `launchTime` and `deliveryTime`: asked, a derivative category answered 955
contracts that share nothing with its 836 live ones. Spot answers `status=Closed` with the live
list again, byte for byte, and states no launch time, so there an ending is only ever an absence.
`Trading` and `PreLaunch` are the other values that answered; `Settling` is refused, `Delivering`
empty.

## WebSocket

Verified live on 2026-07-26.

```json
publicTrade.BTCUSDT  {"T":1785060230817,"s":"BTCUSDT","S":"Buy","v":"0.001","p":"64474.20",
                      "L":"PlusTick","i":"f520fc20-…","BT":false,"RPI":false,"seq":715964329311}
orderbook.1.BTCUSDT  {"s":"BTCUSDT","b":[["64474.1","1.4"]],"a":[["64474.2","7.108"]],"u":4030692,"seq":715964319629}
tickers.BTCUSDT      {"symbol":"BTCUSDT","markPrice":"64475.28","indexPrice":"64510.19",
                      "openInterest":"57733.175","openInterestValue":"3722362623.41",
                      "fundingRate":"0.00001534","nextFundingTime":"1785081600000","fundingIntervalHour":"8",
                      "fundingCap":"0.005","turnover24h":…,"volume24h":…,"bid1Price":…,"ask1Price":…}
```

**Subscribing.** The linear perpetuals' endpoint is `wss://stream.bybit.com/v5/public/linear`, and a
channel is a raw topic:

```
→ {"op":"subscribe","args":["publicTrade.BTCUSDT"],"req_id":"publicTrade.BTCUSDT"}
← {"success":true,"ret_msg":"","conn_id":"…","req_id":"publicTrade.BTCUSDT","op":"subscribe"}
← {"topic":"publicTrade.BTCUSDT","type":"snapshot","ts":…,"data":[{…}]}
```

A successful ack does not name the topic — `ret_msg` is empty — and echoes the request's `req_id`
verbatim. A refusal names the topic in prose:
`{"success":false,"ret_msg":"error:handler not found,topic:nonsense.BTCUSDT",…}`. Data frames carry
`topic`; acks carry `op`.

**The archive's trades are at least as good as the feed.** The perpetual trade files carry every
field `publicTrade` does — `tickDirection` is `L`, `trdMatchID` is `i`, and `RPI` — with a
sub-millisecond timestamp (`1784851200.0547`) where the feed's `T` is whole milliseconds. The feed
adds only `seq` and the block-trade flag `BT`.

**`tickers` carries the present of what the archive lacks.** Mark and index price, open interest
and its value, and the funding rate with its cap, interval and next time all arrive in one payload.
The archive holds only premium-index and spot-index klines of these. The history of the rest is on
REST, under [Endpoints that serve the past](#endpoints-that-serve-the-past): funding, open interest,
and mark, index and premium bars.
