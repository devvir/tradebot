# HTX

HTX as a source of market data: what it publishes, where, and how it behaves when asked.

## Archives

What htx's published archive holds, measured against the bucket, and what htx says about it. Two
announcements cover the archive's current form:

- [The upgrade](https://www.htx.com/support/25034776369944/), live `2026-06-03`: a restructured
  directory layout, standardised field names across all datasets, order books and funding rates
  added, options discontinued.
- [The legacy shutdown](https://www.htx.com/support/55039723330936/): updates to the old tree
  discontinued `2026-08-04`, with what is already there retained and still downloadable.

The shutdown notice says legacy data "dated August 3, 2026, and earlier" is retained; the old tree
also holds klines and trades dated `2026-08-04`.

### Where it is served

#### The bucket behind the Akamai edge

The bucket names itself in every listing (`<Name>huobi-service-data</Name>`). It is public and
answers the S3 listing API at `huobi-service-data.s3.amazonaws.com`. A missing key is a plain `404`,
every key carries an MD5 `ETag`, and a `.CHECKSUM` beside each archive holds its SHA-256 and file
name.

`www.htx.com/data/` serves the same keys through Akamai, unchanged in content; the portal's download
buttons go through `/vision/?prefix=…`, a browser over the same keys. The edge enforces a limit far
below the bucket's. Half a dozen listing requests earn a `403 AkamaiGHost` on every prefix at once.
Probes are then left neither answered nor refused, each socket silent until it dies on its own
deadline. Through the edge a `403` carries no `x-amz-error-code`, so absence and rejection arrive as
the same answer.

**No limit found on the bucket.** Measured 2026-09-29 and 30 with `HEAD` requests: about 1,800 a
second from one machine and 1,180 from a remote one, without a single throttling answer.

### Layout

#### Two archives in one bucket: the current one and the one it replaced

HTX publishes **two trees** in one bucket, and both are official. The data portal
([`/futures/data/landing_page/`](https://www.htx.com/futures/data/landing_page/), which carries a
Spot tab without changing the URL) links `historical_data/`, and its **Visit Old Version** button
links `data/`. The portal states *"Historical data from February 1, 2026 is supported. For older
data, please visit the old version"*.

| | `historical_data/` | `data/` |
|---|---|---|
| status | current, the one the portal offers | the "old version", still linked |
| earliest | `2026-02-01` (books `2026-05-28`) | `2018-11-09` futures trades, `2020-06-01` BTC spot |
| latest | written daily | klines and trades dated `2026-08-04`, index and mark `2026-08-03`; last written `2026-08-05` |
| markets | `spot`, `futures` | `spot`, `future`, `swap`, `linear-swap`, `option` |
| datasets | `klines`, `trades`, `index-klines`, `mark-klines`, `funding-rates`, `orderbook` | `klines`, `trades`, `index-klines`, `mark-price-klines` |
| layout | `<market>/daily/<dataset>/<SYMBOL>/` | `<dataset>/<market>/daily/<SYMBOL>/` |
| kline intervals | `1m 5m 15m 30m 1h 4h 1d` | `1min 5min 15min 30min 60min 4hour 1day` |

**Neither tree is a rolling window.** On `2026-11-25` `historical_data/` still held `2026-02-01` and
`data/` still held `2018-11-09`.

**`historical_data/` was filled backwards.** Its files for `2026-02-01` were written between
`2026-05-14` and `2026-05-19`. Books were not: each book file is written as its day ends, from
`2026-05-28`.

**The trees spell an instrument differently in three of the five cases:**

| market | `historical_data/` | `data/` |
|---|---|---|
| spot | `BTC-USDT` | `BTCUSDT` |
| perpetual | `BTC-USDT-PERP`, `BTC-USD-PERP` | `BTC-USDT`, `BTC-USD` |
| dated, coin-margined | `BTC-USD-260206` | `BTC260206`, no quote currency at all |
| dated, USDT-margined | `BTC-USDT-260206` | the same |
| option | none | `BTC-USDT-200828-C-10500` |

- **Every perpetual key under `historical_data/futures/` carries `-PERP`, and every other key there
  ends in a six-digit expiry.** Of 862 instruments on `2026-11-25`, 640 were perpetuals and 222
  dated contracts, nothing else.
- **`data/` joins a spot pair**, so the quote has to be found by its end. Its 2,358 spot pairs are
  quoted in 27 currencies: `USDT`, `BTC`, `ETH`, `KRW`, `HT`, `HUSD`, `USDC`, `USDD`, `JPY`,
  `THB`, `IDR`, `EOS`, `TUSD`, `HPT`, `ARS`, `BRL`, `EUR`, `EUROC`, `USD`, `RUB`, `TRY`, `UAH`,
  `USD1`, `TRX`, `UST`, `GBP`, and `KGST` in a single pair listed `2026-03-12`. The longest match
  is the right one: `USDTRUB` is `USDT`/`RUB`, not `USD`/`TRUB`, and `EUROC` is not `EUR`. `USD1`
  is a stablecoin.
- **A coin-margined dated contract names a base and an expiry alone** and settles in `USD`:
  `ADA200807` is `ADA-USD-200807`.
- **An option's strike can read as an expiry**: a six-digit strike like `-C-100000`.
- **Some `historical_data/` spot names are not ASCII.** Six pairs are spelt in Chinese characters
  (`龙虾-USDT`, `老子-USDT` and others), and three leveraged tokens carry `*`, `(` and `)`:
  `ZEC*(-3)-USDT`, `ZEC*3-USDT` and `BSV*(-3)-USDT`, which `data/` calls `ZEC3SUSDT`,
  `ZEC3LUSDT` and `BSV3SUSDT` (the same prices, minute for minute).

**`historical_data/futures/` holds three of the old markets**, told apart by the symbol:
`…-USDT-PERP` is `linear-swap`, `…-USD-PERP` is `swap`, and `BTC-USD-260206` is a dated `future`.
The portal's Mark Price card offers the dataset "for perpetual and delivery futures".

**`data/linear-swap/` also holds dated contracts**, beside the perpetual they settle against:
`data/klines/linear-swap/daily/BTC-USDT-230407/` sits next to
`data/klines/linear-swap/daily/BTC-USDT/`. 616 dated symbols live there, across six roots
(`BTC-USDT`, `ETH-USDT`, `DOSE-USDT`, `DUSK-USDT`, `CVX-USDT`, `TOMO-USDT`), and 56 of them are
also in `historical_data/futures/`. `data/future/` is dated and coin-margined throughout.

**The portal's two tabs are the tree's two directories:**

| tab | datasets offered |
|---|---|
| Futures | Order Book (L2 150), Single Trade, Candlestick, Index Price Candlestick, Mark Price Candlestick, Funding Rate |
| Spot | Order Book (L2 400), Single Trade, Candlestick |

Index and funding exist for perpetuals only; mark covers perpetuals and dated contracts, in both
trees.

**Only in `data/`: everything before `2026-02-01`, and options.** The `option` market's last file is
dated `2021-06-25`; its 954 symbols all end long before `historical_data/` begins.

**Only in `historical_data/`: order books and funding rates.** HTX did not publish either before
this tree. Funding starts at the tree's first day, `2026-02-01`; books start `2026-05-28`, `lv400`
on spot and `lv150` on futures.

**What else the bucket holds:**

- At the root, `index.html` (with two older copies) and `assets/`: the bucket's own browsing page.
  `test/` holds scratch uploads (`s3-upload-test-….tar.gz`, a stray 2021 kline file).
- **A `remark.txt` at the root of each `data/<dataset>/<market>/`**, thirteen in all (none under
  `option`), written `2026-03-05`: the field descriptions that the portal shows in a dialog. They
  carry no date.
- Three stray `data/` keys: `data/klines/swap/daily/NULL/NULL/NULL-NULL-2020-11-07.zip`, and two
  zero-byte CSVs under directories named for a date and time,
  `data/index-klines/swap/daily/2025-12-10 12:06:29/` and
  `data/mark-price-klines/future/daily/2026-01-25 12:17:38/`.

##### Where they ran together: `2026-02-01` to `2026-08-04`

Both ends of the span are declared by HTX: the portal's sentence above, and the shutdown notice. The
figures below were measured over the whole overlap. `data/` has not been written since `2026-08-05`,
and the spot checks made on `2026-11-25` still held.

**Where both trees carry a day they agree on its values, but they do not carry the same days.**
`historical_data/` holds **10,608 instrument-days that `data/` does not**, across 6,334 series.
Only 4,096 of those fall after `data/`'s own last day for that series. The rest, **6,512 days across
2,302 series, are holes in the middle of a range `data/` was still publishing**. They run from
February to June 2026, peak across April and May, and stop after June.

The holes are concentrated in `trades` and `klines`, and they hit ordinary instruments: `DOGE-USDT`
spot trades are missing 51 days, `SOL-USDT` 43, `OM-USDT` spot trades 19. `historical_data/`'s files
for those days carry real trades (`T-USDT` on `2026-03-01` holds 1,222 prints and on `2026-04-15`
16,480, where `data/` has no file).

**In the other direction there is almost nothing.** `data/` carries **63 series-days** that
`historical_data/` lacks: index klines, all seven intervals, for the nine coin-margined perpetuals
then trading (`ADA-USD`, `BTC-USD`, `DOGE-USD`, `DOT-USD`, `ETH-USD`, `LINK-USD`, `LTC-USD`,
`TRX-USD`, `XRP-USD`), on `2026-06-03`, the day the upgrade went live.

**Nine instruments traded during the overlap and `historical_data/` never carried them**, all
USDT-margined perpetuals. `data/` is their only archive, and all nine stop by `2026-08-03`:

| symbol | trade days in the window | bytes | last trade file |
|---|---|---|---|
| OPUL-USDT | 10 | 633,862 | `2026-07-29` |
| ROUTE-USDT | 10 | 626,272 | `2026-07-29` |
| UOS-USDT | 9 | 623,785 | `2026-07-29` |
| MPLX-USDT | 9 | 617,518 | `2026-07-29` |
| LRDS-USDT | 10 | 606,434 | `2026-07-29` |
| CVX-USDT | 21 | 13,196 | `2026-08-03` |
| DOSE-USDT | 3 | 1,262 | `2026-06-17` |
| FSN-USDT | 1 | 350 | `2026-06-17` |
| UNB-USDT | 1 | 346 | `2026-05-21` |

HTX's own `TEST001-USDT` and `TEST002-USDT` are in the same position, with one trade day each.

**75 symbols in all had `data/` files inside the window and no `historical_data/` series of the same
name.** The other 64 did not trade inside the window. They had died earlier (`CEEK-USD` last traded
`2024-10-30`, `VRA-USD` `2024-12-22`), and `data/` kept publishing a frozen placeholder for them:
klines that repeat a final price at zero volume, and index and mark series that stop. By market:

- 16 perpetuals;
- 45 dated contracts, expiries whose underlying was already dead (`CEEK` and `DORA` weeklies,
  `CVX-USDT-240315`, `TOMO-USDT-240329`, `DOSE-USDT-251226`);
- three spot leveraged tokens, `BSV3SUSDT`, `ZEC3LUSDT` and `ZEC3SUSDT`, which `historical_data/`
  does carry, as klines only and under the spellings above.

**The move was atomic.** Not one series of the 18,753 both trees carry starts in `historical_data/`
later than `data/` was still publishing it. An instrument listed during the overlap appears in both
trees on the same day: `ARIA-USDT-PERP` on `2026-04-10`, `BARD-USDT-PERP` on `2026-03-06`,
`WOJAK-USDT` on `2026-06-30`. Every interval of a series starts on the same day.

**A `historical_data/` trades file exists only on a day that had trades.** A quiet instrument has
klines, index, mark and funding every listed day, and trade files only on some. `data/` behaved the
same way before the overlap; during it, the holes above make a missing `data/` trades file no
evidence that the instrument was quiet.

#### Paths

```
historical_data/<market>/daily/<dataset>/<SYMBOL>/[<interval>/]<SYMBOL>-<stem>-[<interval>-]<yyyy-mm-dd>.zip
historical_data/<market>/daily/orderbook/lv{400,150}/<SYMBOL>/<SYMBOL>-l2orderbook-{400,150}lv-<yyyy-mm-dd>.tar.gz

data/<dataset>/<market>/daily/<SYMBOL>/<SYMBOL>-trades-<yyyy-mm-dd>.zip
data/<dataset>/<market>/daily/<SYMBOL>/<interval>/<SYMBOL>-<interval>-<yyyy-mm-dd>.zip
```

- `historical_data/` stems: `trades`, `klines`, `index-klines`, `mark-price-klines`, `fundingRates`
  (`BTC-USDT-PERP-fundingRates-2026-11-24.zip`, `BTC-USDT-klines-1m-2026-11-24.zip`).
- `data/` kline files carry no dataset stem: `BTCUSDT-1min-2026-08-04.zip`.
- Checksums: `<file>.CHECKSUM` in `historical_data/`, `<file without .zip>.CHECKSUM` in `data/`.
- The two trees **invert dataset and market**: `historical_data/spot/daily/trades/` against
  `data/trades/spot/daily/`.
- Only daily files exist in either tree; there is no monthly tree.

### File formats

#### The shapes the two trees write

Four datasets are in both trees, and each has a different shape in each tree. Read off real files of
`2026-08-03`:

| dataset | market | `historical_data/` | `data/` |
|---|---|---|---|
| klines | spot, contracts | `instId,open,high,low,close,vol,volCcy,volCcyQuote,ts` | `timestamp,open,close,high,low,vol,amount` |
| trades | spot | `instId,tradeId,px,side,size,ts` | `Trade ID,Trade Time,Trade Price,Volume (Base Currency),Side (buy/sell)` |
| trades | contracts | `instId,tradeId,px,side,size,ts` | `Trade ID,Trade Time,Trade Price,Volume (in Contracts),Volume (in Base Currency),Turnover,Side (buy/sell)`; coin-margined without `Turnover` |
| index, mark | contracts | `instId,open,high,low,close,ts` | `timestamp,open,close,high,low` |

`historical_data/` funding is `instId,fundingRate,fundingTime`.

- **Column order differs**: OHLC in `historical_data/`, OCHL in `data/`.
- **The column sets differ.** `historical_data/` klines carry `volCcyQuote`, the quote turnover;
  `data/` contract trades carry the base volume and the turnover, which `historical_data/` drops.
- **The volume names invert on spot.** `data/` calls the quote volume `vol` and the base `amount`;
  `historical_data/` calls the base `vol` and the quote `volCcy` and `volCcyQuote` (on contracts,
  `vol` is contracts, `volCcy` base and `volCcyQuote` quote). Joined on time, `BTC-USDT` 1-minute
  klines of `2026-08-03` match bar for bar across the two trees.
- **`data/` never took the newer shape.** Its last files, `2026-08-04` klines and trades, carry the
  `data/` columns above. A key's tree says its shape.
- **Units**: kline times are seconds in both trees, the bar's start; trade times and funding times
  are milliseconds.
- **Kline rows are not always in time order.** `historical_data/` `BTC-USDT` 1m of `2026-11-24` and
  `data/` `BTCUSDT` 1min of `2026-08-03` are out of order; other days of the same series are sorted.
  Trade rows are in time order.

#### `data/`'s header rows

`data/`'s columns stayed the same over its life, but whether a file opens with a header row did not:

| files | first line |
|---|---|
| klines and trades, every market, up to early March 2026 | no header: a data row |
| index and mark klines of 2021 to early 2022 (`BTC-USDT`, `BTC-USD`, `ADA210702` seen) | `id,open,close,high,low` |
| index and mark klines of mid-2022 to 2023 | `timestamp,open,close,high,low` on some series, no header on others of the same days (`BTC-USDT` index headed, `BTC-USD` index and `BTC-USDT-230714` mark not) |
| index and mark klines of 2024 to early March 2026 | no header |
| every dataset, from `2026-03-02` to `2026-03-04` on (the day varies by series) | the header in the table above |

A row of 2021 has the same fields in the same order as a row of 2026.

#### Daily files are UTC+8 days, not UTC days

A file named `<yyyy-mm-dd>` holds `16:00:00` UTC the previous day through `15:59:5x` UTC that day: a
Beijing day, cut at midnight UTC+8. This was read off real trade timestamps in `BTC-USDT` spot,
`BTCUSDT` spot and `BTC-USDT-PERP`, and it is the same in **both trees**. The date in a path is a
UTC+8 day label.

The REST API agrees: its `1day` kline `id` is the same UTC+8 day start. A bar rendered with a UTC
formatter appears to sit one day before the file covering the same trades; both match exactly once
read as UTC+8.

#### Order books: 400 levels spot, 150 futures

`historical_data/<market>/daily/orderbook/lv400/` on spot and `lv150/` on futures, each day a
`.tar.gz` holding one `.data` file (every other dataset is a `.zip` holding one `.csv`).

The `.data` file is one JSON record a line: `{"instId", "action", "ts", "asks", "bids"}`. The first
record is a `snapshot` of the whole book and the rest are `update`s holding the levels that changed.
A level is `[price, size]`, both strings, and a size of `"0"` removes it. `ts` is a string of
microseconds and rises through the file. A day's file runs 16:00 UTC to 16:00 UTC, like every other
daily file.

#### Mark and index prices are klines

Mark and index prices are published as klines: `index-klines/` and `mark-klines/` (in `data/`,
`mark-price-klines/`), a directory per interval, each row a bar's open, high, low and close of the
price.

#### A contract's kline volume counts both sides of every trade

**On perpetuals, dated futures and options a kline's volume is twice what was traded.** A trade of
ten contracts is ten bought and ten sold, and the kline reports twenty. That is the venue's
definition: its API reference says of `vol`, of `amount` and of `count` alike, *"Sum of both buy and
sell sides"*, in the futures reference and the USDT-margined swap reference, and nowhere in the spot
one.

| | kline volume ÷ the same minutes' trades |
|---|---|
| perpetuals, linear and inverse | 2 |
| dated futures, linear and inverse | 2 |
| options | 2 |

- **Exact, and in every minute.** Summed over a day the two differ by a factor of exactly two, to the
  last contract, and so does each of a day's 1,440 one-minute bars against the trades inside that
  minute.
- **Always.** The same in 2020 and in 2026, in both trees, on every instrument and day measured
  (`BTC-USDT` perpetual, `2023-07-07`, `2025-06-01` and `2026-11-24`, among them).
- **The trades themselves are listed once.** Only the figure a kline adds up is two-sided.

**The archive's own `remark.txt` does not say so.** It describes `vol` as "Trading volume denominated
in contracts" and `amount` as "Trading volume denominated in the base currency", and carries that
same text for spot, where `vol` is the quote volume.

**Spot klines count a trade once, but spot trade files do not always hold every trade.** On
`BTCUSDT` the day's 1-minute kline base volume equals the trade file's sum on `2020-06-01`,
`2023-07-07` and `2024-01-02`. On every day checked from `2024-07-02` on, the kline volume is the
larger: 1.7 times on `2024-07-02`, 4.7 on `2025-01-02`, 3.3 on `2026-01-31` and 13.7 on `2026-11-24`
(`historical_data/`). `ETH-USDT` on `2026-11-24` is 6.9 times; `DOGE-USDT` on the same day matches
exactly.

### Publication

Hours from 00:00 UTC of the date in a file's name to the file's `Last-Modified`. The date names a
UTC+8 day, which ends at 16:00 UTC, so 16 h is the earliest a complete day can appear.

- **Measured 2026-09-25** over the `historical_data/` files of 2026-09-15 to 21 (99,429 files):
  p50 **28.2 h**, p99 **30.9 h**.
- **Sampled 2026-11-25** over the files of 2026-11-15 to 21 for twelve symbols per dataset (1,797
  files):

| dataset | files | p50 | p99 |
|---|---|---|---|
| spot klines | 343 | 28.1 h | 29.0 h |
| spot trades | 70 | 29.6 h | 34.0 h |
| spot books | 75 | 16.0 h | 19.0 h |
| futures klines | 392 | 25.3 h | 25.4 h |
| futures trades | 35 | 30.0 h | 31.0 h |
| funding | 49 | 24.5 h | 24.7 h |
| index klines | 392 | 28.8 h | 28.9 h |
| mark klines | 392 | 29.3 h | 29.5 h |
| futures books | 49 | 16.1 h | 16.1 h |

Books are written as their day ends; every other dataset follows some 8 to 18 hours later.

## REST

**How to read this section.** A statement with no mark is what the API answered when it was asked,
in October 2026. *(documented)* marks what htx's documentation states and was not tried — the
pages read are those at `huobiapi.github.io/docs`, the newer portal being a script. *(not known)*
marks what neither settled. Nothing here is inferred from another venue.

### The API

**Two hosts, and on the second a path tree for each family.**

| family | host | reference data | market data |
|---|---|---|---|
| spot | `https://api.huobi.pro` | `/v1/common/*`, `/v2/settings/common/*` | `/market/*` |
| USDT-margined swaps and futures | `https://api.hbdm.com` | `/linear-swap-api/v1/*`, `/v3/*` | `/linear-swap-ex/market/*` |
| coin-margined swaps | `https://api.hbdm.com` | `/swap-api/v1/*` | `/swap-ex/market/*` |
| coin-margined futures | `https://api.hbdm.com` | `/api/v1/contract_*` | `/market/*` |
| derived bars, any family | `https://api.hbdm.com` | | `/index/market/history/*` |

- **Spot is behind CloudFront, derivatives behind Tencent EdgeOne** (`eo-log-uuid` in the headers).
  From the machine that asked, spot was served from CloudFront's New York edge (JFK52), 90 to
  145 ms to connect; derivatives 13 ms to connect, with the API 243 ms behind the edge.
  `api-aws.huobi.pro` is the spot host for clients inside AWS *(documented)*.
- **Names**: `btcusdt` on spot, lower case; `BTC-USDT` a USDT-margined swap; `BTC-USD` a
  coin-margined swap; `BTC_CQ` the current quarter's coin-margined future, `BTC261016` a dated one.
- **Times**: bars are keyed by `id`, the bar's start in **seconds**; windows are in seconds;
  everything else is milliseconds.
- **Every answer is HTTP 200.** The older endpoints say `{status: "ok", ch, ts, data}` or
  `{status: "error", "err-code", "err-msg"}` — `err_code` and `err_msg` on the `-api` trees. The v3
  endpoints say `{code: 200, msg, data, ts}`.
- **A path that does not exist is HTTP 404** with the text `404 Not Found`.

### Its limits

- **Derivatives, by address** *(documented)*: 240 calls per 3 seconds across everything that is not
  market data — index, limits, settlement, open interest and the like — and 800 a second for market
  data: bars, depth, trades, premium, estimated rate and basis bars.
- **The first is reported**: `ratelimit-limit: 240`, `ratelimit-interval: 3000`,
  `ratelimit-remaining`, `ratelimit-reset`. `/api/v1/timestamp` alone reports 100 per 1,000.
- **Beyond the 240**: HTTP 200 with `{"status":"error","err_code":1032,"err_msg":"Maximum number
  of access attempts exceeded."}` and `ratelimit-remaining: 0`. The next 3-second window answers.
- **The coin-margined tree has a budget of its own, and a smaller one**: `/swap-api` reports
  `ratelimit-limit: 120` per 3,000.
- **Market-data answers carry no limit header**, and 132 calls a second for 1,500 calls were not
  refused.
- **Spot** states no figure for its public market calls and reports none; 126 calls a second for
  1,500 calls were not refused.

### How it is paged

An endpoint has one of three ways, and no other:

- **A window** — `from` and `to` in seconds, at most 2,000 bars between them, oldest first. One bar
  more is `history kline query with invalid from to`.
- **A page number** — `page_index` from 1 and `page_size`, newest first, with `total_page`,
  `current_page` and `total_size` in the answer. A `page_size` over the maximum is capped.
- **`size` alone** — the newest that many, and no way to ask for older.

### Endpoints that serve the past

**Bars, derivatives — `GET /linear-swap-ex/market/history/kline`, `/swap-ex/market/history/kline`,
`/market/history/kline` (on `api.hbdm.com`)**
- **Ask**: `contract_code` (`symbol` for the futures), `period` (`1min 5min 15min 30min 60min 4hour
  1day 1week 1mon`), and either `size` ≤ 2,000 or `from` and `to`.
- **Answer**: `data[]` of `{id, open, close, high, low, amount, vol, trade_turnover, count}`;
  coin-margined without `trade_turnover`.
- **Reaches the contract's first bar**: BTC-USDT's first month is 2020-10 and its 1-minute bars of
  2020-12 answer; BTC-USD 2020-03; BTC_CQ 2018-11.

**Funding — `GET /linear-swap-api/v1/swap_historical_funding_rate`,
`/swap-api/v1/swap_historical_funding_rate`**
- **Ask**: `contract_code`, `page_index`, `page_size` ≤ 100 (101 returns 100).
- **Answer**: `data.data[]` of `{contract_code, symbol, funding_time, funding_rate, realized_rate,
  avg_premium_index, fee_asset, …}`; `realized_rate` was `null` on every record seen.
- **Reaches the first funding**: BTC-USDT has 6,538 records, the oldest of 2020-10-21T16:00Z;
  BTC-USD has 7,168.
- **Budget**: the 240 per 3 seconds.

**Liquidation orders — `GET /linear-swap-api/v3/swap_liquidation_orders`**
- **Ask**: `contract`, `trade_type` (0 for all), `start_time`, `end_time` in milliseconds — a
  window of 2 hours at most, within the past 90 days *(documented)* — `direct`, `from_id`.
- **Answer**: `data[]` of `{query_id, contract_code, symbol, direction, offset, volume, price,
  amount, trade_turnover, created_at, business_type, pair}`.
- **Reaches 90 days**: a window 91.7 days back still answered. 50 records came back for a busy
  window; whether that is a cap *(not known)*.
- **The v1 endpoint of the same name is switched off**: "The interface is offline".

**Settlements — `GET /linear-swap-api/v1/swap_settlement_records`**: `contract_code`, `page_index`,
`page_size` (50 a page); `data.settlement_record[]` of `{contract_code, settlement_time, settlement_price,
clawback_ratio, settlement_type, …}`. **Reaches 90 days**: 270 records for BTC-USDT.

### Endpoints that hold only the newest

- **Spot bars — `GET /market/history/kline`** on `api.huobi.pro`: `symbol`, `period`, `size` ≤ 2,000
  (2,001 is refused); `{id, open, close, low, high, amount, vol, count}`, newest first. **`from` and
  `to` are ignored**: the newest bars come back. So 33 hours of `1min`, 83 days of `60min`, and
  daily bars back to 2021-04.
- **Spot trades — `GET /market/history/trade`**: `size` ≤ 2,000 batches, each
  `{id, ts, data: [{id, ts, trade-id, amount, price, direction, is-rpi-trade}]}` — hours.
- **Mark, premium, estimated rate and basis bars —
  `GET /index/market/history/linear_swap_mark_price_kline`, `linear_swap_premium_index_kline`,
  `linear_swap_estimated_rate_kline`, `linear_swap_basis`**: `contract_code`, `period`, `size` ≤
  2,000 (`basis` also `basis_price_type`). Bars as above with volumes `"0"`; basis is
  `{id, index_price, contract_price, basis, basis_rate}`. **A window without `size` is refused**
  ("size required"), **and with `size` it is ignored**: the newest bars come back.
- **Index bars — `GET /index/market/history/index`**: `symbol` (`BTC-USDT`, `BTC-USD`), `period`,
  `size` ≤ 2,000; `{id, open, close, high, low, amount, vol, count}`. The newest only, a window
  ignored. The coin-margined `swap_mark_price_kline` likewise.
- **Swap trades — `GET /linear-swap-ex/market/history/trade`**: `contract_code`, `size` ≤ 2,000
  batches, each `{id, ts, data: [{id, ts, price, amount, quantity, trade_turnover, direction}]}` —
  under five hours of BTC-USDT.
- **Open interest — `GET /linear-swap-api/v1/swap_his_open_interest`**: `contract_code`, `period`
  (`60min 4hour 12hour 1day`), `size` ≤ 200, `amount_type`; `data.tick[]` of `{ts, volume, value,
  amount_type}`. 200 hours, or 185 days at `1day`.
- **Elite ratios — `GET /linear-swap-api/v1/swap_elite_account_ratio`,
  `swap_elite_position_ratio`**: `contract_code`, `period`; `data.list[]` of `{ts, buy_ratio,
  sell_ratio, locked_ratio}`. 30 points.
- **Insurance fund — `swap_insurance_fund`**: switched off, "Function suspended".

### The listings

Four endpoints on two hosts, because htx files its markets separately: spot on the exchange API,
and each derivative family on its own service of `api.hbdm.com`.

| market | endpoint | htx answers | `historical_data/` spells | checked |
|---|---|---|---|---|
| spot | `api.huobi.pro/v2/settings/common/symbols` | `btcusdt`, with `bc` and `qc` | `BTC-USDT` | 609 of 609 |
| dated futures | `api.hbdm.com/api/v1/contract_contract_info` | `BTC` and `20260828` | `BTC-USD-260828` | 8 of 8 |
| coin swap | `api.hbdm.com/swap-api/v1/swap_contract_info` | `BTC-USD` | `BTC-USD-PERP` | |
| linear swap | `api.hbdm.com/linear-swap-api/v1/swap_contract_info` | `BTC-USDT` | `BTC-USDT-PERP` | 301 of 303, the two missing listed that day |

**Spot's base and quote are read, not parsed.** `btcusdt` does not say where the base ends; `bc` and
`qc` do. A dated contract's delivery day likewise comes from its own field.

**Only spot states an ending.** It returns 1,547 `offline` symbols beside 609 `online`. The
derivative endpoints answer with what is trading and nothing else, so there a symbol leaving the
list is the only ending stated. A `suspend` is a halt, not an ending.

**Under `linear-swap` a dated contract is told by its expiry.** Every symbol there ending in six
digits is dash-separated and parses as a `YYMMDD` expiry, and no perpetual ends in digits at all.
Options are another matter: their symbols end in a strike, and a six-figure one reads as a date.

**A derivative's record** carries `contract_code`, `create_date` (`yyyymmdd`), `contract_status`,
`settlement_period`, and for dated contracts `delivery_time`.

**A delisted contract does not exist**: `LUNA-USDT` is `invalid symbol` for bars and "The perpetual
contract does not exist" for funding.

**What the listing held in 2026-10**: 382 USDT-margined contracts, with 116,947 instrument-days
since 2020-10, two fifths of them in 2026; five coin-margined swaps; eight coin-margined futures.

### Against htx's own archive

Set side by side in 2026-10:

| over REST | in the archive |
|---|---|
| spot bars and trades, the newest only | every bar and trade |
| swap bars, from the contract's first, BTC-USDT from 2020-10 | the same history |
| mark and index bars, the last 2,000 | mark and index klines |
| funding, from the contract's first | from 2026-02-01 only |
| premium, estimated rate and basis bars; liquidations; open interest; elite ratios; settlements | none |

### Its documentation

The static pages at `huobiapi.github.io/docs` are the older site; the current portal is a script.
The static pages state limits and parameters in full. **Where the API differs from them**: the two
endpoints switched off; `/api/v1/timestamp` reports 100 a second where 240 per 3 seconds is stated.

### Pace, measured

4,238 calls in 2026-10, from one machine, most of them the runs at pace, with no failure but the
refusals provoked on purpose. Bars at 2,000 a page came at 1.4 pages a second on one connection,
p50 689 ms.

## Open questions

- **What the current documentation portal states.** It is a script; the older static pages were
  read.
- **What limits market data.** 132 calls a second on derivatives and 126 on spot were not refused.
- **Where the REST API's servers are.** Only the delay behind its edge is known.
