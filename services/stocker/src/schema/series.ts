import type { Series } from '../types';

/**
 * How to read every series stocker knows about.
 *
 * **Every entry here was written from a decoded file.** The shapes came from
 * probing one real file at each end of every dataset's history, and the
 * semantics a file cannot state — which of Gate's `1`/`2` means "buy", whether
 * a size is base or quote — were settled by arithmetic over real rows. Where
 * neither was possible the field is left out rather than guessed.
 *
 * Two shapes of entry, because the sources come in two shapes:
 *
 * - A file whose header can be trusted for the whole of its history is mapped
 *   **by name**, so a column appended later shifts nothing.
 * - Everything else declares every column in published order. That covers files
 *   that never had a header, and equally files that *grew* one partway through
 *   — nine Binance futures datasets did, between 2021-01 and 2022-07. Read
 *   positionally both eras are one shape, and the stray header line resolves to
 *   a NULL timestamp and is dropped by the build.
 *
 * No timestamp units are declared anywhere: the unit follows from the value, so
 * Binance spot switching milliseconds → microseconds at 2025-01 needs no entry.
 *
 * `match` runs against a raw path relative to the venue root and must capture
 * `symbol`; where a table needs a level below `symbol=` it also captures
 * `interval`. A path matching nothing is skipped in silence — trucker
 * deliberately collects more than stocker normalises, and order books are not
 * mapped here at all: they are an event log with a shape of their own.
 */

// ── Column orders for the positional sources ──────────────────────────────────

const drop = { as: null };
const col  = (as: string) => ({ as });

/** Binance spot trades: headerless for the whole archive. */
const BINANCE_SPOT_TRADE = [
  col('id'), col('price'), col('qty'), col('quoteQty'),
  col('rawTs'), col('buyerMaker'), drop,
];

/**
 * Binance futures trades. The fourth column is the *other* leg of the size and
 * differs by margining: USD-margined publishes `quote_qty`, coin-margined
 * `base_qty`. Same position, opposite meaning, so they are separate entries.
 */
const BINANCE_UM_TRADE = [
  col('id'), col('price'), col('qty'), col('quoteQty'), col('rawTs'), col('buyerMaker'),
];

const BINANCE_CM_TRADE = [
  col('id'), col('price'), col('qty'), col('baseQty'), col('rawTs'), col('buyerMaker'),
];

/**
 * Twelve columns on every market and every kline variant. The seventh is
 * Binance's `close_time`, dropped rather than carried — see `tables.ts` — and
 * the last is theirs.
 */
const BINANCE_KLINE = [
  col('rawTs'), col('open'), col('high'), col('low'), col('close'), col('volume'),
  drop, col('quoteVolume'), col('trades'),
  col('takerBuyVolume'), col('takerBuyQuote'), drop,
];

const GATE_SPOT_DEAL = [col('rawTs'), col('id'), col('price'), col('size'), col('side')];
const GATE_FUT_TRADE = [col('rawTs'), col('id'), col('price'), col('size')];

/**
 * Gate candlesticks are `close, high, low, open` — **open and close are the
 * reverse of the obvious reading**, and high/low are consistent under both, so
 * nothing about a single bar reveals it.
 *
 * Settled by bar alignment across intervals: for `BTC_USDT` at 1780272000 the
 * 1m, 5m, 1h and 1d files all carry 73648.8 in the last column and four
 * different values in the third. Bars sharing a start share an open and differ
 * in close, so the last column is the open.
 */
const GATE_CANDLE = [
  col('rawTs'), col('volume'), col('close'), col('high'), col('low'), col('open'),
];

/** Three prices per row; only the first is identified, so the others are dropped. */
const GATE_MARK = [col('rawTs'), col('price'), drop, drop];

const GATE_FUNDING_APPLY  = [col('rawTs'), col('rate')];
const GATE_FUNDING_UPDATE = [col('rawTs'), col('rate'), drop, drop, drop, drop, drop, drop];

// ── Shared expressions ────────────────────────────────────────────────────────

/**
 * The taker's side, lowercased. Bybit publishes `Buy`, KuCoin `BUY`, and OKX
 * both `BUY` and `buy` depending on the year.
 */
const SIDE = `lower(side)`;

/**
 * Binance names no side. `is_buyer_maker` is the same fact inverted: if the
 * buyer was the maker then the taker sold.
 *
 * Verified on 400,000 real trades — with the flag false the next trade's price
 * rose 62,411 times against 364 falls, and mirrored when true.
 */
const BINANCE_SIDE  = `CASE WHEN lower(CAST(buyerMaker AS VARCHAR)) IN ('true', '1') ` +
  `THEN 'sell' ELSE 'buy' END`;
const BINANCE_MAKER = `lower(CAST(buyerMaker AS VARCHAR)) IN ('true', '1')`;

/**
 * Gate spot encodes the side as `1`/`2` and documents neither.
 *
 * Settled by price impact over 7.5M trades on `BTC_USDT`: side 1 is followed by
 * an uptick 1,634,647 times against 187,241 downticks, and side 2 mirrors it.
 * A taker buy lifts the offer, so 1 is a buy.
 */
const GATE_SPOT_SIDE = `CASE WHEN trim(side) = '1' THEN 'buy' ` +
  `WHEN trim(side) = '2' THEN 'sell' END`;

/**
 * Gate futures carry no side column at all — the sign of the size is the side.
 * Same test, same answer: negative sizes are followed by downticks, on both
 * `futures_usdt` and `futures_btc`.
 *
 * The sign is direction, not magnitude, so `size` is published unsigned and the
 * direction moves into `side`, where every other venue keeps it.
 */
const GATE_FUT_SIDE = `CASE WHEN TRY_CAST(size AS DOUBLE) < 0 THEN 'sell' ELSE 'buy' END`;
const GATE_FUT_SIZE = `abs(TRY_CAST(size AS DOUBLE))`;

/**
 * Bitget publishes a missing quote as **-999999**, a sentinel that has to
 * become NULL or every spread computed from this venue is wrong.
 *
 * **Cast before comparing.** `nullif(bid_volume, -999999)` reads naturally and
 * is a trap: every column is VARCHAR by design, the literal is an INTEGER, so
 * DuckDB coerces the *column* to INT32 to compare them — and that throws on any
 * value past 2^31 or carrying a decimal point. Real rows are both:
 * `2656014739` and `3596970534.21`. Wrapping the result in `TRY_CAST` cannot
 * save it, because the failure happens inside its argument.
 */
const quote = (column: string): string =>
  `nullif(TRY_CAST(${column} AS DOUBLE), -999999)`;

const OHLC  = { open: 'open', high: 'high', low: 'low', close: 'close' };
const OHLCV = { ...OHLC, volume: 'volume' };

const BINANCE_KLINE_COLUMNS = {
  ...OHLCV, quoteVolume: 'quoteVolume', trades: 'trades',
  takerBuyVolume: 'takerBuyVolume', takerBuyQuote: 'takerBuyQuote',
};

const zip  = { container: 'zip',  format: 'csv' } as const;
const gz   = { container: 'gzip', format: 'csv' } as const;
const xlsx = { container: 'zip',  format: 'xlsx' } as const;

export const SERIES: Series[] = [
  // ── Binance ─────────────────────────────────────────────────────────────────
  //
  // Spot files have never carried a header. Futures files gained one between
  // 2021-01 and 2022-07 depending on the dataset, so all of them are read
  // positionally and the header line is dropped as an unparseable timestamp.
  {
    source: 'trucker', venue: 'binance', table: 'trades', market: 'spot', ...zip,
    match: /^spot\/(?:daily|monthly)\/trades\/(?<symbol>[^/]+)\//,
    header: false, columns: BINANCE_SPOT_TRADE,
    project: {
      tradeId: 'id', price: 'price', size: 'qty', baseSize: 'qty',
      quoteSize: 'quoteQty', side: BINANCE_SIDE, buyerMaker: BINANCE_MAKER,
    },
    ts: 'rawTs',
  },
  {
    source: 'trucker', venue: 'binance', table: 'trades', market: 'perp', ...zip,
    match: /^futures\/um\/(?:daily|monthly)\/trades\/(?<symbol>[^/]+)\//,
    header: false, columns: BINANCE_UM_TRADE,
    project: {
      tradeId: 'id', price: 'price', size: 'qty', baseSize: 'qty',
      quoteSize: 'quoteQty', side: BINANCE_SIDE, buyerMaker: BINANCE_MAKER,
    },
    ts: 'rawTs',
  },
  // Coin-margined size is a contract count; `base_qty` is the coin amount it
  // settles, so that is the base leg and `qty` is neither base nor quote.
  {
    source: 'trucker', venue: 'binance', table: 'trades', market: 'perp', ...zip,
    match: /^futures\/cm\/(?:daily|monthly)\/trades\/(?<symbol>[^/]+)\//,
    header: false, columns: BINANCE_CM_TRADE,
    project: {
      tradeId: 'id', price: 'price', size: 'qty', baseSize: 'baseQty',
      side: BINANCE_SIDE, buyerMaker: BINANCE_MAKER,
    },
    ts: 'rawTs',
  },
  {
    source: 'trucker', venue: 'binance', table: 'klines', market: 'spot', ...zip,
    match: /^spot\/(?:daily|monthly)\/klines\/(?<symbol>[^/]+)\/(?<interval>[^/]+)\//,
    header: false, columns: BINANCE_KLINE, project: BINANCE_KLINE_COLUMNS, ts: 'rawTs',
  },
  {
    source: 'trucker', venue: 'binance', table: 'klines', market: 'perp', ...zip,
    match: /^futures\/(?:um|cm)\/(?:daily|monthly)\/klines\/(?<symbol>[^/]+)\/(?<interval>[^/]+)\//,
    header: false, columns: BINANCE_KLINE, project: BINANCE_KLINE_COLUMNS, ts: 'rawTs',
  },
  // Mark, index and premium klines reuse the kline shape but bin a reference
  // price rather than a traded tape — volume is always zero and `count` is a
  // sample count. Same file shape, different data, so different tables.
  {
    source: 'trucker', venue: 'binance', table: 'markPrice', market: 'perp', ...zip,
    match: /^futures\/(?:um|cm)\/(?:daily|monthly)\/markPriceKlines\/(?<symbol>[^/]+)\/(?<interval>[^/]+)\//,
    header: false, columns: BINANCE_KLINE, project: OHLC, ts: 'rawTs',
  },
  {
    source: 'trucker', venue: 'binance', table: 'indexPrice', market: 'perp', ...zip,
    match: /^futures\/(?:um|cm)\/(?:daily|monthly)\/indexPriceKlines\/(?<symbol>[^/]+)\/(?<interval>[^/]+)\//,
    header: false, columns: BINANCE_KLINE, project: OHLC, ts: 'rawTs',
  },
  {
    source: 'trucker', venue: 'binance', table: 'premiumIndex', market: 'perp', ...zip,
    match: /^futures\/(?:um|cm)\/(?:daily|monthly)\/premiumIndexKlines\/(?<symbol>[^/]+)\/(?<interval>[^/]+)\//,
    header: false, columns: BINANCE_KLINE, project: OHLC, ts: 'rawTs',
  },
  {
    source: 'trucker', venue: 'binance', table: 'funding', market: 'perp', ...zip,
    match: /^futures\/(?:um|cm)\/(?:daily|monthly)\/fundingRate\/(?<symbol>[^/]+)\//,
    header: true,
    kind: 'realised',
    project: { rate: 'last_funding_rate', intervalHours: 'funding_interval_hours' },
    ts: 'calc_time',
  },
  {
    source: 'trucker', venue: 'binance', table: 'quotes', market: 'perp', ...zip,
    match: /^futures\/(?:um|cm)\/(?:daily|monthly)\/bookTicker\/(?<symbol>[^/]+)\//,
    header: true,
    project: { bidPrice: 'best_bid_price', bidSize: 'best_bid_qty',
      askPrice: 'best_ask_price', askSize: 'best_ask_qty' },
    ts: 'transaction_time',
  },
  // `timestamp` here is a datetime string (`2026-07-29 00:00:01`), not an epoch.
  {
    source: 'trucker', venue: 'binance', table: 'depthBands', market: 'perp', ...zip,
    match: /^futures\/(?:um|cm)\/(?:daily|monthly)\/bookDepth\/(?<symbol>[^/]+)\//,
    header: true,
    project: { percentage: 'percentage', depth: 'depth', notional: 'notional' },
    ts: 'timestamp',
  },
  // `create_time` is likewise a datetime string.
  {
    source: 'trucker', venue: 'binance', table: 'openInterest', market: 'perp', ...zip,
    match: /^futures\/(?:um|cm)\/(?:daily|monthly)\/metrics\/(?<symbol>[^/]+)\//,
    header: true,
    project: { openInterest: 'sum_open_interest', openInterestValue: 'sum_open_interest_value',
      longShortRatio: 'count_long_short_ratio',
      takerLongShortVol: 'sum_taker_long_short_vol_ratio' },
    ts: 'create_time',
  },
  {
    source: 'trucker', venue: 'binance', table: 'liquidations', market: 'perp', ...zip,
    match: /^futures\/cm\/(?:daily|monthly)\/liquidationSnapshot\/(?<symbol>[^/]+)\//,
    header: true,
    project: { side: SIDE, price: 'price', size: 'original_quantity',
      averagePrice: 'average_price', status: 'order_status' },
    ts: 'time',
  },

  // ── Bybit ───────────────────────────────────────────────────────────────────
  //
  // Headers throughout, which is what absorbed the `RPI` column both trade
  // datasets gained in 2025-04 without an entry here changing.
  //
  // `size` is base for USDT and PERP symbols and **quote** for the `USD`
  // inverse ones — checked across 160 symbols by testing `foreignNotional`
  // against `size × price` and `size ÷ price`. That turns on the symbol rather
  // than on anything in the file, so neither leg is claimed here.
  {
    source: 'trucker', venue: 'bybit', table: 'trades', market: 'perp', ...gz,
    match: /^trading\/(?<symbol>[^/]+)\//,
    header: true,
    project: { tradeId: 'trdMatchID', price: 'price', size: 'size', side: SIDE },
    ts: 'timestamp',
  },
  {
    source: 'trucker', venue: 'bybit', table: 'trades', market: 'spot', ...gz,
    match: /^spot\/(?<symbol>[^/]+)\//,
    header: true,
    project: { tradeId: 'id', price: 'price', size: 'volume', side: SIDE },
    ts: 'timestamp',
  },
  // Both ended in 2020-03 and never resumed. `period` is the bar length in
  // minutes; every file published used 1.
  // MT4 klines are headerless, dated `2024.11.01 00:00`, and name the bar length
  // in minutes between two underscores. The filename carries a *range* rather
  // than a date, but the range is always exactly one calendar month, so the
  // period it belongs to is not in doubt.
  {
    source: 'trucker', venue: 'bybit', table: 'klines', market: 'perp', ...gz,
    match: /^kline_for_metatrader4\/(?<symbol>[^/]+)\/\d{4}\/[^/]+_(?<interval>\d+)_/,
    header: false,
    columns: [col('rawTs'), col('open'), col('high'), col('low'), col('close'), col('volume')],
    project: OHLCV, ts: 'rawTs',
  },
  {
    source: 'trucker', venue: 'bybit', table: 'premiumIndex', market: 'perp', ...gz,
    match: /^premium_index\/(?<symbol>[^/]+)\//,
    header: true, project: OHLC, ts: 'start_at',
  },
  {
    source: 'trucker', venue: 'bybit', table: 'indexPrice', market: 'spot', ...gz,
    match: /^spot_index\/(?<symbol>[^/]+)\//,
    header: true, project: OHLC, ts: 'start_at',
  },

  // ── KuCoin ──────────────────────────────────────────────────────────────────
  {
    source: 'trucker', venue: 'kucoin', table: 'trades', market: 'spot', ...zip,
    match: /^spot\/daily\/trades\/(?<symbol>[^/]+)\//,
    header: true,
    project: { tradeId: 'trade_id', price: 'price', size: 'size', baseSize: 'size',
      side: SIDE },
    ts: 'trade_time',
  },
  // Futures size is a contract count, so it is not the base amount.
  {
    source: 'trucker', venue: 'kucoin', table: 'trades', market: 'perp', ...zip,
    match: /^futures\/daily\/trades\/(?<symbol>[^/]+)\//,
    header: true,
    project: { tradeId: 'trade_id', price: 'price', size: 'size', side: SIDE },
    ts: 'trade_time',
  },
  // Spot klines are `open, close, high, low` — close **before** high, unlike
  // every other venue here and unlike KuCoin's own futures klines below.
  {
    source: 'trucker', venue: 'kucoin', table: 'klines', market: 'spot', ...zip,
    match: /^spot\/daily\/klines\/(?<symbol>[^/]+)\/(?<interval>[^/]+)\//,
    header: true, project: { ...OHLCV, quoteVolume: 'turnover' }, ts: 'time',
  },
  {
    source: 'trucker', venue: 'kucoin', table: 'klines', market: 'perp', ...zip,
    match: /^futures\/daily\/klines\/(?<symbol>[^/]+)\/(?<interval>[^/]+)\//,
    header: true, project: OHLCV, ts: 'time',
  },
  {
    source: 'trucker', venue: 'kucoin', table: 'funding', market: 'perp', ...zip,
    match: /^futures\/daily\/fundingRates\/(?<symbol>[^/]+)\//,
    kind: 'realised',
    header: true, project: { rate: 'fundingRate' }, ts: 'time',
  },
  {
    source: 'trucker', venue: 'kucoin', table: 'indexPrice', market: 'perp', ...zip,
    match: /^futures\/daily\/index\/(?<symbol>[^/]+)\/(?<interval>[^/]+)\//,
    header: true, project: OHLC, ts: 'time',
  },
  {
    source: 'trucker', venue: 'kucoin', table: 'markPrice', market: 'perp', ...zip,
    match: /^futures\/daily\/mark\/(?<symbol>[^/]+)\/(?<interval>[^/]+)\//,
    header: true, project: OHLC, ts: 'time',
  },

  // ── HTX ─────────────────────────────────────────────────────────────────────
  //
  // Every file names the instrument in a column and repeats it in the path.
  // Klines are stamped in seconds and trades in milliseconds, which the
  // inferred unit handles without either being declared.
  {
    source: 'trucker', venue: 'htx', table: 'trades', market: 'spot', ...zip,
    match: /^spot\/daily\/trades\/(?<symbol>[^/]+)\//,
    header: true,
    project: { tradeId: 'tradeId', price: 'px', size: 'size', baseSize: 'size',
      side: SIDE },
    ts: 'ts',
  },
  {
    source: 'trucker', venue: 'htx', table: 'trades', market: 'perp', ...zip,
    match: /^futures\/daily\/trades\/(?<symbol>[^/]+)\//,
    header: true,
    project: { tradeId: 'tradeId', price: 'px', size: 'size', side: SIDE },
    ts: 'ts',
  },
  // `vol` is the base amount and `volCcyQuote` the quote — confirmed by
  // rebinning a day of trades into 1m buckets: all twelve populated bars
  // matched the published open, close and both volumes exactly.
  {
    source: 'trucker', venue: 'htx', table: 'klines', market: 'spot', ...zip,
    match: /^spot\/daily\/klines\/(?<symbol>[^/]+)\/(?<interval>[^/]+)\//,
    header: true,
    project: { ...OHLC, volume: 'vol', quoteVolume: 'volCcyQuote' }, ts: 'ts',
  },
  {
    source: 'trucker', venue: 'htx', table: 'klines', market: 'perp', ...zip,
    match: /^futures\/daily\/klines\/(?<symbol>[^/]+)\/(?<interval>[^/]+)\//,
    header: true,
    project: { ...OHLC, volume: 'vol', quoteVolume: 'volCcyQuote' }, ts: 'ts',
  },
  {
    source: 'trucker', venue: 'htx', table: 'funding', market: 'perp', ...zip,
    match: /^futures\/daily\/funding-rates\/(?<symbol>[^/]+)\//,
    kind: 'realised',
    header: true, project: { rate: 'fundingRate' }, ts: 'fundingTime',
  },
  {
    source: 'trucker', venue: 'htx', table: 'indexPrice', market: 'perp', ...zip,
    match: /^futures\/daily\/index-klines\/(?<symbol>[^/]+)\/(?<interval>[^/]+)\//,
    header: true, project: OHLC, ts: 'ts',
  },
  {
    source: 'trucker', venue: 'htx', table: 'markPrice', market: 'perp', ...zip,
    match: /^futures\/daily\/mark-klines\/(?<symbol>[^/]+)\/(?<interval>[^/]+)\//,
    header: true, project: OHLC, ts: 'ts',
  },

  // ── Gate ────────────────────────────────────────────────────────────────────
  //
  // Headerless throughout. Spot deals carry fractional seconds at microsecond
  // precision and list rows in **descending** order — which costs nothing, since
  // every partition is sorted by `ts` on the way out. Candles are whole seconds
  // and ascending, on both markets.
  {
    source: 'trucker', venue: 'gate', table: 'trades', market: 'spot', ...gz,
    match: /^spot\/deals\/\d{6}\/(?<symbol>.+?)-\d{6}\.csv\.gz$/,
    header: false, columns: GATE_SPOT_DEAL,
    project: { tradeId: 'id', price: 'price', size: 'size', baseSize: 'size',
      side: GATE_SPOT_SIDE },
    ts: 'rawTs',
  },
  {
    source: 'trucker', venue: 'gate', table: 'trades', market: 'perp', ...gz,
    match: /^futures_(?:usdt|btc)\/trades\/\d{6}\/(?<symbol>.+?)-\d{6}\.csv\.gz$/,
    header: false, columns: GATE_FUT_TRADE,
    project: { tradeId: 'id', price: 'price', size: GATE_FUT_SIZE, side: GATE_FUT_SIDE },
    ts: 'rawTs',
  },
  // Spot and futures candles are one shape, published under two roots. The
  // column order is the same six, confirmed on real rows by the only test a
  // headerless file allows — `high` is the largest and `low` the smallest of
  // the four prices in every row read.
  //
  // **`volume` is the base leg on spot, as it is on futures**, so both project
  // through `OHLCV` unchanged. That was worth checking rather than assuming: a
  // venue publishing quote volume here would be silently wrong by the price.
  // Summing `spot/deals` over each hour reproduces the candle's volume exactly
  // — BTS_USDT 201812, to the last of six decimal places on every hour — while
  // the quote sum misses by a factor of the price.
  {
    source: 'trucker', venue: 'gate', table: 'klines', market: 'spot', ...gz,
    match: /^spot\/candlesticks_(?<interval>[^/]+)\/\d{6}\/(?<symbol>.+?)-\d{6}\.csv\.gz$/,
    header: false, columns: GATE_CANDLE, project: OHLCV, ts: 'rawTs',
  },
  {
    source: 'trucker', venue: 'gate', table: 'klines', market: 'perp', ...gz,
    match: /^futures_(?:usdt|btc)\/candlesticks_(?<interval>[^/]+)\/\d{6}\/(?<symbol>.+?)-\d{6}\.csv\.gz$/,
    header: false, columns: GATE_CANDLE, project: OHLCV, ts: 'rawTs',
  },
  {
    source: 'trucker', venue: 'gate', table: 'markPrice', market: 'perp', ...gz,
    match: /^futures_(?:usdt|btc)\/mark_prices\/\d{6}\/(?<symbol>.+?)-\d{6}\.csv\.gz$/,
    header: false, columns: GATE_MARK, project: { price: 'price' }, ts: 'rawTs',
  },
  // What was charged at the end of an interval, against the running estimate
  // for the next one — 3 rows a day against 1,440, and a forecast is not a
  // fact. `kind` is a path level, so these are two partitions rather than two
  // series racing to write one.
  {
    source: 'trucker', venue: 'gate', table: 'funding', market: 'perp', ...gz,
    match: /^futures_(?:usdt|btc)\/funding_applies\/\d{6}\/(?<symbol>.+?)-\d{6}\.csv\.gz$/,
    header: false, columns: GATE_FUNDING_APPLY,
    kind: 'realised',
    project: { rate: 'rate' }, ts: 'rawTs',
  },
  {
    source: 'trucker', venue: 'gate', table: 'funding', market: 'perp', ...gz,
    match: /^futures_(?:usdt|btc)\/funding_updates\/\d{6}\/(?<symbol>.+?)-\d{6}\.csv\.gz$/,
    header: false, columns: GATE_FUNDING_UPDATE,
    kind: 'predicted',
    project: { rate: 'rate' }, ts: 'rawTs',
  },

  // ── OKX ─────────────────────────────────────────────────────────────────────
  //
  // The symbol is in the filename rather than a directory, since OKX keys its
  // tree by date. All three instrument classes share one directory, so the two
  // qualified patterns must precede the bare spot one.
  {
    source: 'trucker', venue: 'okx', table: 'trades', market: 'perp', ...zip,
    match: /^trades\/(?:daily|monthly)\/\d+\/(?<symbol>[A-Z0-9-]+-SWAP)-trades-/,
    header: true,
    project: { tradeId: 'trade_id', price: 'price', size: 'size', side: SIDE },
    ts: 'created_time',
  },
  // A dated-futures file holds the whole expiry chain, so its rows carry
  // several instruments and the path symbol names the chain, not a contract.
  {
    source: 'trucker', venue: 'okx', table: 'trades', market: 'future', ...zip,
    match: /^trades\/(?:daily|monthly)\/\d+\/(?<symbol>[A-Z0-9-]+-futureschain)-trades-/,
    header: true,
    project: { tradeId: 'trade_id', price: 'price', size: 'size', side: SIDE },
    ts: 'created_time',
  },
  {
    source: 'trucker', venue: 'okx', table: 'trades', market: 'spot', ...zip,
    match: /^trades\/(?:daily|monthly)\/\d+\/(?<symbol>[A-Z0-9]+-[A-Z0-9]+)-trades-/,
    header: true,
    project: { tradeId: 'trade_id', price: 'price', size: 'size', baseSize: 'size',
      side: SIDE },
    ts: 'created_time',
  },
  // Candlesticks name no interval, at any level. The bars are a uniform 60
  // seconds apart — `open_time` steps by exactly 60000 across the file — so the
  // interval is recorded on the series rather than captured from the path.
  {
    source: 'trucker', venue: 'okx', table: 'klines', market: 'perp', ...zip,
    match: /^candlesticks\/(?:daily|monthly)\/\d+\/(?<symbol>[A-Z0-9-]+-SWAP)-candlesticks-/,
    header: true, interval: '1m',
    project: { ...OHLC, volume: 'vol', quoteVolume: 'vol_quote' }, ts: 'open_time',
  },
  {
    source: 'trucker', venue: 'okx', table: 'klines', market: 'future', ...zip,
    match: /^candlesticks\/(?:daily|monthly)\/\d+\/(?<symbol>[A-Z0-9-]+-futureschain)-candlesticks-/,
    header: true, interval: '1m',
    project: { ...OHLC, volume: 'vol', quoteVolume: 'vol_quote' }, ts: 'open_time',
  },
  {
    source: 'trucker', venue: 'okx', table: 'klines', market: 'spot', ...zip,
    match: /^candlesticks\/(?:daily|monthly)\/\d+\/(?<symbol>[A-Z0-9]+-[A-Z0-9]+)-candlesticks-/,
    header: true, interval: '1m',
    project: { ...OHLC, volume: 'vol', quoteVolume: 'vol_quote' }, ts: 'open_time',
  },
  {
    source: 'trucker', venue: 'okx', table: 'funding', market: 'perp', ...zip,
    match: /^swaprates\/daily\/\d+\/(?<symbol>allswap)-fundingrates-/,
    kind: 'realised',
    header: true, project: { rate: 'funding_rate' }, ts: 'funding_time',
  },
  {
    source: 'trucker', venue: 'okx', table: 'borrowing', market: 'spot', ...zip,
    match: /^borrowrates\/daily\/\d+\/(?<symbol>allmargin)-borrowrates-/,
    header: true, project: { currency: 'currency_name', rate: 'borrow_rate' }, ts: 'time',
  },

  // ── Bitget ──────────────────────────────────────────────────────────────────
  //
  // A day is split across numbered parts, all of which land in one partition.
  // Trades are CSV; klines and depth are an **XLSX inside the same `.zip`**, so
  // the container says nothing about the format and each series declares it.
  //
  // **Buckets cut at 16:00 UTC** — midnight UTC+8 — so every series spills
  // `back`: a file named `20250101` opens at 2024-12-31 16:00 UTC. Verified on
  // spot trades (120 files sampled across 514 symbols and 2024→2026: zero rows
  // outside the shifted window, zero before it); declared venue-wide because a
  // dataset that turned out UTC-aligned would make the trait a no-op, not an
  // error. Timestamps themselves are plain epoch millis UTC — only which file
  // holds a row is shifted.
  //
  // Both size legs are published: `price × size(base)` reproduces
  // `volume(quote)` on every one of 6,531 rows checked.
  {
    source: 'trucker', venue: 'bitget', table: 'trades', market: 'spot', ...zip, spill: 'back',
    match: /^trades\/SPBL\/(?<symbol>[^/]+)\//,
    header: true,
    project: { tradeId: 'trade_id', price: 'price', size: '"size(base)"',
      baseSize: '"size(base)"', quoteSize: '"volume(quote)"', side: SIDE },
    ts: 'timestamp',
  },
  {
    source: 'trucker', venue: 'bitget', table: 'trades', market: 'perp', ...zip, spill: 'back',
    match: /^trades\/(?:UMCBL|DMCBL)\/(?<symbol>[^/]+)\//,
    header: true,
    project: { tradeId: 'trade_id', price: 'price', size: '"size(base)"',
      baseSize: '"size(base)"', quoteSize: '"volume(quote)"', side: SIDE },
    ts: 'timestamp',
  },
  // Klines name no interval, at any level. The bars are a uniform 60 seconds
  // apart, `timestamp` stepping by exactly 60000 where a bar is not missing, so
  // the interval is recorded on the series rather than captured from the path,
  // exactly as okx's candlesticks are below.
  //
  // **A kline without an interval is not data.** Every other column describes a
  // period the row does not name, so leaving it off does not make the partition
  // vaguer — it makes it unreadable.
  //
  // **Bitget published klines two ways and both are still served**, so each
  // pattern below carries both. The product is a directory in one and part of
  // the filename in the other:
  //
  //   kline/BTCUSDT/SP/20190801.zip
  //   kline/BTCUSDT/BTCUSDT_SP_1min_20180725.zip
  //
  // One dataset, two renderings — so they belong to one series rather than two,
  // and the symbol is taken from the directory either way. The filename repeats
  // it and the two never disagree, across all 48,277 files of the flat form.
  //
  // The layouts **interleave rather than overlap**: no date is served both ways,
  // but a single month is routinely split between them — BTCUSDT holds both for
  // every month of 201908–202009. So one partition reads both, and it has to.
  //
  // The flat form heads its columns `baseVolume`/`usdtVolume` where the nested
  // one writes `basevolume`/`usdtvolume`. That costs nothing: identifiers are
  // case-insensitive in DuckDB, so `UNION ALL BY NAME` folds the two spellings
  // into one column rather than leaving half the rows null — checked on a real
  // union of one sheet of each, 2,873 rows with a volume on every one.
  {
    source: 'trucker', venue: 'bitget', table: 'klines', market: 'spot', ...xlsx, spill: 'back',
    scattered: true,
    match: /^kline\/(?<symbol>[^/]+)\/(?:SP\/|[^/]+_SP_1min_)/,
    header: true, interval: '1m',
    project: { ...OHLC, volume: 'basevolume', quoteVolume: 'usdtvolume' }, ts: 'timestamp',
  },
  {
    source: 'trucker', venue: 'bitget', table: 'klines', market: 'perp', ...xlsx, spill: 'back',
    scattered: true,
    match: /^kline\/(?<symbol>[^/]+)\/(?:(?:UMCBL|DMCBL)\/|[^/]+_(?:UMCBL|DMCBL)_1min_)/,
    header: true, interval: '1m',
    project: { ...OHLC, volume: 'basevolume', quoteVolume: 'usdtvolume' }, ts: 'timestamp',
  },
  // "Depth" is best bid/ask over time, not a ladder. A missing quote is
  // published as **-999999**, a sentinel that has to become NULL or every
  // spread computed from this venue is wrong.
  {
    source: 'trucker', venue: 'bitget', table: 'quotes', market: 'spot', ...xlsx, spill: 'back',
    match: /^depth\/(?<symbol>[^/]+)\/1\//,
    header: true,
    project: {
      bidPrice: quote('bid_price'), bidSize: quote('bid_volume'),
      askPrice: quote('ask_price'), askSize: quote('ask_volume'),
    },
    ts: 'timestamp',
  },
  {
    source: 'trucker', venue: 'bitget', table: 'quotes', market: 'perp', ...xlsx, spill: 'back',
    match: /^depth\/(?<symbol>[^/]+)\/2\//,
    header: true,
    project: {
      bidPrice: quote('bid_price'), bidSize: quote('bid_volume'),
      askPrice: quote('ask_price'), askSize: quote('ask_volume'),
    },
    ts: 'timestamp',
  },
];

/**
 * Resolve a raw path to the series that explains it.
 *
 * Order matters where two patterns could both match: the first entry wins, so
 * the more specific must come first. OKX is the only place that happens — its
 * swap, dated-futures and spot trades share one directory and are told apart by
 * the instrument suffix, so the two qualified patterns precede the bare one.
 */
export const seriesFor = (
  venue: string,
  path:  string,
): { series: Series; symbol: string; interval?: string } | null => {
  for (const series of SERIES) {
    if (series.venue !== venue) continue;

    const m = series.match.exec(path);

    if (! m?.groups?.symbol) continue;

    return {
      series,
      symbol:   m.groups.symbol,
      interval: labelled(m.groups.interval) ?? series.interval,
    };
  }

  return null;
};

/**
 * An interval as every venue but one already writes it: `1m`, `4h`, `1d`.
 *
 * Bybit's MT4 klines are the exception, naming the bar length as a bare count
 * of minutes (`BTCUSDT_15_2024-02-01_2024-02-29`). Left alone that would put
 * `interval=15` beside `interval=15m` from every other venue, in the same
 * table, for the same thing. Converting anything numeric keeps one vocabulary
 * without a table of special cases.
 */
const labelled = (interval: string | undefined): string | undefined => {
  if (! interval || ! /^\d+$/.test(interval)) return interval;

  const minutes = Number(interval);

  if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)}d`;
  if (minutes % 60 === 0)        return `${minutes / 60}h`;

  return `${minutes}m`;
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_labelled = labelled;
