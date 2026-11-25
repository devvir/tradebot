# Stocker partitions

The series map, venue by venue: which entry of `src/schema/series.ts` reads each format, how its
columns become the canonical table, and which series options it declares. The canonical tables and
their columns are in [STOCKER.md](STOCKER.md#canonical-tables); the machinery every format shares —
unit inference, `TRY_CAST`, empty and malformed files, spill — is the rest of
[STOCKER.md](STOCKER.md). What a venue's files hold, and the evidence for each reading below, is the
venue's own doc, linked as **why**.

A series knows a partition's attributes — venue, market, dataset, variant, bundle, grain, month —
each file's instrument and the files' contents; nothing else is an input. Where a format depends on
the instrument's margining, that is read from the venue's symbol (`schema/margin.ts`), and the same
answer fills the canonical `margin` column.

Every entry is written from a decoded file of its format, except those marked **unverified — no
file decoded**, which are mapped without a file of that format to check against.

**How to read the tables.** One row per format, and one row per era where a dataset's format
changed. `—` means the file has no such column, and the canonical field is NULL.

| Column | Meaning |
|---|---|
| Hdr | `yes` mapped by column name · `no` positional, every column declared in order · `grew` positional, because a header appeared partway through history and drops as a row whose timestamp does not parse |
| Sym | whether rows name the instrument. Where they do and a file can hold several, the series names the column (`instrument`) and the rows are split by it |
| ts | the timestamp as written; its unit is inferred per value ([STOCKER.md](STOCKER.md#time)) |
| Options | series options beyond the mapping: `margin`, `from`/`until` (the era), `spill`, `repeatsRows`, `utcOffsetHours`, `instrument` |

## Overview

### trades

Into [`trades`](STOCKER.md#canonical-tables). `side` is the taker's, lowercased. Trades the catalog
gives no variant are `aggregated=false`; binance's aggregated trades are `aggregated=true`.

| Venue | Market | Variant · era | File | Hdr | Sym | ts | Side | Size | Options · notes |
|---|---|---|---|---|---|---|---|---|---|
| binance | spot | all | zip · csv | no | no | int epoch, unit inferred per value ([why](../venues/BINANCE.md#spot-timestamps-change-unit-in-2025-01)) | from `is_buyer_maker` (true → sell) | base · quote | |
| binance | perp | all | zip · csv | grew | no | int ms | from `is_buyer_maker` | base · quote | `margin: linear`; 4th column `quote_qty` |
| binance | perp | all | zip · csv | grew | no | int ms | from `is_buyer_maker` | contracts; base | `margin: inverse`; 4th column `base_qty` — **same position, opposite meaning** |
| binance | spot | aggregated | zip · csv | no | no | int epoch, unit inferred per value ([why](../venues/BINANCE.md#spot-timestamps-change-unit-in-2025-01)) | from `is_buyer_maker` | base | 8 columns |
| binance | perp | aggregated | zip · csv | grew | no | int ms | from `is_buyer_maker` | base | `margin: linear`; 7 columns |
| binance | perp | aggregated | zip · csv | grew | no | int ms | from `is_buyer_maker` | contracts, no leg | `margin: inverse`; 7 columns |
| bybit | perp | all | csv.gz | yes | yes | float s | `Buy`/`Sell` | base | `margin: linear` |
| bybit | perp | all | csv.gz | yes | yes | float s | `Buy`/`Sell` | **quote** | `margin: inverse` |
| bybit | spot | all | csv.gz | yes | no | int ms | `buy`/`sell` | base | |
| bybit | option | all | zip · csv | yes | yes | int ms | `direction` | as published, no leg | `instrument: instrument_name` |
| kucoin | spot | all | zip · csv | yes | no | int ms | `BUY`/`SELL` | base | |
| kucoin | perp | all | zip · csv | yes | no | int ms | `BUY`/`SELL` | contracts, no leg | |
| htx | spot | before 2026-02 | zip · csv | no | no | int ms | `buy`/`sell` | base | `until: 2026-02`, `spill: back`; 5 columns |
| htx | perp, future | before 2026-02 | zip · csv | no | no | int ms | `buy`/`sell` | contracts; base | `margin: inverse`, `until`, `spill: back`; 6 columns |
| htx | perp, future | before 2026-02 | zip · csv | no | no | int ms | `buy`/`sell` | contracts; base · quote | `margin: linear`, `until`, `spill: back`; 7 columns |
| htx | option | before 2026-02 | zip · csv | no | no | int ms | `buy`/`sell` | contracts; base · quote | `until`, `spill: back`; the linear contract's 7 columns |
| htx | spot | from 2026-02 | zip · csv | yes | yes | int ms | `buy`/`sell` | base | `from: 2026-02`, `spill: back` |
| htx | perp, future | from 2026-02 | zip · csv | yes | yes | int ms | `buy`/`sell` | contracts, no leg | `from: 2026-02`, `spill: back` |
| gate | spot | all | csv.gz | no | no | float s | `1` buy, `2` sell | base | rows in descending time |
| gate | perp | all | csv.gz | no | no | float s | **sign of size** | `abs(size)`, no leg | a file wider than 4 columns is refused — see [gate](#gate) |
| okx | spot | all | zip · csv | yes | yes | int ms | `buy` or `BUY` | base | `instrument`, `spill: back` |
| okx | perp, future, option | all | zip · csv | yes | yes | int ms | `buy` or `BUY` | contracts, no leg | `instrument`, `spill: back`; perp 2021-10 holds each trade twice — see [okx](#okx) |
| bitget | spot, perp, future | all | zip · csv | yes | no | int ms | `buy`/`sell` | base · quote | `spill: back` |

### klines

Into [`klines`](STOCKER.md#canonical-tables). The interval is always the catalog's variant, written
as the `interval=` level, and never a column.

| Venue | Market | Era | File | Hdr | Sym | ts | Column order | Volume → `volume`, `quoteVolume` | Options · notes |
|---|---|---|---|---|---|---|---|---|---|
| binance | spot | all | zip · csv | no | no | int epoch, unit inferred per value ([why](../venues/BINANCE.md#spot-timestamps-change-unit-in-2025-01)) | OHLC | base, quote; also trades and taker buy, both legs | 12 columns |
| binance | perp | all | zip · csv | grew | no | int ms | OHLC | the same | 12 columns |
| bybit | perp (MT4) | all | csv.gz | no | no | text `2024.11.01 00:00` | OHLC | base, — | `utcOffsetHours: 3`, `spill: back` — see [bybit](#bybit) |
| kucoin | spot | all | zip · csv | yes | no | int s | O C H L, by name | `volume`, `turnover` | |
| kucoin | perp | all | zip · csv | yes | no | int ms | OHLC | `volume`, — | `1d` files fail the build — see [kucoin](#kucoin) |
| htx | spot | before 2026-02 | zip · csv | no | no | int s | **O C H L** | `amount`, `vol` | `until`, `spill: back` |
| htx | perp, future, option | before 2026-02 | zip · csv | no | no | int s | **O C H L** | `vol` (contracts), — | `until`, `spill: back` |
| htx | spot, perp, future | from 2026-02 | zip · csv | yes | yes | int s | OHLC | `vol`, `volCcyQuote` | `from`, `spill: back` |
| gate | spot, perp | all | csv.gz | no | no | int s | **`volume, close, high, low, open`** | base, — | see [gate](#gate) |
| gate | tradfi | all | csv.gz | no | no | int s | **`close, high, low, open`** | — | |
| okx | spot, perp, future, option | all | zip · csv | yes | yes | int ms | OHLC | `vol`; spot `vol_quote`, or `vol_ccy` where that holds no number; contracts `vol_quote` | `instrument`, `spill: back`, `repeatsRows` |
| bitget | spot, perp, future | all | zip · xlsx a day, csv a month | yes | no | int epoch | OHLC | `basevolume`, `usdtvolume` | `spill: back` |

### Reference prices — markPrice · indexPrice · premiumIndex

Into [`markPrice`, `indexPrice` and `premiumIndex`](STOCKER.md#canonical-tables), the table named as
the dataset. A bar fills the OHLC columns and carries the catalog's variant as `interval=`; a tick
fills `price` and has no interval.

| Venue | Dataset | Market | File | Hdr | Sym | ts | Shape | Options · notes |
|---|---|---|---|---|---|---|---|---|
| binance | mark, index, premium | perp | zip · csv | grew | no | int ms | the 12-column kline; OHLC kept | volume is 0 and `count` a sample count, so neither is read |
| bybit | premiumIndex | perp | csv.gz | yes | unverified | `start_at` | OHLC bars, by name | **unverified — no file decoded** |
| bybit | indexPrice | spot | csv.gz | yes | unverified | `start_at` | OHLC bars, by name | **unverified — no file decoded** |
| kucoin | mark, index | perp | zip · csv | yes | no | int ms | OHLC bars | |
| htx | mark, index | perp | zip · csv | no | no | int s | `ts, open, close, high, low` by position | `until: 2026-02`, `spill: back`; **unverified — no file decoded** |
| htx | mark | future | zip · csv | no | no | int s | `ts, open, close, high, low` by position | `until: 2026-02`, `spill: back`; a header line in some files drops as a row whose time does not parse |
| htx | mark, index | perp | zip · csv | yes | yes | int s | OHLC bars | `from: 2026-02`, `spill: back` |
| htx | mark | future | zip · csv | yes | yes | int s | OHLC bars | `from: 2026-02`, `spill: back` |
| gate | markPrice | perp | csv.gz | no | no | float s | ticks: `ts` and three prices | only the first is read, as `price` |
| gate | indexPrice | spot | plain text, `@` | no | yes | **the file's name** | ticks: `<symbol> <price>` a line | `instrument: name` — see [gate](#gate) |

### quotes

Into [`quotes`](STOCKER.md#canonical-tables), level 1 of a book.

| Venue | Market | File | Hdr | Sym | ts | Options · notes |
|---|---|---|---|---|---|---|
| binance | perp | zip · csv | yes | no | int ms (`transaction_time`) | `bookTicker` |
| bitget | spot, perp, future | zip · xlsx a day, csv a month | yes | no | int s | `-999999` → NULL; `spill: back` |

### funding

Into [`funding`](STOCKER.md#canonical-tables), under `kind=realised` (charged) or `kind=predicted`
(the running estimate), the catalog's variant.

| Venue | Kind | Bundle | File | Hdr | Sym | ts | Options · notes |
|---|---|---|---|---|---|---|---|
| binance | realised | instrument | zip · csv | yes | no | int ms (`calc_time`) | carries `funding_interval_hours` |
| kucoin | realised | instrument | zip · csv | yes | yes | int ms | |
| htx | realised | instrument | zip · csv | yes | yes | int ms | `from: 2026-02`, `spill: back` |
| gate | realised | instrument | csv.gz | no | no | int s | `ts, rate` |
| gate | predicted | instrument | csv.gz | no | no | int s | `ts, rate` and six columns not read |
| okx | realised | `@` daily; instrument monthly, preferred where present | zip · csv | yes | yes | int ms | `instrument`, `spill: back` — see [okx](#okx) |

### The rest

| Venue | Dataset → table | Market | File | Hdr | Sym | ts | Options · notes |
|---|---|---|---|---|---|---|---|
| binance | openInterest → `openInterest` | perp | zip · csv | yes | yes | **datetime text** | `metrics`: two of its four ratios are mapped |
| binance | liquidations → `liquidations` | perp, future | zip · csv | yes | no | int ms | `liquidationSnapshot`; `repeatsRows` |
| okx | borrowing → `borrowing` | spot | zip · csv | yes | currency | int ms | `@`, keyed by currency: `instrument: currency_name`, `spill: back` |

### orderBook · orderBookSnapshot · orderBookBands

Into the [book tables](STOCKER.md#canonical-tables), all three under `dataset=orderBook`. The catalog's
variant is the kind and the depth, both levels of the path, the kind first:
`kind=incremental/depth=400`.

| Venue | Market | Kind · depth | File | Read as | Sym | ts | `action` | `sequence` | Options · notes |
|---|---|---|---|---|---|---|---|---|---|
| okx | spot, perp, future, option | incremental · 400, 5000 | tar.gz · JSON a line | `ndjson` | yes | int ms | `snapshot` → snapshot, `update` → set | — | `instrument: instId`; levels of price 0 dropped; `orderCount` from the level's third value; **no spill** |
| htx | spot, perp, future | incremental | tar.gz · JSON a line | `ndjson` | yes, not read | int µs | `snapshot` → snapshot, `update` → set | — | `spill: back` |
| bybit | perp | incremental · 200, 500 | zip · JSON a line | `ndjson` | yes, not read | int ms | `snapshot` → snapshot, `delta` → set | `data.seq` | |
| gate | spot | incremental · full | csv.gz, an hour a part | `csv`, by position | no | float s, tenths | as published: `set`, `make`, `take` | the id | side `1` ask, `2` bid |
| gate | perp, future | incremental · full | csv.gz, an hour a part | `csv`, by position | no | float s, tenths | as published | the id | **a negative size is an ask**; the size stored is its magnitude |

| Venue | Market | Kind · depth | File | Read as | ts | `sequence` | Options · notes |
|---|---|---|---|---|---|---|---|
| gate | spot | snapshot · 20 | gz · JSON a line, an hour a part | `ndjson` | `current`: float s early, int ms later | `id` | a level `[price, size]` |
| gate | perp | snapshot · 20 | gz · JSON a line, an hour a part | `ndjson` | `current`, float s | `id` | a level `{p, s}`, stored as `[price, size]` |
| kucoin | spot, perp | snapshot · 50 | zip · JSON a line under a one-word header | `lines` | int ms (`timestamp`) | `sequence`, futures only | `repeatsRows`; rows are not in time order |
| bitget | spot, perp, future | snapshot · 500 | zip · xlsx a day, csv a month | `xlsx` or `csv`, off the file | int s | — | a side JSON text in one cell; `spill: back` |
| binance | perp | bands · 5pct | zip · csv | `csv`, by name | **datetime text** | — | `bookDepth` → `orderBookBands` |

### Options — optionTicker · optionMarkPrice · volatilityIndex

Into [`optionTicker`, `optionMarkPrice` and `volatilityIndex`](STOCKER.md#canonical-tables). In the
first two the instrument is the underlying and `option` names the contract, so a vault file is an
underlying's month.

| Venue | Dataset → table | File | Hdr | Sym | ts | Options · notes |
|---|---|---|---|---|---|---|
| binance | optionSummary (1h) → `optionTicker` | zip · csv | yes | the option | `date` + `hour`, text | `option = symbol`; fills every column |
| gate | optionTicker (ticks, `@`) → `optionTicker` | plain text, a file a minute | no | the option | **the file's name** | `instrument`: the option's name up to its first hyphen — see [gate](#gate) |
| bybit | markPrice (1m) → `optionMarkPrice` | zip · csv | yes | the option | int ms (`open_time`) | `option = instrument_name`; gamma is read from `gama` |
| binance | volatilityIndex (ticks) → `volatilityIndex` | zip · csv | yes | yes | int ms (`calc_time`) | `BVOLIndex`: `value = index_value` |

## Telling formats apart inside one partition

A partition can hold more than one format: different eras, or several shapes of one dataset filed
under one key. Each is told apart from the file, its name or the partition's attributes.

| Partition | Formats in it | Told apart by |
|---|---|---|
| binance perp trades | linear and inverse — the 4th column is quote on one, base on the other; aggregated, `qty` is base on one and contracts on the other | `margin`: inverse symbols are `<COIN>USD_<PERP or expiry>` |
| bybit perp trades | linear and inverse — `size` is base on one, quote on the other | `margin` |
| htx contract trades before 2026-02 | linear (7 columns) and inverse (6) | `margin` |
| binance spot trades, aggregated trades, klines | a timestamp unit that changes in 2025-01 ([why](../venues/BINANCE.md#spot-timestamps-change-unit-in-2025-01)) | the value — the unit is inferred per value |
| binance futures trades, aggregated trades, klines, mark, index and premium klines | headerless, then a header ([why](../venues/BINANCE.md#headers)) | positional read: the header line is a row whose timestamp does not parse |
| bybit perp, spot trades | without and with `RPI` / `rpi` | mapping by name: the extra column is never read |
| htx, every dataset | the `data/` shape before 2026-02, the `historical_data/` shape from it | `from`/`until`, on the file's month |
| bitget klines | two layouts in one month, never the same day twice | mapping by name; DuckDB folds `baseVolume` and `basevolume` into one column |
| bitget klines, quotes, books | a sheet in a day's file, text in a month's | the file itself: a sheet opens as a zip archive does |
| okx spot klines | the quote volume in `vol_ccy` early, in `vol_quote` and `vol_ccy` later | whichever holds a number |
| okx funding | the daily `@` bundle and the monthly per-instrument file | one entry reads both; the per-instrument rendering is preferred where both are on disk |

## Details

### binance

No series spills.

**trades, spot** — headerless: `id, price, qty, quote_qty, time, is_buyer_maker, is_best_match` →
`tradeId = id, price, size = baseSize = qty, quoteSize = quote_qty, ts = time, side, buyerMaker`.
`is_best_match` is dropped. `side` is `is_buyer_maker` inverted: a maker buyer means the taker sold.

**trades, perp** — `id, price, qty, <4th>, time, is_buyer_maker`, one entry per margining:

- `margin: linear` (USDⓈ-M): the 4th is `quote_qty` → `size = baseSize = qty`, `quoteSize = quote_qty`.
- `margin: inverse` (COIN-M): the 4th is `base_qty` → `size = qty` (contracts), `baseSize = base_qty`;
  `qty` is neither leg.

**trades, aggregated** — by position: the aggregate's id, price, quantity, the first and the last
trade id it stands for, time, `is_buyer_maker`, and on spot an eighth, `is_best_match` → `tradeId`,
`price`, `size` = the quantity, `ts`, `side`, `buyerMaker`, and `baseSize` = the quantity on spot and
linear; on inverse, where the quantity is contracts, no leg is filled. The two trade ids and
`is_best_match` are dropped. Written under `aggregated=true`.

**klines** and **mark, index and premium klines** — twelve columns: `open_time, open, high, low,
close, volume, close_time, quote_volume, count, taker_buy_volume, taker_buy_quote_volume, ignore`.
Klines map all but `close_time` and `ignore` (`trades = count`); the reference-price datasets map
OHLC only. Spot is headerless; the futures files grew a header, read past by position
([why](../venues/BINANCE.md#headers)).

**funding** — `calc_time, funding_interval_hours, last_funding_rate` → `ts, intervalHours, rate`.

**quotes** (`bookTicker`) — `update_id, best_bid_price, best_bid_qty, best_ask_price, best_ask_qty,
transaction_time, event_time` → `bidPrice, bidSize, askPrice, askSize`, `ts = transaction_time`.

**books, bands** (`bookDepth`) — `timestamp, percentage, depth, notional`, read by name; the variant
is `bands,5pct`. `timestamp` is datetime text (`2026-07-29 00:00:01`).

**openInterest** (`metrics`) — `create_time, symbol, sum_open_interest, sum_open_interest_value,
count_toptrader_long_short_ratio, sum_toptrader_long_short_ratio, count_long_short_ratio,
sum_taker_long_short_vol_ratio` → `openInterest = sum_open_interest, openInterestValue =
sum_open_interest_value, longShortRatio = count_long_short_ratio, takerLongShortVol =
sum_taker_long_short_vol_ratio`; the two top-trader ratios are not read. `ts = create_time`,
datetime text.

**liquidations** (`liquidationSnapshot`) — `time, side, order_type, time_in_force,
original_quantity, price, average_price, order_status, last_fill_quantity,
accumulated_fill_quantity` → `ts = time, side, price, size = original_quantity, averagePrice =
average_price, status = order_status`. One entry each for perp and future, on both margins. The
series declares `repeatsRows`, so a row the file writes twice is kept once
([why](../venues/BINANCE.md#liquidation-snapshots-write-every-row-twice)).
`original_quantity` is contracts on a coin-margined instrument and the base coin on the others; the
`margin` column says which.

**optionSummary** — `date, hour, symbol, underlying, type, strike, open, high, low, close,
volume_contracts, volume_usdt, best_bid_price, best_ask_price, best_bid_qty, best_ask_qty,
best_buy_iv, best_sell_iv, mark_price, mark_iv, delta, gamma, vega, theta, openinterest_contracts,
openinterest_usdt` → `optionTicker`, a row an option an hour: `option = symbol`, `volume =
volume_contracts`, `quoteVolume = volume_usdt`, `bidIv = best_buy_iv`, `askIv = best_sell_iv`,
`openInterest = openinterest_contracts`, `openInterestValue = openinterest_usdt`, the rest by their
names. `ts` is `date` and `hour` read together as datetime text. An empty quote, `""` or `0E-8`, is
kept as published: the first casts to NULL and the second to 0.

**volatilityIndex** (`BVOLIndex`) — `calc_time, symbol, base_asset, quote_asset, index_value` →
`value = index_value`, `ts = calc_time`.

### bybit

**trades, perp** — `timestamp, symbol, side, size, price, tickDirection, trdMatchID, grossValue,
homeNotional, foreignNotional[, RPI]` → `ts = timestamp, side, size, price, tradeId = trdMatchID`.
`size` is base on a linear contract and quote on an inverse one, so the entries split by `margin`:
`baseSize = size` on linear, `quoteSize = size` on inverse. Bybit's inverse symbols end `USD`, with
or without a futures month code.

**trades, spot** — `id, timestamp, price, volume, side[, rpi]` → `tradeId = id, ts = timestamp,
price, size = baseSize = volume, side`. `timestamp` is integer milliseconds here, where the perp files
write seconds under the same name.

**trades, option** — `trade_id, trade_seq, timestamp, instrument_name, direction, price, amount,
iv, index_price, mark_price, mark_iv` → `tradeId = trade_id, ts = timestamp, price, size = amount,
side = direction`. An underlying's file holds every option on it, so the series declares
`instrument: instrument_name` and the rows are split by it. Which leg `amount` measures is not
known, so neither `baseSize` nor `quoteSize` is filled. `iv`, `index_price`, `mark_price` and
`mark_iv` are not kept.

**klines (MT4)** — headerless `datetime, open, high, low, close, volume` → OHLCV, `ts = datetime`.
The datetime (`2024.11.01 00:00`) is local to UTC+3 with no daylight-saving switch, so the series
declares `utcOffsetHours: 3`; a month's file is then a UTC+3 month, holding the previous UTC month's
last three hours, so it also declares `spill: back`
([why](../venues/BYBIT.md#four-shapes-and-none-of-them-is-the-obvious-one)). A file also carries
the first bar of the next month's file, which is kept once
([STOCKER.md](STOCKER.md#venues-whose-periods-do-not-cut-at-utc-midnight)). The interval is the
catalog's variant (`15m` for a file named `BTCUSDT_15_…`). A month the venue published truncated is
stocked as it is. The entry carries `version: 1.0.1`.

**premiumIndex, indexPrice** — headed; `start_at` and OHLC mapped by name. **Unverified — no file
decoded.**

**books** — a record a line: `{topic, type, ts, data: {s, b, a, u, seq}, cts}`, read with
`type`, `ts` and `data` declared. `b` and `a` are `[price, size]` levels, unfolded to a row a level;
`type` `snapshot` → `snapshot` and `delta` → `set`. `sequence = data.seq`; `u` is not kept.

**markPrice, option** — `instrument_name, open_time, open, high, low, close, delta, gama, vega,
theta` → `optionMarkPrice`: `option = instrument_name`, `ts = open_time`, `gamma = gama`.

### kucoin

No series spills.

**trades** — `trade_id, trade_time, price, size, side` → `tradeId = trade_id, ts = trade_time,
price, size, side`; `baseSize = size` on spot. On perp `size` is a contract count and no leg is
filled.

**klines, spot** — `time, open, close, high, low, volume, turnover`, read by name, so the order
costs nothing: `quoteVolume = turnover`, `ts = time` in seconds.

**klines, perp** — `time, open, high, low, close, volume`, `time` in milliseconds. The `1d` files
declare six columns over rows of five, parse to one column and fail the build, which names them as
malformed ([STOCKER.md](STOCKER.md#files-a-venue-published-malformed);
[why](../venues/KUCOIN.md#futures-klines-at-1d-are-published-broken)).

**funding** — `symbol, time, fundingRate` → `rate = fundingRate`, `ts = time`. **mark, index** —
`time, open, high, low, close` → OHLC.

**books** — a JSON record a line, `{"asks": [[price, size], …], "bids": […], "timestamp": ms}`,
futures adding `sequence`, under a header line that says `data`. The `lines` format reads a line at a
time and parses each; the header, and a line cut short, parse to nothing and drop. `asks`, `bids`
and `sequence` are read off the record, `ts = timestamp`. The series declares `repeatsRows`, since
some files hold every line twice.

### htx

**Every series spills back** — books included — since a day's file is a UTC+8 day in both exports
([why](../venues/HTX.md#daily-files-are-utc8-days-not-utc-days)).

**Two eras, cut flat at 2026-02.** Every entry is bound by `until: 2026-02` (the `data/` shape) or
`from: 2026-02` (the `historical_data/` shape), on the file's month. The earlier files carry no
header and are read by position; the names below are the venue's, for what each position holds:

| Dataset | Before 2026-02, by position | Mapped | From 2026-02, by name | Mapped |
|---|---|---|---|---|
| trades, spot | `Trade ID, Trade Time, Trade Price, Volume (Base Currency), Side` | `size = baseSize` = the base volume | `instId, tradeId, px, side, size, ts` | `price = px`, `size = baseSize = size` |
| trades, contract, linear | `Trade ID, Trade Time, Trade Price, Volume (in Contracts), Volume (in Base Currency), Turnover, Side` | `size` = contracts, `baseSize` = base, `quoteSize` = turnover | `instId, tradeId, px, side, size, ts` | `price = px`, `size` (contracts) |
| trades, contract, inverse | the same without `Turnover` | `size` = contracts, `baseSize` = base | as linear | as linear |
| trades, option | the linear contract's 7 columns | as linear; the turnover is the premium paid | — | — |
| klines, spot | `timestamp, open, close, high, low, vol, amount` | `volume = amount`, `quoteVolume = vol` | `instId, open, high, low, close, vol, volCcy, volCcyQuote, ts` | `volume = vol`, `quoteVolume = volCcyQuote` |
| klines, contract | `timestamp, open, close, high, low, vol, amount` | `volume = vol` (contracts); `amount` not read | as spot | `volume = vol` (contracts), `quoteVolume = volCcyQuote` |
| mark, index | `timestamp, open, close, high, low` | OHLC | `instId, open, high, low, close, ts` | OHLC |
| funding | — | — | `instId, fundingRate, fundingTime` | `rate = fundingRate`, `ts = fundingTime` |

**On spot the volume names invert between eras**: the earlier `vol` is quote and `amount` base, the
later `vol` base and `volCcyQuote` quote
([why](../venues/HTX.md#two-archives-in-one-bucket-the-current-one-and-the-one-it-replaced)).

**A contract's kline volume is two-sided, and is stored as published.** htx counts both sides of
every trade in a contract kline's `vol` and `amount`
([why](../venues/HTX.md#a-contracts-kline-volume-counts-both-sides-of-every-trade)); nothing is
halved.

**mark, index** carry the catalog's variant as `interval=`: they are bars of the mark and index
price, not ticks. Dated futures publish a mark price and no index; before the cut some of their
files open with a header line (`id,open,close,high,low`) and others do not, and read by position the
header is a row whose time does not parse. The perpetual's earlier mark and index entries are
**unverified — no file decoded**.

**books** — okx's record, `{instId, action, ts, asks, bids}`, with a level of two values and `ts` in
microseconds: `action` `snapshot` → `snapshot`, `update` → `set`
([why](../venues/HTX.md#books-are-the-richest-published-anywhere-bar-okx)).

### gate

No series spills. Every csv file is headerless and read by position.

**trades** — two shapes that differ by one column
([why](../venues/GATE.md#two-trade-shapes-not-interchangeable)):

```
spot   ts, id, price, size, side    size unsigned; side 1 = buy, 2 = sell
perp   ts, id, price, size          size signed; the sign is the side
```

Spot maps `side` from the code and `size = baseSize = size`. Perp maps `size = abs(size)` and
`side` from the sign, negative a sell, and fills no leg.

**A perp trades file wider than four columns is refused.** Read with the perp map, a spot file would
put its unsigned size where the signed one belongs and every trade would come out a buy, so the
partition fails naming the file, as every positional series does with a file wider than it declares
([STOCKER.md](STOCKER.md#builds-share-one-engine)). The venue serves such files for 2021-07
([why](../venues/GATE.md#2021-07-spot-data-at-the-futures-url)).

**klines** — `ts, volume, close, high, low, open`: **open and close are reversed** from the obvious
reading ([why](../venues/GATE.md#smaller-facts)). `volume` is the base leg on spot as on perp.

**klines, tradfi** — `ts, close, high, low, open`: the candle above less its volume.

**markPrice** — `ts, price, ?, ?`: three prices a row, only the first identified, so the other two are
dropped. A tick: no `interval=`.

**funding** — `funding_applies` (realised): `ts, rate`. `funding_updates` (predicted): `ts, rate`
and six columns not read.

**Empty files.** Some files are zero bytes, which is not a valid gzip
([why](../venues/GATE.md#smaller-facts)). A zero-length file is empty whatever its extension and is
dropped before the read, so an instrument with nothing else has no file
([STOCKER.md](STOCKER.md#files-a-venue-published-empty)).

**books, incremental** — `ts, side, action, price, amount, id, merged` on spot, `ts, action, price,
size, id, merged` on futures; `merged` is dropped. `action` is kept as published — `set`, `make`,
`take` — and `sequence = id`, which orders the rows inside one tenth of a second. Spot maps the side
`1` → `ask`, `2` → `bid`; futures take it from the sign of the size, negative an ask, and store its
magnitude ([why](../venues/GATE.md#the-two-depth-products-are-different-data)).

**books, snapshot** — a record a line: `{id, current, update, asks, bids}`, the top 20 levels a side,
read with `id`, `current`, `asks` and `bids` declared. `ts = current`, `sequence = id`; `update` is not
kept. Spot writes a level `[price, size]`, futures `{p, s}`, which is stored as `[price, size]`.

**Files named by the moment they hold** — the spot index (`indexPrice`, an hour apart) and the option
ticker (`optionTicker`, a minute apart) are read with the `words` format: a line an instrument, its
values parted by blanks. `ts` is read from the moment the catalog keeps as the file's part,
`…|202606.part1780272000.txt` ([why](../venues/GATE.md#the-files-named-by-an-instant-hold-a-line-an-instrument)).

- **indexPrice** — `<symbol> <price>` → `price`; `instrument: name`, so the rows are split per symbol.
- **optionTicker** — the option's name and twelve values, read as: mark price, mark iv; bid size, bid
  price, bid iv; ask size, ask price, ask iv; delta, gamma, theta, vega. `option = name`; the rows are
  filed under the underlying, the name up to its first hyphen.

### okx

**Every series but books spills back**: a day or month file of trades, candlesticks, funding or
borrowing is a UTC+8 period, and book files are UTC days
([why](../venues/OKX.md#periods-are-utc8)). Every row names its instrument, and every series
declares that column as `instrument`, so a file holding a chain or a whole market is split by it.

**trades** — `instrument_name, trade_id, side, price, size, created_time[, source]` → `tradeId =
trade_id, price, size, side, ts = created_time`; `baseSize = size` on spot, and no leg on the
contracts, where `size` is a contract count. Read by name, so the `source` column of later perp and
option files is never read. Perpetual trades for 2021-10 are published with every trade twice, once
a side ([why](../venues/OKX.md#swap-trades-for-2021-10-list-every-trade-twice)), and are stocked as
published: that month's perp trades hold each trade twice.

**klines** — `instrument_name, open, high, low, close, vol, vol_ccy, vol_quote, open_time,
confirm` → OHLC, `volume = vol`, `ts = open_time`. `quoteVolume` is `vol_quote`; on spot, where that
holds no number, it is `vol_ccy`, the same quantity there
([why](../venues/OKX.md#candlestick-volumes-are-three-columns-filled-by-era)). A literal `None`
casts to NULL. No interval is named in a file; the catalog files them as `1m`, and the bars' spacing
agrees. The series declares `repeatsRows`
([why](../venues/OKX.md#candlestick-files-can-repeat-rows)).

**funding** — `instrument_name, funding_rate, funding_time` → `rate = funding_rate`, `ts = funding_time`. One entry
reads both renderings: the daily `allswap` file, every swap in one, and the monthly per-instrument
file ([why](../venues/OKX.md#funding-is-per-symbol-monthly-venue-wide-daily--and-has-a-three-month-hole)).
Where both are on disk the per-instrument rendering is preferred. The monthly rendering is read with
the daily file's columns and is **unverified — no file decoded**.

**borrowing** — `currency_name, borrow_rate, time`, every currency in one daily file →
`currency = currency_name, rate = borrow_rate, ts = time`; the currency is the instrument
(`instrument: currency_name`).

**books** — a record a line, `{instId, action, ts, asks, bids}`: `action` `snapshot` → `snapshot`,
`update` → `set`; a level is `[price, size, orders]`, its third value read as `orderCount`. Levels of
price `0` pad an image to its depth and are dropped. No spill
([why](../venues/OKX.md#what-a-book-file-holds)).

### bitget

**Every series spills back**: a day cuts at 16:00 UTC, midnight UTC+8
([why](../venues/BITGET.md#buckets-cut-at-1600-utc-not-midnight)). Spot, perp and future share one
set of formats, an entry for each market.

**trades** — `trade_id, timestamp, price, side, volume(quote), size(base)` → `tradeId = trade_id,
price, side, ts = timestamp, size = baseSize = size(base)`, `quoteSize = volume(quote)`. A day is
split into parts, each a standalone zip with its own header
([why](../venues/BITGET.md#multi-part-days-are-independent-zips)). The millisecond part of
`timestamp` is zero in later files, so `trade_id` and file order, not `ts`, order trades within a
second there ([why](../venues/BITGET.md#trade-timestamps-carry-only-second-resolution)).

**A day's klines, quotes and books are a sheet, a month's are text**, with the same columns under the
same names; one entry reads both, and which a file is, is read off the file
([why](../venues/BITGET.md#a-days-klines-and-depth-are-a-sheet-a-months-are-text)). Trades are CSV in
both.

**klines** — `timestamp, open, high, low, close, basevolume, usdtvolume` → OHLC, `volume =
basevolume`, `quoteVolume = usdtvolume`. Two layouts are served, the older spelling
`baseVolume`/`usdtVolume`; a union by name folds them, DuckDB's identifiers being case-insensitive.
No interval is named in a file; the catalog files them as `1m`, and the bars' spacing agrees.

**quotes** (`depth`) — `timestamp, ask_price, bid_price, ask_volume, bid_volume` → `bidPrice,
bidSize, askPrice, askSize`. A missing quote is `-999999`
([why](../venues/BITGET.md#sentinel-value-in-depth)), mapped to NULL after a cast to `DOUBLE` —
comparing first would cast the column to an integer and fail on sizes past 2^31 or with decimals.
Sizes are stored as published
([why](../venues/BITGET.md#coin-margined-futures-are-two-live-product-lines)).

**books** (`depth_500`) — `timestamp, asks, bids`: each side JSON text in one cell,
`[[price, size], …]`, parsed into the list. Rows are not in time order.

## Partitions read with another market's formats

- **bitget `future`** is read with the formats of its perpetuals, an entry for each market with the
  same mapping: its trades, klines and quotes have the perpetuals' columns.
- **htx `future`** is read with its perpetuals' formats, but for its mark price, an entry of its own
  in the same shape; dated futures publish no index.
