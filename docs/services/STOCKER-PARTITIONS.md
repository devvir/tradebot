# Stocker partitions

Every input format stocker reads, by dataset: what a raw file looks like and how it becomes the
canonical table. The canonical schemas, and the machinery every format shares (unit inference,
`TRY_CAST`, empty and malformed files, spill), are in [STOCKER.md](STOCKER.md); terms are in
[VOCABULARY.md](../VOCABULARY.md).

A format is described by what is in the file, never by where the file came from. Stocker knows a
partition's attributes — venue, market, dataset, variant, bundle, grain, month — each file's
instrument, and the files' contents; anything else is not an input. Where a format depends on the
instrument's **margining** (linear or inverse), that is read from the venue's symbol
(`schema/margin.ts`), and the same answer fills the canonical `margin` column.

**How to read the tables.** One row per format. A dataset whose format changed over time has one row
per era, with the dates it holds for. `—` means the venue publishes no such column, and the canonical
field is NULL. Every row is the **archives** source today; REST and WS formats join as rows of their
own.

| Column | Meaning |
|---|---|
| Hdr | `yes` mapped by column name · `no` positional, every column declared in order · `grew` positional, because a header appeared partway through history and reads as a dropped row |
| Sym | whether rows name the instrument. Where they do, a file filed under the wrong symbol is provable from its contents; where they do not, only the path says what it is |
| ts | the timestamp as written. The unit is inferred from the value ([STOCKER.md](STOCKER.md#time)) |

## Overview

### trades

Canonical: `ts, tradeId, price, size, baseSize, quoteSize, side, buyerMaker`. `side` is the taker's,
lowercase `buy`/`sell`.

| Venue | Market | Era | File | Hdr | Sym | ts | Side | Size | Notes |
|---|---|---|---|---|---|---|---|---|---|
| binance | spot | all | zip · csv | no | no | int ms; **µs from 2025-01** | from `is_buyer_maker` (true → sell) | base · quote both published | |
| binance | perp | linear | zip · csv | grew | no | int ms | from `is_buyer_maker` | base · quote both published | 4th column is `quote_qty` — see [details](#binance) |
| binance | perp | inverse | zip · csv | grew | no | int ms | from `is_buyer_maker` | contracts; base published | 4th column is `base_qty` — **same position, opposite meaning** |
| bybit | perp | all | csv.gz | yes | **yes** | float s, µs | `Buy`/`Sell` | base on linear, **quote on inverse** — the leg filled follows the margining | gained `RPI` 2025-04 |
| bybit | spot | all | csv.gz | yes | no | int ms | `buy`/`sell` | base | gained `rpi` 2025-04 |
| bybit | option | all | zip · csv | yes | **yes** | int ms | `Buy`/`Sell`, in `direction` | `amount`, as published — which leg it is, not settled | an underlying's whole book a day: **several instruments**; iv, index and mark price per row are not kept |
| kucoin | spot | all | zip · csv | yes | no | int ms | `BUY`/`SELL` | base | |
| kucoin | perp | all | zip · csv | yes | no | int ms | `BUY`/`SELL` | contracts | |
| htx | spot | before 2026-02-01 | zip · csv | no | no | int ms | `buy`/`sell` | base | 5 columns |
| htx | perp, future | before 2026-02-01, inverse | zip · csv | no | no | int ms | `buy`/`sell` | contracts; base published | 6 columns — see [details](#htx) |
| htx | perp, future | before 2026-02-01, linear | zip · csv | no | no | int ms | `buy`/`sell` | contracts; base · quote published | 7 columns |
| htx | option | all (ended 2021-06) | zip · csv | no | no | int ms | `buy`/`sell` | contracts; base · quote published | the linear contract's 7 columns; the quote leg is the premium paid |
| htx | spot | from 2026-02-01 | zip · csv | yes | **yes** | int ms | `buy`/`sell` | base | |
| htx | perp, future | from 2026-02-01 | zip · csv | yes | **yes** | int ms | `buy`/`sell` | contracts | |
| gate | spot | all | csv.gz | no | no | float s, µs | `1`/`2` (1 = buy, by price impact) | base | rows in **descending** time |
| gate | perp | all | csv.gz | no | no | float s, µs | **sign of size** (negative = sell) | unsigned after `abs` | a file wider than 4 columns is refused — see [details](#gate) |
| okx | spot, perp | all | zip · csv | yes | **yes** | int ms | `buy`/`BUY`, by year | base on spot, contracts on perp | |
| okx | future | all | zip · csv | yes | **yes** | int ms | `buy`/`BUY` | as published | one file holds a whole expiry chain: **several instruments** |
| okx | option | all | zip · csv | yes | **yes** | int ms | `buy`/`sell` | contracts | a family's whole chain in a file, or every option; gained `source` by 2026 |
| bitget | spot, perp, future | all | zip · csv, a day in parts, a month whole | yes | no | int ms; **whole seconds** in later files | `buy`/`sell` | base · quote both published | spills back; every part has its own header |

### klines

Canonical: `ts, open, high, low, close, volume, quoteVolume, trades, takerBuyVolume,
takerBuyQuote`. The interval is the variant; it is never a column.

| Venue | Market | Era | File | Hdr | Sym | ts | Column order | Volume | Interval from | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| binance | spot | all | zip · csv | no | no | int ms; **µs from 2025-01** | OHLC | base, quote, trades, taker buy both legs | variant | 12 columns; `close_time` dropped |
| binance | perp | all | zip · csv | grew | no | int ms | OHLC | base, quote, trades, taker buy both legs | variant | same 12 columns |
| bybit | perp (MT4) | all | csv.gz | no | no | text `2024.11.01 00:00`, **UTC+3** | OHLC | one | the catalog's variant (from `15` in the filename) | declared UTC+3, spills back — see [details](#bybit) |
| kucoin | spot | all | zip · csv | yes | no | int s | **O C H L** | base, quote (`turnover`) | variant | by name, so the order costs nothing |
| kucoin | perp | all | zip · csv | yes | no | int ms | OHLC | one | variant | `1d` files are malformed — see [details](#kucoin) |
| htx | spot | before 2026-02-01 | zip · csv | no | no | int s | **O C H L** | **`vol` is quote, `amount` base** | variant | names invert against the later era |
| htx | perp, future, option | before 2026-02-01 | zip · csv | no | no | int s | **O C H L** | `vol` contracts, `amount` base | variant | two-sided, by the venue's definition — see [details](#htx) |
| htx | spot, perp, future | from 2026-02-01 | zip · csv | yes | **yes** | int s | OHLC | `vol` (base on spot, contracts on contracts), quote `volCcyQuote` | variant | |
| gate | spot, perp | all | csv.gz | no | no | int s | **`volume, close, high, low, open`** | base | variant | open and close reversed — see [details](#gate) |
| gate | tradfi | all | csv.gz | no | no | int s | **`close, high, low, open`** | none published | variant | the spot candle less its volume |
| okx | spot, perp, future, option | all | zip · csv | yes | **yes** | int ms | OHLC | `vol` (base on spot, contracts on contracts); quote from `vol_quote`, and on spot from `vol_ccy` where that is empty | the catalog's `1m`, named nowhere in a file | spills back; literal `None` in volume columns; exact repeated rows dropped |
| bitget | spot, perp, future | two layouts, interleaved | zip · **xlsx** in a day's file, **csv** in a month's | yes | no | int s or ms | OHLC | base, quote | **declared `1m`**, named nowhere | spills back; see [details](#bitget) |

### Reference prices — markPrice · indexPrice · premiumIndex

Canonical `markPrice`/`indexPrice`: `ts, price, open, high, low, close`; `premiumIndex`: `ts, open,
high, low, close`. A bar of a reference price is OHLC; a tick of one is `price`.

| Venue | Dataset | Market | File | Hdr | Sym | ts | Shape | Notes |
|---|---|---|---|---|---|---|---|---|
| binance | mark, index, premium | perp | zip · csv | grew | no | int ms | the 12-column kline shape | volume always 0, `count` is a sample count |
| bybit | premiumIndex | perp | csv.gz | yes | ? | `start_at` | OHLC bars | |
| bybit | indexPrice | spot | csv.gz | yes | ? | `start_at` | OHLC bars | |
| kucoin | mark, index | perp | zip · csv | yes | no | int ms | OHLC bars | |
| htx | mark, index | perp | zip · csv | yes | **yes** | int s | OHLC bars | before 2026-02-01: headerless O C H L, no symbol — mapped from the published header names, not yet seen in a file |
| htx | mark | future | zip · csv | yes | **yes** | int s | OHLC bars | before 2026-02-01: O C H L by position, no symbol, **some files with a header line and some without** |
| gate | markPrice | perp | csv.gz | no | no | float s, µs | ticks: `ts` and three prices | only the first price is identified |
| gate | indexPrice | spot | plain text, **market** bundle | no | **yes** | **the file's name** | ticks: a line an instrument, `<symbol> <price>` | an hour apart; see [details](#gate) |

### quotes

Canonical: `ts, bidPrice, bidSize, askPrice, askSize` — level 1 of a book.

| Venue | Market | File | Hdr | Sym | ts | Notes |
|---|---|---|---|---|---|---|
| binance | perp | zip · csv | yes | no | int ms (`transaction_time`) | `bookTicker`; the archive ended |
| bitget | spot, perp, future | zip · **xlsx** in a day's file, **csv** in a month's | yes | no | int s | missing quote is **`-999999`** → NULL; spills back |

### funding

Canonical: `ts, rate, intervalHours`, under `kind=realised` (charged) or `kind=predicted` (the
running estimate).

| Venue | Kind | Bundle | File | Hdr | Sym | ts | Notes |
|---|---|---|---|---|---|---|---|
| binance | realised | instrument | zip · csv | yes | no | int ms (`calc_time`) | carries `funding_interval_hours` |
| kucoin | realised | instrument | zip · csv | yes | **yes** | int ms | |
| htx | realised | instrument | zip · csv | yes | **yes** | int ms | |
| gate | realised | instrument | csv.gz | no | no | int s | `ts, rate` |
| gate | predicted | instrument | csv.gz | no | no | int s | `ts, rate` and six unidentified columns |
| okx | realised | **market** | zip · csv | yes | **yes** | int ms | daily, every swap in one file — split per instrument |

### The rest

| Venue | Dataset | Market | File | Hdr | Sym | ts | Notes |
|---|---|---|---|---|---|---|---|
| binance | depthBands | perp | zip · csv | yes | no | **datetime text** | notional within ±% bands of the mid; not a book |
| binance | openInterest | perp | zip · csv | yes | **yes** | **datetime text** | `metrics`: OI, OI value, two of four ratios mapped |
| binance | liquidations | perp, future | zip · csv | yes | no | int ms | `liquidationSnapshot`, one shape on every line of futures; **every row written twice**, written once here |
| binance | volatilityIndex | option | zip · csv | yes | **yes** | int ms (`calc_time`) | `BVOLIndex`, a value a second → `volatilityIndex.value` |
| okx | borrowing | spot | zip · csv | yes | currency | int ms | **market** bundle, keyed by currency rather than instrument — split per currency |

### orderBook · orderBookSnapshot

A book published as an image and the changes since is `orderBook`: `ts, action, side, price, size,
orderCount, sequence`, a row a level ([what `action` says](STOCKER.md#canonical-tables)). A book
published whole at each tick is `orderBookSnapshot`: `ts, asks, bids, sequence`, a row a message, each
side a list of `[price, size]`. The catalog's variant is the depth and the mode, and both are levels of
the path, under one dataset: `dataset=orderBook/depth=400/mode=incremental`.

| Venue | Market | Depth · mode | File | Read as | Sym | ts | Action | Sequence | Notes |
|---|---|---|---|---|---|---|---|---|---|
| okx | spot, perp, future, option | 400, 5000 · incremental | tar.gz · JSON a line | ndjson | **yes** | int ms | `snapshot` → snapshot, `update` → set | — | a level is `[price, size, orders]`; an image a minute at 400 levels, padded with price-0 levels that are dropped; **cuts at UTC midnight**, unlike the rest of okx |
| htx | spot (400), perp, future (150) | incremental | tar.gz · JSON a line | ndjson | yes, unused | int µs | `snapshot` → snapshot, `update` → set | — | okx's record with a level of two values; one image as the file opens; spills back |
| bybit | perp | 200, 500 · incremental | zip · JSON a line | ndjson | yes, unused | int ms | `snapshot` → snapshot, `delta` → set | `data.seq` | levels under `data.b` / `data.a` |
| gate | spot | full · incremental | csv.gz, an hour a part | csv, by position | no | float s, tenths | as published: `set`, `make`, `take` | the id | `ts, side, action, price, amount, id, merged`; side `1` ask, `2` bid |
| gate | perp, future | full · incremental | csv.gz, an hour a part | csv, by position | no | float s, tenths | as published | the id | `ts, action, price, size, id, merged`; **a negative size is an ask** |

| Venue | Market | Depth · mode | File | Read as | ts | Sequence | Notes |
|---|---|---|---|---|---|---|---|
| gate | spot | 20 · snapshot | gz · JSON a line, an hour a part | ndjson | `current`: float s early, int ms later | `id` | a level is `[price, size]` |
| gate | perp | 20 · snapshot | gz · JSON a line, an hour a part | ndjson | `current` | `id` | a level is `{p, s}`, stored as `[price, size]` |
| kucoin | spot, perp | 50 · snapshot | zip · JSON a line under a one-word header | lines | int ms (`timestamp`) | `sequence`, futures only | **some files write every line twice**, written once here; lines are not in time order |
| bitget | spot, perp, future | 500 · snapshot | zip · **xlsx** in a day's file, **csv** in a month's | xlsx · csv | int s | — | `timestamp, asks, bids`, a side JSON text in one cell; an image every 20 s; spills back |

### Options — optionTicker · optionMarkPrice · volatilityIndex

Canonical `optionTicker`: `ts, option, open, high, low, close, volume, quoteVolume, bidPrice, bidSize,
bidIv, askPrice, askSize, askIv, markPrice, markIv, delta, gamma, vega, theta, openInterest,
openInterestValue`. `optionMarkPrice`: `ts, option, open, high, low, close, delta, gamma, vega, theta`.
`volatilityIndex`: `ts, value`.

**The instrument of these two tables is the underlying, and `option` names the contract** — a file
of the vault is an underlying's month, not a contract's.

| Venue | Dataset → table | File | Hdr | Sym | ts | Notes |
|---|---|---|---|---|---|---|
| binance | optionSummary (1h) → optionTicker | zip · csv | yes | the option | `date` + `hour`, text | an underlying's file holds every option on it; fills every column |
| gate | optionTicker (ticks, **market** bundle) → optionTicker | plain text, a file a minute | no | the option | **the file's name** | 13 unnamed values a line — see [details](#gate); fills the mark, the quote and the greeks; rows are split per underlying, the option's name up to its first hyphen |
| bybit | markPrice (1m) → optionMarkPrice | zip · csv | yes | the option | int ms (`open_time`) | an underlying's file holds a day of every option on it; gamma is spelled `gama` |
| binance | volatilityIndex (ticks) → volatilityIndex | zip · csv | yes | **yes** | int ms | listed under [the rest](#the-rest) |

## Telling formats apart inside one partition

A partition can hold more than one format: different eras, or several shapes of one dataset filed
under one canonical key. Each case has to be decided from the file, its name or the partition's
attributes.

| Partition | Formats in it | Told apart by |
|---|---|---|
| binance perp trades | linear and inverse — the 4th column is quote on one, base on the other | the instrument's margining: inverse symbols are `<COIN>USD_<PERP or expiry>`, checked against every binance perpetual and future symbol in the catalog |
| bybit perp trades | linear and inverse — `size` is base on one, quote on the other | the instrument's margining |
| htx contract trades before 2026-02-01 | linear (7 columns) and inverse (6) | the instrument's margining |
| binance spot trades, klines | ms through 2024-12, µs from 2025-01 | the value — unit inference |
| binance futures datasets | headerless, then a header from 2021-01 … 2022-07 | positional read; the header line is a row whose timestamp does not parse |
| bybit perp, spot trades | without and with `RPI` | by-name mapping absorbs it |
| htx everything | `data/` shape before 2026-02-01, `historical_data/` shape from it | the date — a flat cut, no overlap |
| bitget klines | two layouts in one month, never the same day twice | by-name mapping, case-insensitive (`baseVolume` = `basevolume`) |
| bitget klines, quotes, books | a sheet in a day's file, text in a month's | the file itself: a sheet opens as a zip archive does |
| okx spot klines | quote volume in `vol_ccy` early, in `vol_quote` and `vol_ccy` later | whichever holds a number |

## Details

### binance

**trades, spot** — headerless for the whole archive:
`id, price, qty, quote_qty, time, is_buyer_maker, is_best_match` → `tradeId, price, size = baseSize =
qty, quoteSize = quote_qty, ts = time, side, buyerMaker`. `is_best_match` is dropped. The side is
`is_buyer_maker` inverted: a maker buyer means the taker sold — verified on 400,000 trades by the next
trade's price.

**trades, perp** — `id, price, qty, <4th>, time, is_buyer_maker`.

- USDⓈ-M: 4th is `quote_qty` → `size = baseSize = qty`, `quoteSize = quote_qty`.
- COIN-M: 4th is `base_qty` → `size = qty` (contracts), `baseSize = base_qty`; `qty` is neither leg.

**klines** and **mark/index/premium klines** — twelve columns: `open_time, open, high, low, close,
volume, close_time, quote_volume, count, taker_buy_volume, taker_buy_quote_volume, ignore`. Klines
map all but `close_time` and `ignore`; the reference-price datasets map OHLC only, since their volume
is 0 and `count` is a sample count. Spot has never had a header; the futures files grew one.

**funding** — `calc_time, funding_interval_hours, last_funding_rate` → `ts, intervalHours, rate`.

**quotes** (`bookTicker`) — `update_id, best_bid_price, best_bid_qty, best_ask_price, best_ask_qty,
transaction_time, event_time`; `ts = transaction_time`.

**depthBands** (`bookDepth`) — `timestamp, percentage, depth, notional`; `timestamp` is
`2026-07-29 00:00:01` text.

**openInterest** (`metrics`) — `create_time, symbol, sum_open_interest, sum_open_interest_value,
count_toptrader_long_short_ratio, sum_toptrader_long_short_ratio, count_long_short_ratio,
sum_taker_long_short_vol_ratio` → `openInterest, openInterestValue, longShortRatio =
count_long_short_ratio, takerLongShortVol = sum_taker_long_short_vol_ratio`. `create_time` is
datetime text.

**liquidations** (`liquidationSnapshot`) — `time, side, order_type, time_in_force,
original_quantity, price, average_price, order_status, last_fill_quantity,
accumulated_fill_quantity` → `ts, side, size = original_quantity, price, averagePrice, status`.

**liquidations** — `time, side, order_type, time_in_force, original_quantity, price, average_price,
order_status, last_fill_quantity, accumulated_fill_quantity` → `side, price, size = original_quantity,
averagePrice, status`. The same ten columns on coin-margined and USDⓈ-M instruments, perpetual and
dated. Every row is written twice, one after the other, in every file read (`BTCUSDT` 2023-06-25:
1,720 rows, 860 of them; `BTCUSD_PERP` 2024-10-14: 100 and 50), so exact repeats are dropped.
`original_quantity` is contracts on a coin-margined instrument and the base coin on the others.

**optionSummary** — `date, hour, symbol, underlying, type, strike, open, high, low, close,
volume_contracts, volume_usdt, best_bid_price, best_ask_price, best_bid_qty, best_ask_qty, best_buy_iv,
best_sell_iv, mark_price, mark_iv, delta, gamma, vega, theta, openinterest_contracts,
openinterest_usdt` → `optionTicker`, a row an option an hour, `option = symbol`. `ts` is
`date` and `hour` together. An empty quote is `""` or `0E-8`; the first is NULL and the second 0, as
published.

**volatilityIndex** — `calc_time, symbol, base_asset, quote_asset, index_value` → `value`, a row a
second.

### bybit

**trades, perp** — `timestamp, symbol, side, size, price, tickDirection, trdMatchID, grossValue,
homeNotional, foreignNotional[, RPI]` → `ts, side, size, price, tradeId = trdMatchID`. `timestamp`
is fractional seconds (`1785283200.0635`). `size` is base for USDT and PERP symbols and **quote** for
the `USD` inverse ones — checked over 160 symbols against `foreignNotional` — so it turns on the
instrument's margining: `baseSize = size` on linear, `quoteSize = size` on inverse.

**trades, option** — `trade_id, trade_seq, timestamp, instrument_name, direction, price, amount, iv,
index_price, mark_price, mark_iv` → `tradeId = trade_id, ts, price, size = amount, side =
direction`. One file a day per underlying holds every option of it, so the rows are split by
`instrument_name`. `timestamp` is integer milliseconds, plain UTC: the 2026-10-04 file opens four
seconds after midnight. Which leg `amount` measures has not been settled, so neither `baseSize` nor
`quoteSize` is filled. `iv`, `index_price`, `mark_price` and `mark_iv` are not kept.

**trades, spot** — `id, timestamp, price, volume, side[, rpi]` → `tradeId, ts, price, size =
volume, side`. Integer milliseconds under the same `timestamp` name the perp files use for seconds.

**klines (MT4)** — headerless `datetime, open, high, low, close, volume`, the datetime as
`2024.11.01 00:00` in **UTC+3**, the MetaTrader server zone, with no daylight-saving switch.
They are perpetual klines: `BTCUSDT` 1h bars match the perp trades summed per hour exactly on every
hour of 2020-10 and 2020-12 (1,000+ hours), and only at a 3-hour offset — the bar labelled 03:00 is
the trades of 00:00–01:00 UTC. A month's file is a UTC+3 month, so it holds the last 3 hours of the
previous UTC month and stops 3 hours short of its own end. So the series declares the zone
(`utcOffsetHours: 3`) and a back spill: each month is read with the next month's file and clipped
to its UTC bounds. The interval is the catalog's variant — the filename's bare count of minutes
(`BTCUSDT_15_2024-02-01_2024-02-29`) in the shared vocabulary, `15m`. The filename carries a date
range, always exactly one calendar month.

**Truncated months.** Some MT4 files hold a fraction of their month — `BTCUSDT` 1h for 2023-12,
2024-01 and 2024-03 hold 200 bars, 2024-02 400. Nothing in the file says so; stocked as they are.

**premiumIndex, indexPrice** — headed; `start_at` and OHLC are mapped by name.

**books** — a record a line: `{topic, type, ts, data: {s, b, a, u, seq}, cts}`. `type` is `snapshot`
when the stream opens and `delta` after; `b` and `a` are `[price, size]` levels, a size of `0` removing
the level. `seq`, bybit's cross sequence, rises through a file and is kept as `sequence`; `u` starts
over at every snapshot and is not.

**markPrice, option** — `instrument_name, open_time, open, high, low, close, delta, gama, vega, theta`
→ `optionMarkPrice`, `option = instrument_name`.

### kucoin

**trades** — `trade_id, trade_time, price, size, side`; side `BUY`/`SELL`. Spot size is base; perp
size is a contract count.

**klines, spot** — `time, open, close, high, low, volume, turnover`: close **before** high, unlike
every other venue and unlike kucoin's own perp klines. `time` is seconds; `turnover` is the quote
volume.

**klines, perp** — `time, open, high, low, close, volume`, `time` in milliseconds. The **`1d`
files are malformed**: six columns declared, five written on every row of every file, byte-identical
to what the venue serves. They parse to one column and fail the build, which names them.

**funding** — `symbol, time, fundingRate`. **mark, index** — `time, open, high, low, close`.

**books** — a line is `{"asks": [[price, size], …], "bids": […], "timestamp": ms}`, futures adding
`sequence` and `ts`, under a header line that says `data`. Every line is a whole image of the top 50
levels a side. The file calls itself a CSV and is not one — its lines are full of JSON's own commas —
so it is read a line at a time and each line parsed; the header, and a line cut short, parse to
nothing. Lines are not in time order, and some files hold every line twice.

### htx

**Every dataset spills back**: a day file is a UTC+8 day in both exports — the 2020-06-15 trades
and klines hold 06-14 16:00 → 06-15 15:59 UTC, and the 2026-07-29 files open at 07-28 16:00.

**Two eras, cut flat at 2026-02-01.** Everything before is the `data/` shape, everything from it the
`historical_data/` shape. Both are mapped.

The earlier files carry **no header** — every 2019–2020 file read on 2026-10-04 starts with data —
so they are read by position. The names below are the venue's own, for what each position holds:

| dataset | from 2026-02-01 | before 2026-02-01 |
|---|---|---|
| klines | `instId, open, high, low, close, vol, volCcy, volCcyQuote, ts` | `timestamp, open, close, high, low, vol, amount` |
| trades, spot | `instId, tradeId, px, side, size, ts` | `Trade ID, Trade Time, Trade Price, Volume (Base Currency), Side (buy/sell)` |
| trades, perp, linear | `instId, tradeId, px, side, size, ts` | `Trade ID, Trade Time, Trade Price, Volume (in Contracts), Volume (in Base Currency), Turnover, Side (buy/sell)` |
| trades, perp/future, inverse | `instId, tradeId, px, side, size, ts` | the same without `Turnover` — six columns |
| mark, index | `instId, open, high, low, close, ts` | `timestamp, open, close, high, low` |
| funding | `instId, fundingRate, fundingTime` | — (none before the cut) |

**The volume names invert between eras** on spot: the later `vol` is base and `volCcyQuote` quote;
the earlier `vol` is quote and `amount` base (868.87 ZEC against 44,492 USDT at ~51). On contracts
`vol` is the contract count in both eras, and the earlier `amount` the base coin. On the same day the two eras agree bar for bar
(`BTC-USDT` 1m, all 1,440 bars). The earlier perp trades carry both legs, which the later shape drops.

**A contract's kline volume is two-sided, and is stored as published.** htx counts both the buy and
the sell side of every trade in a contract kline's `vol` and `amount`, so they are twice what its
trades add up to — by its own definition, on every contract market and never on spot
([HTX.md](../venues/HTX.md#a-contracts-kline-volume-counts-both-sides-of-every-trade)). Nothing is
halved here: the column holds what the venue reports, and what the venue means by it is the venue's.

**Options** (`BTC-USDT-201225-C-13000`) ran from 2020-08 to 2021-06, USDT-margined throughout, and
are the linear contract's shapes: trades with contracts, base and a quote leg that is the premium
paid, and the seven-column kline.

**Dated futures publish a mark price and no index.** Before the cut it is the perpetual's five
columns by position — except that some files open with a header line, `id,open,close,high,low`
(`ADA210702`, 2021-07-02) and others do not (`BTC-USDT-230714`, 2023-07-14). Read by position, the
header is a row whose time does not parse.

Later-era klines and mark/index are stamped in seconds, trades and funding in milliseconds. `vol` and
`volCcyQuote` were confirmed as base and quote by rebinning a day of trades into 1m bars.

**mark, index** carry an interval, so they are klines *of* the mark and index price rather than
ticks.

**books** — okx's record, `{instId, action, ts, asks, bids}`, with a level of two values and `ts` in
microseconds. One `snapshot` as the day's file opens, `update`s after.

### gate

Headerless throughout.

**trades** — two shapes that differ by one column:

```
spot   ts, id, price, size, side    size unsigned; side 1 = buy, 2 = sell
perp   ts, id, price, size          size signed; the sign is the side
```

Both were settled from rows: spot side `1` is followed by an uptick 1.63M times against 0.19M
downticks over 7.5M `BTC_USDT` trades; negative perp sizes are followed by downticks on both
USDT- and BTC-settled contracts. Perp maps `size = abs(size)`, `side` from the sign. Timestamps are
fractional seconds at µs precision. Spot rows are in **descending** time.

Read with the perp map, a spot file still "works" — every trade a buy, the unsigned size in place of
the signed one. So a file **wider than its series declares is refused**, naming it. 2021-07 is the
known case: 85 perp-trade files are truncated copies of the spot file for the same symbol, five
columns wide, and their last lines are cut mid-row.

**klines, tradfi** — `ts, close, high, low, open`: the candle below less its volume. Settled from the
rows: the third column is each bar's highest value and the fourth its lowest, and the second of one
bar is the fifth of the next on every consecutive pair read (AAPL 1m, 2024-01). Stamped in plain UTC
seconds — AAPL's first 1m bar of a day is 14:30 UTC.

**klines** — `ts, volume, close, high, low, open`. **Open and close are reversed** from the obvious
reading; nothing in a single bar shows it. Settled by alignment: bars of 1m, 5m, 1h and 1d sharing a
start share the last column and differ in the third, so the last is the open. `volume` is the base
leg on spot as on perp — summing spot trades per hour reproduces it to six decimals.

**markPrice** — `ts, price, ?, ?`: three prices per row, only the first identified.

**funding** — `funding_applies` (realised): `ts, rate`. `funding_updates` (predicted): `ts, rate`
and six columns not identified. Three rows a day against 1,440.

**Empty files.** A symbol that listed and never traded leaves a **zero-byte** file, not a valid gzip;
it is empty and skipped.

**books, incremental** — an hour's file opens with the whole book as `set` rows under one id; `make`
and `take` rows follow, each adding to a level or taking from it. Rebuilt from a file that way, no
level goes below zero and the sides never cross (`BTC_USD` 2026-06-01 21h: 18,538 rows). Spot names
the side — `1` the asks, `2` the bids: in the first image every `2` sits below every `1`. Futures
have no side column and sign the size, negative for an ask; the size stored is its magnitude. Times
are in tenths of a second, so the id is what orders the rows inside one.

**books, snapshot** — a record a line: `{id, current, update, asks, bids}`, the top 20 levels a side.
`current` is when the image was taken and is the row's time; `update` is when the book last changed.
Both are seconds with a fraction in the early files (2021) and whole milliseconds in the later ones.
Spot writes a level `[price, size]`, futures `{"p": price, "s": size}`.

**Files named by the moment they hold** — the spot index (`indexPrice`, an hour apart) and the option
ticker (`optionTicker`, a minute apart) are plain text with no header, no extension and no time
inside: a line an instrument, its values parted by blanks, a line sometimes beginning with one. The
catalog keeps the moment as the file's part — `…|202606.part1780272000` — and `ts` is read from it.

- **indexPrice** — `<symbol> <price>`.
- **optionTicker** — the option's name and twelve unnamed values, read as: mark price, mark iv; bid
  size, bid price, bid iv; ask size, ask price, ask iv; delta, gamma, theta, vega. Settled from the
  numbers: the second value is the same for the call and the put of one strike; the two triples
  bracket the first value from below and from above, their third values bracketing the second; and
  of the last four the first is negative on every put and the third negative throughout.

### okx

**Every dataset spills back**: a day or month file is a UTC+8 period, so the file dated
2020-06-15 holds 06-14 16:00 → 06-15 15:59 UTC — the same cut as bitget's
([STOCKER.md](STOCKER.md#venues-whose-buckets-do-not-cut-at-utc-midnight)).

**Options** are the other markets' files with the same columns: a family's whole chain in one
(`BTC-USD-optionchain`), or every option there is (`alloption`). The price is the premium in the
coin. The earliest kline files spell an absent volume `None` (2021-09-01); later trade files carry a
`source` column the earlier ones lack.

**Duplicated bars.** Candlestick files can repeat rows byte for byte: 96 of 200 sampled 2020 spot
files repeat every bar, 4 of 40 sampled 2023 perpetual files repeat a few. The series declares it
(`repeatsRows`), and exact repeats are written once.

**Kline quote volume.** `quoteVolume` is `vol_quote`. On spot, where that holds no number, it is
`vol_ccy`, which there is the same quantity; on a contract `vol_ccy` is the base coin and is not read.
The eras are in [OKX.md](../venues/OKX.md#candlestick-volumes-are-three-columns-filled-by-era).

**trades** — `instrument_name, trade_id, side, price, size, created_time`. Side is `buy` or `BUY`,
depending on the year. A dated-futures file covers a whole expiry chain, so its rows name several
instruments.

**klines** — `instrument_name, open, high, low, close, vol, vol_ccy, vol_quote, open_time, confirm`
→ OHLC, `volume = vol`, `quoteVolume = vol_quote`, `ts = open_time`. No interval is named anywhere;
`open_time` steps by exactly 60,000, so the series declares `1m`. Early eras write Python's **`None`**
in `vol_ccy` and `vol_quote` on every row, which reads as NULL.

**funding** — `instrument_name, funding_rate, funding_time`, every swap in one daily file. The
monthly per-instrument rendering is not mapped.

**borrowing** — `currency_name, borrow_rate, time`, every currency in one daily file.

**books** — a record a line, `{instId, action, ts, asks, bids}`: `action` is `snapshot` (the whole
book to its depth, once a minute at 400 levels) or `update` (the levels that changed), a level
`[price, size, orders]`, a size of `0` removing it. An image is filled out to its depth with levels of
price `0`, which are dropped. `ts` is unique and rising through a file. The files cut at UTC midnight
— not at 16:00 like okx's trades and candlesticks — so nothing spills. A dated-futures or option file
holds a whole chain, each record naming its instrument.

### bitget

**Every dataset spills back**: a bucket cuts at 16:00 UTC (midnight UTC+8), so the file named
`20250101` opens at 2024-12-31 16:00 UTC. The timestamps are plain epoch ms UTC; only which file
holds a row is shifted ([STOCKER.md](STOCKER.md#venues-whose-buckets-do-not-cut-at-utc-midnight)).

**trades** — `trade_id, timestamp, price, side, volume(quote), size(base)` → `size = baseSize =
size(base)`, `quoteSize = volume(quote)`; `price × size(base)` reproduces `volume(quote)` on every row
checked. `timestamp` is ms; in the files measured from 2024 on the millisecond part is **always zero**,
so it cannot order trades within a second there — `trade_id` and file order can. 2019 files carry
real milliseconds. A day is split into parts of 100,000 rows, each a standalone
zip with its own header.

**klines** — `timestamp, open, high, low, close, basevolume, usdtvolume` → OHLC, `volume =
basevolume`, `quoteVolume = usdtvolume`. Two layouts are served and both are read; they interleave
within a month, never holding the same day twice. The older writes `baseVolume`/`usdtVolume` and full
float expansions, the newer lowercase and the shortest float — the same data, folded by a
case-insensitive union by name. No interval is named; `timestamp` steps by a minute, so the series
declares `1m`.

**quotes** (`depth`) — `timestamp, ask_price, bid_price, ask_volume, bid_volume`, the best bid and
ask over time. A missing quote is **`-999999`**, mapped to NULL — cast to a number before comparing,
since sizes exceed 2^31 and carry decimals. Sizes are stored as published, which is the base coin
except on the coin-margined contracts sized in whole contracts
([BITGET.md](../venues/BITGET.md#coin-margined-futures-are-two-live-product-lines)).

**A day's klines and quotes are a sheet, a month's are text.** The file of a day holds an XLSX inside
the `.zip`, the file of a month a CSV, with the same columns under the same names. One entry reads
both: which a file is, is read off the file. Trades are CSV in both.

**books** (`depth_500`) — `timestamp, asks, bids`: an image of up to 500 levels a side every twenty
seconds, each side JSON text in one cell, `[[price, size], …]`. A sheet in a day's file and text in a
month's, like the klines; rows are not in time order.

## Known discrepancies with the catalog

- **Linear and inverse contracts** share one canonical key, so a partition mixes their formats —
  see [telling formats apart](#telling-formats-apart-inside-one-partition).
- **bitget `future`** is read with its perpetuals' formats, which its trades, klines and quotes share
  — daily and monthly files of `BTCUSDU24` to `BTCCMZ26` have the same columns.
- **htx `future`** is read with its perpetuals' formats.
