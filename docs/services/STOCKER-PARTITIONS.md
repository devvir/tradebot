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
| kucoin | spot | all | zip · csv | yes | no | int ms | `BUY`/`SELL` | base | |
| kucoin | perp | all | zip · csv | yes | no | int ms | `BUY`/`SELL` | contracts | |
| htx | spot | before 2026-02-01 | zip · csv | no | no | int ms | `buy`/`sell` | base | 5 columns |
| htx | perp, future | before 2026-02-01, inverse | zip · csv | no | no | int ms | `buy`/`sell` | contracts; base published | 6 columns — see [details](#htx) |
| htx | perp, future | before 2026-02-01, linear | zip · csv | no | no | int ms | `buy`/`sell` | contracts; base · quote published | 7 columns |
| htx | spot | from 2026-02-01 | zip · csv | yes | **yes** | int ms | `buy`/`sell` | base | |
| htx | perp, future | from 2026-02-01 | zip · csv | yes | **yes** | int ms | `buy`/`sell` | contracts | |
| gate | spot | all | csv.gz | no | no | float s, µs | `1`/`2` (1 = buy, by price impact) | base | rows in **descending** time |
| gate | perp | all | csv.gz | no | no | float s, µs | **sign of size** (negative = sell) | unsigned after `abs` | a file wider than 4 columns is refused — see [details](#gate) |
| okx | spot, perp | all | zip · csv | yes | **yes** | int ms | `buy`/`BUY`, by year | base on spot, contracts on perp | |
| okx | future | all | zip · csv | yes | **yes** | int ms | `buy`/`BUY` | as published | one file holds a whole expiry chain: **several instruments** |
| bitget | spot, perp | all | zip · csv, in parts | yes | no | int ms; **whole seconds** in later files | `buy`/`sell` | base · quote both published | spills back; every part has its own header |

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
| htx | perp, future | before 2026-02-01 | zip · csv | no | no | int s | **O C H L** | `vol` contracts, `amount` base | variant | |
| htx | spot, perp, future | from 2026-02-01 | zip · csv | yes | **yes** | int s | OHLC | `vol` (base on spot, contracts on contracts), quote `volCcyQuote` | variant | |
| gate | spot, perp | all | csv.gz | no | no | int s | **`volume, close, high, low, open`** | base | variant | open and close reversed — see [details](#gate) |
| okx | spot, perp, future | all | zip · csv | yes | **yes** | int ms | OHLC | base, quote | the catalog's `1m`, named nowhere in a file | spills back; literal `None` in early volume columns; exact repeated rows dropped |
| bitget | spot, perp | two layouts, interleaved | zip · **xlsx** | yes | no | int ms | OHLC | base, quote | **declared `1m`**, named nowhere | spills back; see [details](#bitget) |

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
| gate | markPrice | perp | csv.gz | no | no | float s, µs | ticks: `ts` and three prices | only the first price is identified |

### quotes

Canonical: `ts, bidPrice, bidSize, askPrice, askSize` — level 1 of a book.

| Venue | Market | File | Hdr | Sym | ts | Notes |
|---|---|---|---|---|---|---|
| binance | perp | zip · csv | yes | no | int ms (`transaction_time`) | `bookTicker`; the archive ended |
| bitget | spot, perp | zip · **xlsx** | yes | no | int ms | missing quote is **`-999999`** → NULL; spills back |

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
| binance | liquidations | perp | zip · csv | yes | no | int ms | `liquidationSnapshot`; only the coin-margined files are mapped |
| okx | borrowing | spot | zip · csv | yes | currency | int ms | **market** bundle, keyed by currency rather than instrument — split per currency |

## Not mapped yet

Everything the catalog holds that no row above reads. The format of most of these has not been
surveyed.

| Dataset | Venue · market (variants) | Known about the format |
|---|---|---|
| books | okx spot, perp, future, option (400, 5000 · incremental) | `.tar.gz` |
| books | bybit perp (200, 500 · incremental) | `.data.zip` |
| books | htx spot (400), perp and future (150) · incremental | `.tar.gz` |
| books | gate spot, perp (full · incremental) | csv.gz, hourly parts. Spot: `timestamp, side, action, price, amount, begin_id, merged`; `set` re-benchmarks a level, `take`/`make` adjust it. Perp files have **six** columns and no side column |
| books | gate spot, perp (20 · snapshot) | plain `.gz` JSON rows: `asks[price, qty], bids[price, qty], update, current, id`; `id` only after 2023-04-26 |
| books | gate future (full · incremental) | |
| books | kucoin spot, perp (50 · snapshot) | csv with one `data` column of JSON: `sequence`, `asks`, `bids` |
| books | bitget spot, perp, future | |
| trades | binance spot, perp (aggregated) | reconstructible exactly from `trades` — deliberately no table |
| trades | bybit option · htx option · okx option | |
| klines | htx option · okx option · gate tradfi | |
| markPrice | htx future · bybit option (1m) | |
| indexPrice | gate spot (ticks, **market** bundle) | |
| liquidations | binance perp (USDⓈ-M) · binance future | |
| optionSummary · volatilityIndex | binance option | |
| optionTicker | gate option (ticks, **market** bundle) | |
| quotes | bitget future | |

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

### bybit

**trades, perp** — `timestamp, symbol, side, size, price, tickDirection, trdMatchID, grossValue,
homeNotional, foreignNotional[, RPI]` → `ts, side, size, price, tradeId = trdMatchID`. `timestamp`
is fractional seconds (`1785283200.0635`). `size` is base for USDT and PERP symbols and **quote** for
the `USD` inverse ones — checked over 160 symbols against `foreignNotional` — so it turns on the
instrument's margining: `baseSize = size` on linear, `quoteSize = size` on inverse.

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

Later-era klines and mark/index are stamped in seconds, trades and funding in milliseconds. `vol` and
`volCcyQuote` were confirmed as base and quote by rebinning a day of trades into 1m bars.

**mark, index** carry an interval, so they are klines *of* the mark and index price rather than
ticks.

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

**klines** — `ts, volume, close, high, low, open`. **Open and close are reversed** from the obvious
reading; nothing in a single bar shows it. Settled by alignment: bars of 1m, 5m, 1h and 1d sharing a
start share the last column and differ in the third, so the last is the open. `volume` is the base
leg on spot as on perp — summing spot trades per hour reproduces it to six decimals.

**markPrice** — `ts, price, ?, ?`: three prices per row, only the first identified.

**funding** — `funding_applies` (realised): `ts, rate`. `funding_updates` (predicted): `ts, rate`
and six columns not identified. Three rows a day against 1,440.

**Empty files.** A symbol that listed and never traded leaves a **zero-byte** file, not a valid gzip;
it is empty and skipped.

### okx

**Every dataset spills back**: a day or month file is a UTC+8 period, so the file dated
2020-06-15 holds 06-14 16:00 → 06-15 15:59 UTC — the same cut as bitget's
([STOCKER.md](STOCKER.md#venues-whose-buckets-do-not-cut-at-utc-midnight)).

**Duplicated bars.** Candlestick files can repeat rows byte for byte: 96 of 200 sampled 2020 spot
files repeat every bar, 4 of 40 sampled 2023 perpetual files repeat a few. The series declares it
(`repeatsRows`), and exact repeats are written once.

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

**klines** — an **XLSX inside the `.zip`**: `timestamp, open, high, low, close, basevolume,
usdtvolume` → OHLC, `volume = basevolume`, `quoteVolume = usdtvolume`. Two layouts are served and
both are read; they interleave within a month, never holding the same day twice. The older writes
`baseVolume`/`usdtVolume` and full float expansions, the newer lowercase and the shortest float —
the same data, folded by a case-insensitive union by name. No interval is named; `timestamp` steps by
60,000, so the series declares `1m`.

**quotes** (`depth`) — XLSX: `timestamp, bid_price, bid_volume, ask_price, ask_volume`. A missing
quote is **`-999999`**, mapped to NULL — cast to a number before comparing, since sizes exceed 2^31
and carry decimals.

## Known discrepancies with the catalog

- **Linear and inverse contracts** share one canonical key, so a partition mixes their formats —
  see [telling formats apart](#telling-formats-apart-inside-one-partition).
- **bitget `future`** and **htx `future`** are read with their perpetuals' formats. Neither has been
  seen in a file yet.
