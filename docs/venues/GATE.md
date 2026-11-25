# Gate

Gate as a source of market data: what it publishes, where, and how it behaves when asked.

## Archives

What gate's published archives contain, established from the files themselves. Anything not
established is marked as such. Listings dated 2026-11-25 were read from the bucket that day.

### Publication

From the files' own `Last-Modified`, measured on 2026-09-25 over the 701,749 files dated 2026-09-15
to 21, a file appears this many hours after the start of the day it is dated:

| p50 | p99 |
|---|---|
| 14.8 h | 28.0 h |

The spread is the hourly files: an hour's books appear within the next two hours, a day's file the
next morning. Read on 2026-11-25:

| file | appeared |
|---|---|
| `spot/orderbooks/` hour H of `BTC_USDT` | about H + 1 h 45 min |
| `delivery_usdt/orderbooks/` hour H | about H + 1 h 25 min |
| `spot_index/` and `options_ticker/` instant T | within 20 seconds of T |
| `spot/candlesticks_1m/` day D | 03:02 UTC on D + 1 |
| `tradfi/candlesticks_1m/` day D | 04:00 UTC on D + 1 |
| month files of 2026-10: `futures_usdt` 1h bars, spot 1h bars, `futures_usdt/trades`, `spot/deals` | 2026-11-01 at 02:01, 03:03, 04:30 and 04:48 UTC |
| 7d bars of 2026-09 | 2026-10-07 at 01:00 UTC |

No 7d or `1w` file for 2026-10 had appeared by 2026-11-25, in any market.

### The bucket is listable, but only at its origin

`gateio-public-data` is an ordinary S3 bucket. It honours `prefix`, `delimiter`, `max-keys`
and `continuation-token`, and carries `Size`, `ETag` and `LastModified` on every key.

```
https://s3-ap-northeast-1.amazonaws.com/gateio-public-data
```

**The same bucket through `download.gatedata.org` is not listable.** That host is CloudFront and it
serves a cached `ListBucketResult` for the bucket root, discarding the query string:

| sent | echoed back |
|---|---|
| `?prefix=spot/deals/` (raw or percent-encoded) | `<Prefix></Prefix>` |
| `?marker=spot/deals/202001` | `<Marker></Marker>` |
| `?delimiter=/`, `?list-type=2`, `?max-keys=8` | `<MaxKeys>1000</MaxKeys>`, no delimiter applied |

Every request returns the identical first 1,000 keys — all `delivery_usdt/orderbooks/202305/…` —
with `IsTruncated` true and no `NextMarker`. Byte-identical whatever is asked, cache-buster
included; `age` and `x-cache: Hit from cloudfront` are what give it away.

**Both hosts serve the same files**, byte for byte (MD5 = ETag on both); only the bucket answers the
listing API. Measured 2026-09-29, the bucket answered HEAD at up to 1,781/s and LIST at up to
1,710/s, flat at ~270 ms, without a single throttling answer — the ceiling was the client's. From a
remote machine the same requests reached about 1,190 a second.

Gate's public API carries each contract's `launch_time` / `create_time`
([REST](#endpoints-and-how-far-back-each-goes)). The download portal's own symbol list sits in a
Next.js chunk (`/cdn/fe/_next/static/chunks/pages/developer/historical_quotes-*.js`).

### The trees, and which are dead

Thirteen top-level trees. Seven are gate.com's live market data — `spot/`, `futures_usdt/`,
`futures_btc/`, `tradfi/`, `delivery_usdt/`, `spot_index/` and `options_ticker/`; the other six are
not market data, not gate.com's, or stopped.

| tree | span | |
|---|---|---|
| `spot/` `futures_usdt/` `futures_btc/` `tradfi/` | to the present | live |
| `delivery_usdt/orderbooks/` | 202305 → | live: dated-futures books, the tree's only dataset |
| `spot_index/` | 202312 → | live: venue-wide index snapshots, hourly |
| `options_ticker/` | 202509 → | live: venue-wide options ticker, per minute |
| `v2/` | 202211–202212 | ended: two months of `spot/`, `futures_usdt/` and `futures_btc/`. Its `futures_btc/market_price/` exists nowhere else |
| `hk/spot/` | 202305 → 202403 | foreign: Gate.HK, closed. Carries `orders/`, unique to it |
| `malta/spot/` | 202301 → 202402 | foreign: a regional book |
| `future_usdt/trades/` | 202203 → 202211 | ended: singular, beside the live `futures_usdt/` |
| `futures_usd/orderbooks/` | 202208 → 202212 | ended |
| `gatepay/` | — | not market data: two spreadsheet templates |

`hk/` and `malta/` are **different order books**: their `BTC_USDT` is not gate.com's. Gate OTC Malta
launched 2024-11 and is not what `malta/` held — that tree had stopped nine months earlier.

**Everything under `futures_btc/` is BTC-settled, and its instruments are all `*_USD`.** A file there
under any other name is not the tree's own — see
[Files under the BTC tree that are not its own](#files-under-the-btc-tree-that-are-not-its-own).

#### Keys filed at the wrong depth

What sits directly below a tree is a month for `spot_index/` and `options_ticker/`, and a dataset
name for every other tree. Either in the other's place is a misfiling:

```
spot/201905/            419 keys      a bare month where a dataset name belongs
futures_usdt/202107/    130 keys
futures_btc/202107/      22 keys
spot_index/slice_index_<epoch>   179 keys   a file where a month belongs
```

The 571 high ones match a canonical twin's size **to the byte**, with a different ETag and an earlier
`LastModified` — `spot/201905/` is `spot/deals/201905/`, `futures_btc/202107/` is
`futures_btc/trades/202107/`, and `futures_usdt/202107/` is the 130 four-column files of
`futures_usdt/trades/202107/`, name for name and size for size, none of them a
[2021-07 spot file](#2021-07-spot-data-at-the-futures-url). Identical length with a different hash
is what recompressing gives, since gzip stamps its own header. Having no dataset segment, they name
no dataset at all.

The 179 low ones each have a twin at `spot_index/{YYYYMM}/slice_index_<epoch>` with the **same size
and same ETag** — one object served at two keys, not a re-upload.

### The portal understates the archive

The download form ([announcement](https://www.gate.com/announcements/article/21688)) offers one
floor per business type, not per symbol: filled orders and candlesticks from **2023-01**, market
depth and depth snapshot from **2021-08**, TradFi from **2024-01**.

The bucket's own floors, its first month directory per dataset (2026-11-25):

| dataset | from |
|---|---|
| `spot/candlesticks_1d/` | 201701 |
| `spot/candlesticks_1m/`, `_5m/` | 201709 |
| `spot/deals/` | 201801 — `BTC_USDT` has a 201801 file |
| `futures_btc/trades/` | 201812 |
| `futures_usdt/trades/`, candlesticks, funding, mark prices | 201911 |
| `spot/orderbooks/`, `futures_usdt/orderbooks/`, `futures_btc/orderbooks/` | 202107 — from 2021-07-12 on futures and 2021-07-13 on spot |
| `*/orderbooks_slice/` | 202107 — from 2021-07-26, hour 03 |
| `tradfi/candlesticks_1d/` | 202107; the other TradFi intervals from 202401, `10s` from 202603 |

A download form is evidence that data exists from a date, never evidence that nothing older is
served.

### Layout

```
spot/deals/<YYYYMM>/<SYMBOL>-<YYYYMM>.csv.gz                   spot trades
futures_usdt/trades/<YYYYMM>/<SYMBOL>-<YYYYMM>.csv.gz          USDT-margined perp trades
futures_btc/trades/…                                           BTC-margined perp trades
<market>/candlesticks_<interval>/<YYYYMM>/…                    klines, a file per month or per day
<market>/orderbooks/<YYYYMM>/<SYMBOL>-<YYYYMMDDHH>.csv.gz      books, a file per hour
<market>/orderbooks_slice/<YYYYMM>/<SYMBOL>-<YYYYMMDDHH>.gz    book snapshots, a file per hour
spot_index/<YYYYMM>/slice_index_<epoch>                        every spot pair's index, an hour apart
options_ticker/<YYYYMM>/slice_options_ticker_<epoch>           every option's ticker, a minute apart
```

Files are headerless, so every file is read positionally. They are `.csv.gz`, plain `.gz` for depth
snapshots, and no extension at all for the two trees named by an instant, whose `<epoch>` is Unix
seconds — consecutive files sit 3,600 seconds apart in `spot_index/` and 60 in `options_ticker/`.

**A day of books is 24 hourly files** in the month's directory. Over 40 hourly books measured, 753 of
769 middle days carried all 24 hours and 767 carried hour 00. **An instrument's first day starts at
the hour it was listed**: none of those forty first days carried hour 00. Read on 2026-11-25 over the
54 contracts of `delivery_usdt/orderbooks/202611/`, no first day carried hour 00, and 343 of 359
middle days carried all 24 hours.

Uncompressed `.csv` keys sit among the early files: in `spot/candlesticks_1m/201802/`, 99 files
named for 2018-02-01 alone beside 482 month files; `futures_btc/trades/202004/ADA_USD-202004.csv`
beside its `.csv.gz`; and two zero-byte ones in `futures_usdt/trades/202107/`.

### The two depth products are different data

"Market depth" and "Depth snapshot" are not two names for one thing:

| | path | fields |
|---|---|---|
| Market depth | `orderbooks` | `timestamp, side, action, price, amount, begin_id, merged` — an event stream, where `set` re-benchmarks a level and `take`/`make` adjust it |
| Depth snapshot | `orderbooks_slice` | `asks[price, qty], bids[price, qty], update, current, id` — whole book states |

Both are hourly, 24 files a day. The snapshot ships `.gz` JSON rows, the delta stream a `.csv.gz`.

The delta stream records full depth once, then a change record every 100 ms, with same-price changes
inside the window merged into one row. Its depth is whatever the book has: between 45 and 2,204
levels a side across sampled symbols. The snapshot is twenty levels a side, one book a row, about a
second apart.

**What a delta row means, measured.** An hour's file opens with the whole book as `set` rows sharing
one `begin_id`; `make` and `take` rows follow, and each carries an amount that is added to its level
or taken from it, not the level's new size. Rebuilding a book that way from a file never drives a
level below zero and never crosses the sides (`BTC_USD`, 2026-06-01 21h, 18,538 rows; `BTC_USDT`
spot, 2021-08-01 00h, 497,333 rows). `timestamp` is in tenths of a second and `begin_id` rises
through the file, so the id is what orders the rows inside one tenth.

**A `delivery_usdt` file holds `set` rows only**, with `begin_id` `0`: the largest of 2026-11,
`ETH_USDT_20261204-2026112009.csv.gz`, is 98 `set` rows and nothing else.

**Spot names the side and futures sign the amount.** A spot row is the seven fields above, and `side`
is `1` for an ask and `2` for a bid — in a file's first image every `2` sits below every `1`. A
futures row has six fields and no side, `timestamp, action, price, size, begin_id, merged`, and its
`size` is negative for an ask.

**The snapshot's shape differs by market and by year.** A spot level is `[price, qty]`; a futures level
is an object, `{"p": price, "s": size}`. On spot, `current` and `update` are seconds with a fraction
in the 2021 files (`1627344002.052378`) and whole milliseconds by 2023 (`1685577601849`). On futures
they are seconds with a millisecond fraction in every year sampled (2021, 2023, 2026), and the
2026-11 files add `current_us` and `update_us` in microseconds. A coin-margined file can hold nothing
but records with empty sides. Gate documents `id` as present only for data generated after
2023-04-26; the 2021-07 files sampled, spot and futures, carry it too.

**The snapshot covers two pairs per market**: `BTC_USDT` and `ETH_USDT`, or `BTC_USD` and `ETH_USD`
coin-margined. Gate documents it, its contract dropdown confirms it, and the 2026-11 directories of
all three trees hold those two and nothing else.

### Candlesticks: intervals and cadence differ per market

| market | intervals | file per |
|---|---|---|
| spot | 30s, 1m, 5m | **day** from 2024-04 — `BTC_USDT-20260701.csv.gz`; month up to 2024-03, and 2024-05 holds both |
| spot | 1h, 4h, 1d, 7d | month |
| `futures_usdt`, `futures_btc` | 10s, 1m, 5m, 1h, 4h, 1d, 7d | month |
| `tradfi` | 10s, 1m, 15m | month, and from 2026-03 also a file per trading day in the same directory |
| `tradfi` | 1h, 4h, 1d, 1w | month |

Gate's page at `gate.com/developer/historical_quotes` documents these intervals, less TradFi's `1w`,
and states one recipe:

```
$(biz)/$(type)/$(year)$(month)/$(market)-$(year)$(month).csv.gz
```

**A monthly URL for a daily-generated interval answers `NoSuchKey`.** Gate's own form builds the
monthly URL for spot's short intervals and links to a file that does not exist.

The page states that 7d months are generated on the **7th** of the following month and everything
else on the 1st, so a freshly turned month is incomplete for weekly bars; for when they actually
appeared, see [Publication](#publication). K-lines are derived from trades, so a period
with no trade has no row rather than an empty one.

**Column order** is `ts, volume, close, high, low, open` on spot and futures — open and close are the
reverse of the obvious reading. Nothing about a single bar reveals it; bar alignment does. Across
intervals, bars sharing a start share an open and differ in close; along one interval, each bar's
open is the previous bar's close (`futures_usdt` `BTC_USDT` 1d, 2026-10: 84,831 closes 10-01 and
opens 10-02). TradFi bars have no volume: `ts, close, high, low, open`.

**`volume` is the sum of the trades' sizes.** On spot that is the base leg: summing `spot/deals`
reproduces the candle on every hour of `BTS_USDT` 201812 to six decimal places, and on every day of
`NS_USDT` 2026-10 exactly; the quote sum misses by a factor of the price. On futures it is in the
trades' unit, contracts: the absolute sizes of `futures_usdt/trades` reproduce every day of
`AMGN_USDT` 2026-10 exactly.

### TradFi is candlesticks only

`tradfi/candlesticks_1h/202605/XAUUSD-202605.csv.gz` serves 200. It is the one market with no
trades, no depth and no funding.

It is one flat namespace of equities, leveraged ETFs, FX pairs, indices, metals and commodities, so
`AAPL`, `AUDCAD` and `GER40` are siblings. The 2026-10 hourly directory holds 686 symbols.

#### Its `status` is a market session, not a listing

`/api/v4/tradfi/symbols` reports `status: open | closed` per symbol, meaning **the exchange
session**. These are tokenised equities and ETFs on US market hours; the payload carries
`open_time`, `close_time` and `next_open_time` beside the status. Measured on a Monday at 16:18 UTC:
646 open, 34 closed, of 680. Outside 14:30–21:00 UTC — seventeen and a half hours of every weekday, every
weekend, every market holiday — **all of them report `closed`**. A symbol is listed while it appears in that
list.

Gate's other markets carry listing state of their own: when asked, spot's `trade_status` was 2,232
tradable against 2 untradable, and `in_delisting` was false for all 981 contracts.

### A dated future's file carries two dates

`delivery_usdt` names a contract by its expiry, so a file there has a date inside the symbol and
another after it: `ADA_USDT_20260605-2026060100.csv.gz` is the 2026-06-05 expiry, hour 00 of
2026-06-01. The period is whatever follows the last `-`.

### The files named by an instant hold a line an instrument

`spot_index/` and `options_ticker/` files are plain text with no header and no extension. Each line is
one instrument, its values parted by single blanks with one trailing; some lines begin with a blank
as well (` DOGE_USD1 0.05448 `). Nothing inside says when: the instant is the file's name.

A spot index line is `<pair> <price>`.

An option ticker line is the option's name and twelve values with no names:

```
BTC_USDT-20260603-80000-C 9.2 0.4491 701 4 0.4069 200 17 0.4875 0.01039 0.00001 -15.60348 1.62129
BTC_USDT-20260603-80000-P 6430.4 0.4491 200 6162 0 200 6478 0.5931 -0.9896 0.00001 -15.60287 1.62119
```

Read from the numbers, in order: mark price, mark implied volatility; bid size, bid price, bid
implied volatility; ask size, ask price, ask implied volatility; delta, gamma, theta, vega. The
second value is the same for the call and the put of one strike. The fourth and seventh bracket the
first, and the fifth and eighth bracket the second. The ninth is negative on puts and positive on
calls, and the eleventh is negative on both. Gate documents none of this for the files; its API
names the same quantities.

### 2022-11-30 23:00: one hour filed under the wrong month

**Gate wrote the last hour of November 2022 into December's directory.** In all three book trees,
`<tree>/orderbooks/202212/` holds keys stamped `2022113023`:

| tree | keys | hour |
|---|---|---|
| `spot/orderbooks/202212/` | 2,897 | 23, and only 23 |
| `futures_usdt/orderbooks/202212/` | 249 | 23 |
| `futures_btc/orderbooks/202212/` | 6 | 23 |

**They are the only copy of that hour.** The properly filed `<tree>/orderbooks/202211/` stops at hour
22 for that day in every one of the three trees, for every instrument that has a file there. The
directory month and the file's month disagree:

```
spot/orderbooks/202212/BTC_USDT-2022113023.csv.gz
```

The same day has two more gaps on spot: hours 08 and 09 of 2022-11-30 exist for no pair, in either
directory.

### Misfiled months, beyond the 2022 books hour

**Gate files a period into the wrong month's directory more than once, and there the directory and
the filename name different months.** Checked against the archive rather than assumed:

| where | what it holds | verdict |
|---|---|---|
| `spot/candlesticks_{30s,1m,5m}/2024{07..12}/` | the last day of the previous month | 61,884 of 62,208 have a correctly filed twin of identical size **and** ETag |
| `spot/deals/202108/` | July 2021, truncated: 1,638 files | `ADA_USDT` is 1,591 lines against the proper file's 931,801, sharing its opening rows |
| `spot/deals/202106/` | March 2020 of 23 `_USD` pairs | those are coin-margined **futures** under a spot path; `futures_btc/trades/202003/` holds every one at the same byte count |
| `futures_btc/trades/202106/` | April 2020 of 23 instruments | same size as the proper file, different ETag — recompressed, which the gzip header explains |

**324 of the 2024 klines have no correctly filed copy.** They are 108 instrument-days at three bar
lengths: the last day of each month from June to November 2024, one per directory from `202407` to
`202412`. What separates them from the 61,884 duplicates is whether the same file exists in the right
directory, which nothing in the path says. The misfiled copy was written at about 03:02 UTC on the
1st (`spot/candlesticks_1m/202407/BTC_USDT-20240630.csv.gz`, 2024-07-01 03:02); its correctly filed
twin, where there is one, later (2024-07-10 for that one). The misfiling stopped in December 2024:
`202501/` holds no day of December.

Two more strays sit inside a correctly dated directory. `spot/candlesticks_{1m,5m,1h,4h,1d,7d}/201802/`
each hold an `s3deals/` directory of 227 keys: the same interval's bars, newest first (`ABT_ETH` 1d:
the four bars of the properly filed file). And `futures_usdt/trades/202106/` and
`futures_btc/trades/202106/` carry day files for 2021-06-01 and 2021-06-02 next to each instrument's
`-202106` file.

### Files under the BTC tree that are not its own

Every file under `futures_btc/` whose instrument is not a `*_USD` is a copy, a fragment or nothing.
Checked file by file against the archive on 2026-10-01 and 2026-10-03; the `trades/202203/` counts
were read on 2026-11-25:

| where | what it holds | verdict |
|---|---|---|
| `trades/202203/`, 2,511 `*_USDT`, `*_ETH`, `*_BTC` | **spot weekly candles**, written 2022-04-03: a week from February and a partial last week — 2,502 of them; and 5 spot trade files | every week is at `spot/candlesticks_7d/`, republished complete in 2024; each trade file is the size of the `spot/deals/202203/` file, and row for row the same |
| `trades/202208/`, 144 | about five minutes of futures trades from 2022-08-05 | every row is inside the month's `futures_usdt/trades/` file |
| `funding_updates/`, `mark_prices/` of `201911`, 4 | the first minutes of 2019-11-20 for `EOS_USDT` and `ETH_USDT` | missing from the properly filed month: a month split across two files |
| `funding_applies/` from `202410`, `dummy` | an instrument named `dummy`, applying a funding rate of exactly zero about hourly | a placeholder |

### Two trade shapes, not interchangeable

```
futures   ts, id, price, size            4 columns; size is SIGNED — the sign is the side
spot      ts, id, price, size, side      5 columns; size unsigned, side is 1=buy 2=sell
```

Both established from rows, not documentation. Futures size is negative on roughly half of all
trades (162,517 of 314,987 in one sampled month); spot size is never negative, and `1` is a buy —
settled by price impact over 7.5 M `BTC_USDT` trades.

They differ by exactly one column, so reading a spot file with the futures map still "works": it
takes the first four columns and puts the unsigned spot size where the signed futures size belongs,
and every trade reads as a buy because the side comes from a sign that is never negative.

### 2021-07: spot data at the futures URL

**For 2021-07, `futures_usdt/trades/202107/` serves spot files.** Read on 2026-11-25, the month holds
1,643 keys: 130 four-column futures files, written 2022-05-09; 1,468 five-column spot files, written
2021-08-11; and 45 empty or near-empty ones. Each spot file there is the opening lines of the spot
file for the same symbol and month — `FIDA_USDT` is the first 3,544 lines of a 40,577-line file — and
re-fetching returns the same bytes (`md5 1fb163c4da` for `FIDA_USDT`), so gate publishes this;
nothing was mangled in transit.

Every other month of `futures_usdt/trades/` read the same day — 29,212 month files — has four
columns.

What it means for each of the 1,468 symbols, against `futures_usdt/trades/` in every other month:

| | |
|---|---|
| no perp file in any other month | 1,284 |
| perp files only from a later month — the market had not launched | 183 |
| `SUN_USDT` — an established perp, trading 2020-12 → 2021-06 | 1 |

So for all but one, gate answered a URL for a futures market that did not exist yet with the spot
file instead of nothing. `SUN_USDT` is the only real gap.

### Known gap: `SUN_USDT`, 2021-07 to 2021-09

The archive cannot supply it. Asked of gate directly:

| month | gate's answer | |
|---|---|---|
| 2021-06 | 200, 533,952 B | real data |
| 2021-07 | 200, 84,860 B | the spot copy |
| **2021-08** | **404** | gate publishes nothing |
| **2021-09** | **404** | gate publishes nothing |
| 2021-10 | 200, 1,013,625 B | real data |

`SUN_USDT` traded as a perp throughout — its files run from 2020-12 to the present either side — so
these are real trades absent from the archive.

**Unverified:** whether other gate perp symbols have month gaps of this kind.

### Smaller facts

**Truncated final lines.** The 2021-07 spot files at the futures URL are cut mid-row, ending inside a
field (`1`, `16275`, `1627570`, or a complete timestamp with the rest missing). Their fields are
parted by a comma and a blank. **Unverified:** whether truncation is general to gate or specific to
these files.

**Zero-byte files.** `futures_usdt/candlesticks_10s/202107/123` and
`futures_btc/mark_prices/202107/hello/123`, uploaded four minutes apart on 2021-08-11, and
`futures_usdt/trades/202107/CELR_ETH-202107.csv` and `MPH_ETH-202107.csv` are 0 bytes. A zero-byte
file is not a valid gzip.

**Timestamps** in trade files are seconds with a fractional part (`1627775982.133299`), so
microsecond resolution; candlesticks carry whole seconds, books tenths of a second.

## REST

**How to read this section.** A statement with no mark is what the API answered when it was asked,
in October 2026. *(documented)* marks what gate's documentation or its SDK's reference states and
was not tried. *(not known)* marks what neither settled. Nothing here is inferred from another
venue.

### The API

**One API**: `https://api.gateio.ws/api/v4`, a family per path — `/spot`, `/futures/{settle}`
(`usdt`, `btc`), `/delivery/{settle}`, `/options`.

- **`fx-api.gateio.ws` answers the futures too** *(documented)*.
- **No edge in front of it**: the host resolves to addresses in AWS `ap-northeast-1`, 27 of them
  seen.
- **Times are seconds** in requests and in most answers; trades also carry milliseconds
  (`create_time_ms`).
- **A successful answer is the data itself**, a bare JSON array or object.
- **An error is HTTP 400 with `{label, message}`.** Seen: `INVALID_PARAM_VALUE` (a `limit` over the
  maximum, a window too old), `MISSING_REQUIRED_HEADER` (an endpoint that wants a signature),
  and on 429 `TOO_MANY_REQUESTS`.
- **Futures answers are not compressed**, whatever `Accept-Encoding` asks; spot's are gzip. A page
  of 2,000 statistics is 1.24 MB on the wire.

### Its limits

- **200 calls per 10 seconds for each endpoint, by address** *(documented: "All public endpoints —
  200r/10s per endpoint — IP")*.
- **Every answer counts it down**: `x-gate-ratelimit-limit: 200`,
  `x-gate-ratelimit-requests-remain`, `x-gate-ratelimit-reset-timestamp` (seconds). Also
  `x-in-time` and `x-out-time`, in microseconds.
- **Beyond it**: the 200th call to an endpoint inside ten seconds is the last; the next is HTTP 429,
  `{"label":"TOO_MANY_REQUESTS","message":"Request Rate Limit Exceeded (003)"}`, with zero remaining.
  Two seconds later it answered again.
- **The budget is the endpoint's, whatever is asked of it**: with `/spot/candlesticks` refused for
  one pair it was refused for another, while `/spot/trades` and `/futures/usdt/candlesticks` answered
  with 199 remaining.

### How it is paged

- **By a window**: `from` and `to`, in seconds. Bars and statistics come oldest first; trades and
  liquidations newest first.
- **`limit` and a window exclude each other on bars** *(documented)*: `limit` alone gives the newest
  bars.
- **A `limit` over the maximum is refused**, 400 — 1,001 on spot bars and on funding.
- **Listings page by `limit` and `offset`**; `limit` is at most 100 on `contracts` ("invalid limit,
  must in (0, 100]").

### Endpoints, and how far back each goes

**Nearly every one of them is a window.** The index bars of the option underlyings and the option
settlements are the exceptions.

**Index bars of the option underlyings — `GET /options/underlying/candlesticks`**
- **Ask**: `underlying` (`BTC_USDT`; the twelve there are come from `GET /options/underlyings`),
  `interval`, `from`, `to`, or `limit`.
- **Answer**: `{t, o, h, l, c}`, oldest first.
- **No 10,000-point limit here**: `1m` bars of BTC_USDT answer 1,600 days back (2022-05) and not
  1,700; ETH_USDT has none in 2022-08. A window of 2,001 minutes returned 2,001 bars.
- **With `limit` alone it returned 31 daily bars** for a `limit` of 1,000.

**Bars — `GET /spot/candlesticks`**
- **Ask**: `currency_pair`, `interval` (`1s 10s 30s 1m 5m 15m 30m 1h 4h 8h 1d 7d 30d`), `from`, `to`,
  or `limit` ≤ 1,000.
- **Answer**: rows of strings `[time, quoteVolume, close, high, low, open, baseVolume, closed]`.
- **Reaches 10,000 points of the interval asked**: older is 400 "Candlestick too long ago. Maximum
  10000 points ago are allowed". At `1m` that is a week; at `1d` it is everything — BTC_USDT's
  daily bars start on 2014-05-13.

**Bars — `GET /futures/{settle}/candlesticks`, `GET /delivery/{settle}/candlesticks`**
- **Ask**: `contract`, `interval`, `from`, `to`, or `limit` ≤ 2,000. `contract=mark_BTC_USDT` gives
  mark price bars, `index_BTC_USDT` index bars.
- **Answer**: `{t, o, h, l, c, v, sum}`.
- **Reaches 10,000 points**, the same refusal, for trade, mark and index bars alike.

**Premium index — `GET /futures/{settle}/premium_index`**: `contract`, `interval`, `from`, `to`, or
`limit` ≤ 1,000; `{t, o, h, l, c}`. A window answered 100 bars, `limit=1000` alone 1,000. **Reaches
180 days**: older is 400 "from time exceeds 180-day limit".

**Trades — `GET /spot/trades`**
- **Ask**: `currency_pair`, `from`, `to`, `limit` ≤ 1,000; also `last_id` with `reverse`, and `page`
  *(documented)*.
- **Answer**: `{id, create_time, create_time_ms, currency_pair, side, amount, price, sequence_id}`.
- **Reaches 30 days**: older is 400 "for public trades older than 30 days, download from historical
  data instead". The other ways of paging reach no further: `last_id=1` returned trades of seven
  days before, and `page=100` stays inside the month.

**Trades — `GET /futures/{settle}/trades`**
- **Ask**: `contract`, `from`, `to`, `limit` ≤ 1,000.
- **Answer**: `{id, contract, create_time, create_time_ms, size, price}`; `size` is signed.
- **Reaches 180 days**: 179 answers, 185 is 400 "from time exceeds 180-day limit".

**Funding — `GET /futures/{settle}/funding_rate`**
- **Ask**: `contract`, `from`, `to`, `limit` ≤ 1,000.
- **Answer**: `{t, r}`, newest first.
- **An answer holds 30 days at most**, whatever `limit` says: 90 records at 8 hours, starting at
  `from`.
- **Reaches 180 days**: `from` 179 days back answers, 181 is refused.

**Contract statistics — `GET /futures/{settle}/contract_stats`**
- **Ask**: `contract`, `interval` (`5m` … `1d`), `from`, `limit` ≤ 2,000.
- **Answer**, oldest first: `{time, open_interest, open_interest_usd, mark_price, last_funding_rate,
  lsr_taker, lsr_account, long_users, short_users, long_taker_size, short_taker_size, top_lsr_account,
  top_lsr_size, top_long_account, top_short_account, top_long_size, top_short_size, long_liq_size,
  short_liq_size, long_liq_amount, short_liq_amount, long_liq_usd, short_liq_usd, long_liq_usd_new,
  short_liq_usd_new}` — about 620 bytes.
- **Reaches 180 days**: `from` 179 days back answers, 181 is refused.

**Liquidation orders — `GET /futures/{settle}/liq_orders`**
- **Ask**: `contract` (optional), `from`, `to` — at most 3,600 seconds apart *(documented)* —
  `limit` ≤ 1,000.
- **Answer**, newest first: `{contract, size, order_size, fill_price, order_price, left, time}`.
- **Without `contract` it returns the venue's**, every contract together.
- **A window returns 1,000 at most**, and an hour can hold more: one did.
- **Reaches about 11 months**: 330 days back answers, 350 is empty.

**Insurance — `GET /futures/{settle}/insurance`, `/delivery/{settle}/insurance`,
`/spot/insurance_history`**: a balance a day — `{t, b}`; 31 came back on futures for a `limit` of
1,000, 100 on delivery. Spot's takes `business`, `currency`, `from`, `to`, `limit` ≤ 30 and answers
`{currency, balance, time}`.

**Option settlements — `GET /options/settlements`**: `underlying`, `from`, `to`, `limit` ≤ 1,000;
`{time, contract, strike_price, settle_price, profit, fee, …}`, newest first. **Reaches 2022-09**:
1,500 days back answers, 1,800 does not.

**Loan rates — `GET /unified/history_loan_rate`**: `currency`, `tier`, `page`, `limit` ≤ 100;
`{currency, tier, tier_up_rate, rates: [{time, rate}]}`, one an hour, `time` in milliseconds. Page
200 answers (2024-06).

**The listings**
- `GET /futures/{settle}/contracts`: `{name, type, create_time, launch_time, funding_interval,
  in_delisting, status, delisting_time, delisted_time, …}`. Listed contracts only; none carried a
  delisting time when asked.
- `GET /spot/currency_pairs`: `{id, base, quote, trade_status, buy_start, sell_start, …}`, all in
  one answer.
- `GET /delivery/{settle}/contracts`: `{name, expire_time, cycle, …}`.

### Endpoints that do not, or could not be read

- **`/futures/{settle}/index_constituents/{index}`**: an index's exchanges, prices and weights now.
- **`/delivery/{settle}/settlements`**: asks for a signature ("Missing required header:
  Timestamp").
- **`/options/candlesticks`, `/options/trades`**: empty for the one listed contract tried; how far
  back they go *(not known)*.
- **What needs no signature**, by the SDK's reference: 10 endpoints on spot, 14 on futures, 8 on
  delivery, 12 on options, and the lists and rates of the lending products.
