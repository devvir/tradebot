import { marginOf } from './margin';
import type { ArchiveFile, Series } from '../types';

/**
 * How to read every format stocker knows about.
 *
 * **Every entry here was written from a decoded file.** The shapes came from
 * probing real files at each end of every dataset's history, and the semantics
 * a file cannot state — which of Gate's `1`/`2` means "buy", whether a size is
 * base or quote — were settled by arithmetic over real rows. Where neither was
 * possible the field is left out rather than guessed. Every format, venue by
 * venue, is described in docs/services/STOCKER-PARTITIONS.md.
 *
 * **Keyed by what the catalog says a file is** — venue, market, dataset,
 * variant — and never by where the venue keeps it. Where one dataset holds more
 * than one format, an entry says which files it reads: by the instrument's
 * margining (`margin`), or by the months it holds for (`from`/`until`).
 *
 * Two shapes of entry, because the files come in two shapes:
 *
 * - A file whose header can be trusted for the whole of its history is mapped
 *   **by name**, so a column appended later shifts nothing.
 * - Everything else declares every column in published order. That covers files
 *   that never had a header, and equally files that *grew* one partway through
 *   — nine Binance futures datasets did, between 2021-01 and 2022-07. Read
 *   positionally both eras are one shape, and the stray header line resolves to
 *   a NULL timestamp and is dropped by the build.
 *
 * Timestamp units are never declared: the unit follows from the value. Where a
 * venue writes a local datetime, its zone is (`utcOffsetHours`).
 */

// ── Column orders for the positional formats ──────────────────────────────────

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
const GATE_TRADFI_CANDLE = [col('rawTs'), col('close'), col('high'), col('low'), col('open')];

/** Three prices per row; only the first is identified, so the others are dropped. */
const GATE_MARK = [col('rawTs'), col('price'), drop, drop];

const GATE_FUNDING_APPLY  = [col('rawTs'), col('rate')];
const GATE_FUNDING_UPDATE = [col('rawTs'), col('rate'), drop, drop, drop, drop, drop, drop];

/**
 * HTX before 2026-02-01: headerless, and shaped by market and margining.
 *
 * Read off the files on disk on 2026-10-04: spot trades carry five columns,
 * coin-margined contract trades six, USDT-margined seven — the seventh being the
 * quote turnover the coin-margined ones lack. Klines are seven on every market,
 * **open-close-high-low**, with the volumes meaning different things by market:
 * on spot `vol` is the quote amount and `amount` the base (868.87 ZEC against
 * 44,492 USDT at ~51), on contracts `vol` is the contract count and `amount` the
 * base coin.
 */
const HTX_OLD_SPOT_TRADE    = [col('id'), col('rawTs'), col('price'), col('base'), col('side')];
const HTX_OLD_INVERSE_TRADE = [col('id'), col('rawTs'), col('price'), col('contracts'), col('base'), col('side')];
const HTX_OLD_LINEAR_TRADE  = [
  col('id'), col('rawTs'), col('price'), col('contracts'), col('base'), col('quote'), col('side'),
];
const HTX_OLD_KLINE = [
  col('rawTs'), col('open'), col('close'), col('high'), col('low'), col('vol'), col('amount'),
];
const HTX_OLD_REFERENCE = [col('rawTs'), col('open'), col('close'), col('high'), col('low')];

/** The month HTX's newer export starts, and its older one stops. */
const HTX_CUT = '2026-02';

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
 * USDT- and BTC-settled contracts.
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

const csv  = { format: 'csv' }  as const;
const xlsx = { format: 'xlsx' } as const;

/** The klines-shaped datasets whose catalog variant is their interval. */
const REFERENCE = ['markPrice', 'indexPrice', 'premiumIndex'] as const;

export const SERIES: Series[] = [
  // ── Binance ─────────────────────────────────────────────────────────────────
  //
  // Spot files have never carried a header. Futures files gained one between
  // 2021-01 and 2022-07 depending on the dataset, so all of them are read
  // positionally and the header line is dropped as an unparseable timestamp.
  {
    venue: 'binance', market: 'spot', dataset: 'trades', variant: 'default', table: 'trades', ...csv,
    header: false, columns: BINANCE_SPOT_TRADE,
    project: {
      tradeId: 'id', price: 'price', size: 'qty', baseSize: 'qty',
      quoteSize: 'quoteQty', side: BINANCE_SIDE, buyerMaker: BINANCE_MAKER,
    },
    ts: 'rawTs',
  },
  {
    venue: 'binance', market: 'perp', dataset: 'trades', variant: 'default', table: 'trades', ...csv,
    margin: 'linear', header: false, columns: BINANCE_UM_TRADE,
    project: {
      tradeId: 'id', price: 'price', size: 'qty', baseSize: 'qty',
      quoteSize: 'quoteQty', side: BINANCE_SIDE, buyerMaker: BINANCE_MAKER,
    },
    ts: 'rawTs',
  },
  // Coin-margined size is a contract count; `base_qty` is the coin amount it
  // settles, so that is the base leg and `qty` is neither base nor quote.
  {
    venue: 'binance', market: 'perp', dataset: 'trades', variant: 'default', table: 'trades', ...csv,
    margin: 'inverse', header: false, columns: BINANCE_CM_TRADE,
    project: {
      tradeId: 'id', price: 'price', size: 'qty', baseSize: 'baseQty',
      side: BINANCE_SIDE, buyerMaker: BINANCE_MAKER,
    },
    ts: 'rawTs',
  },
  {
    venue: 'binance', market: 'spot', dataset: 'klines', variant: '*', table: 'klines', ...csv,
    header: false, columns: BINANCE_KLINE, project: BINANCE_KLINE_COLUMNS, ts: 'rawTs',
  },
  {
    venue: 'binance', market: 'perp', dataset: 'klines', variant: '*', table: 'klines', ...csv,
    header: false, columns: BINANCE_KLINE, project: BINANCE_KLINE_COLUMNS, ts: 'rawTs',
  },
  // Mark, index and premium klines reuse the kline shape but bin a reference
  // price rather than a traded tape — volume is always zero and `count` is a
  // sample count. Same file shape, different data, so different tables.
  ...REFERENCE.map((dataset): Series => ({
    venue: 'binance', market: 'perp', dataset, variant: '*', table: dataset, ...csv,
    header: false, columns: BINANCE_KLINE, project: OHLC, ts: 'rawTs',
  })),
  {
    venue: 'binance', market: 'perp', dataset: 'funding', variant: 'realised', table: 'funding', ...csv,
    header: true,
    project: { rate: 'last_funding_rate', intervalHours: 'funding_interval_hours' },
    ts: 'calc_time',
  },
  {
    venue: 'binance', market: 'perp', dataset: 'quotes', table: 'quotes', ...csv,
    header: true,
    project: { bidPrice: 'best_bid_price', bidSize: 'best_bid_qty',
      askPrice: 'best_ask_price', askSize: 'best_ask_qty' },
    ts: 'transaction_time',
  },
  // `timestamp` here is a datetime string (`2026-07-29 00:00:01`), not an epoch.
  {
    venue: 'binance', market: 'perp', dataset: 'depthBands', table: 'depthBands', ...csv,
    header: true,
    project: { percentage: 'percentage', depth: 'depth', notional: 'notional' },
    ts: 'timestamp',
  },
  // `create_time` is likewise a datetime string.
  {
    venue: 'binance', market: 'perp', dataset: 'openInterest', table: 'openInterest', ...csv,
    header: true,
    project: { openInterest: 'sum_open_interest', openInterestValue: 'sum_open_interest_value',
      longShortRatio: 'count_long_short_ratio',
      takerLongShortVol: 'sum_taker_long_short_vol_ratio' },
    ts: 'create_time',
  },
  ...(['perp', 'future'] as const).map((market): Series => ({
    venue: 'binance', market, dataset: 'liquidations', table: 'liquidations', ...csv,
    header: true,
    project: { side: SIDE, price: 'price', size: 'original_quantity',
      averagePrice: 'average_price', status: 'order_status' },
    ts: 'time',
  })),

  // ── Bybit ───────────────────────────────────────────────────────────────────
  //
  // Headers throughout, which is what absorbed the `RPI` column both trade
  // datasets gained in 2025-04 without an entry here changing.
  //
  // `size` is base for USDT and PERP symbols and **quote** for the `USD`
  // inverse ones — checked across 160 symbols by testing `foreignNotional`
  // against `size × price` and `size ÷ price` — so the leg it fills follows the
  // instrument's margining.
  {
    venue: 'bybit', market: 'perp', dataset: 'trades', table: 'trades', ...csv,
    margin: 'linear', header: true,
    project: { tradeId: 'trdMatchID', price: 'price', size: 'size', baseSize: 'size', side: SIDE },
    ts: 'timestamp',
  },
  {
    venue: 'bybit', market: 'perp', dataset: 'trades', table: 'trades', ...csv,
    margin: 'inverse', header: true,
    project: { tradeId: 'trdMatchID', price: 'price', size: 'size', quoteSize: 'size', side: SIDE },
    ts: 'timestamp',
  },
  {
    venue: 'bybit', market: 'spot', dataset: 'trades', table: 'trades', ...csv,
    header: true,
    project: { tradeId: 'id', price: 'price', size: 'volume', baseSize: 'volume', side: SIDE },
    ts: 'timestamp',
  },
  // An underlying's whole option book in one file a day, each row naming its
  // instrument (`BTC-4OCT26-84500-C-USDT`). The side is spelled `direction`, and
  // `amount` is the size as published; which leg it measures is not settled, so
  // neither is filled. The implied volatility and the index and mark prices
  // each row carries have no column in the trades table, and are not kept.
  {
    venue: 'bybit', market: 'option', dataset: 'trades', table: 'trades', ...csv,
    header: true, instrument: 'instrument_name',
    project: { tradeId: 'trade_id', price: 'price', size: 'amount', side: `lower(direction)` },
    ts: 'timestamp',
  },
  // MT4 klines: headerless, dated `2024.11.01 00:00` **in UTC+3** — the
  // MetaTrader server's zone, with no daylight-saving switch. Settled against
  // the perpetual trades: BTCUSDT's 1h bars equal the trades summed per hour on
  // every hour of 2020-10 and 2020-12, and only three hours apart. Each file is
  // a UTC+3 month, so its head is the previous UTC month's last three hours:
  // the files spill back.
  {
    venue: 'bybit', market: 'perp', dataset: 'klines', variant: '*', table: 'klines', ...csv,
    header: false,
    columns: [col('rawTs'), col('open'), col('high'), col('low'), col('close'), col('volume')],
    project: OHLCV, ts: 'rawTs', utcOffsetHours: 3, spill: 'back',
  },
  {
    venue: 'bybit', market: 'perp', dataset: 'premiumIndex', variant: '*', table: 'premiumIndex', ...csv,
    header: true, project: OHLC, ts: 'start_at',
  },
  {
    venue: 'bybit', market: 'spot', dataset: 'indexPrice', variant: '*', table: 'indexPrice', ...csv,
    header: true, project: OHLC, ts: 'start_at',
  },

  // ── KuCoin ──────────────────────────────────────────────────────────────────
  {
    venue: 'kucoin', market: 'spot', dataset: 'trades', table: 'trades', ...csv,
    header: true,
    project: { tradeId: 'trade_id', price: 'price', size: 'size', baseSize: 'size', side: SIDE },
    ts: 'trade_time',
  },
  // Futures size is a contract count, so it is not the base amount.
  {
    venue: 'kucoin', market: 'perp', dataset: 'trades', table: 'trades', ...csv,
    header: true,
    project: { tradeId: 'trade_id', price: 'price', size: 'size', side: SIDE },
    ts: 'trade_time',
  },
  // Spot klines are `open, close, high, low` — close **before** high, unlike
  // every other venue here and unlike KuCoin's own futures klines below.
  {
    venue: 'kucoin', market: 'spot', dataset: 'klines', variant: '*', table: 'klines', ...csv,
    header: true, project: { ...OHLCV, quoteVolume: 'turnover' }, ts: 'time',
  },
  {
    venue: 'kucoin', market: 'perp', dataset: 'klines', variant: '*', table: 'klines', ...csv,
    header: true, project: OHLCV, ts: 'time',
  },
  {
    venue: 'kucoin', market: 'perp', dataset: 'funding', variant: 'realised', table: 'funding', ...csv,
    header: true, project: { rate: 'fundingRate' }, ts: 'time',
  },
  {
    venue: 'kucoin', market: 'perp', dataset: 'indexPrice', variant: '*', table: 'indexPrice', ...csv,
    header: true, project: OHLC, ts: 'time',
  },
  {
    venue: 'kucoin', market: 'perp', dataset: 'markPrice', variant: '*', table: 'markPrice', ...csv,
    header: true, project: OHLC, ts: 'time',
  },

  // ── HTX ─────────────────────────────────────────────────────────────────────
  //
  // Two exports, cut flat at 2026-02-01: headerless before, headed from it. The
  // later one names the instrument in a column and repeats it in the path;
  // its klines are stamped in seconds and its trades in milliseconds, which the
  // inferred unit handles without either being declared.
  //
  // **Buckets cut at 16:00 UTC** — midnight UTC+8 — in both exports, so every
  // dataset spills `back`: the 2020-06-15 trade and kline files hold
  // 06-14 16:00 → 06-15 15:59 UTC, and the 2026-07-29 ones open at 07-28 16:00.
  {
    venue: 'htx', market: 'spot', dataset: 'trades', table: 'trades', ...csv, spill: 'back',
    until: HTX_CUT, header: false, columns: HTX_OLD_SPOT_TRADE,
    project: { tradeId: 'id', price: 'price', size: 'base', baseSize: 'base', side: SIDE },
    ts: 'rawTs',
  },
  ...(['perp', 'future'] as const).flatMap((market): Series[] => [
    {
      venue: 'htx', market, dataset: 'trades', table: 'trades', ...csv, spill: 'back',
      until: HTX_CUT, margin: 'inverse', header: false, columns: HTX_OLD_INVERSE_TRADE,
      project: { tradeId: 'id', price: 'price', size: 'contracts', baseSize: 'base', side: SIDE },
      ts: 'rawTs',
    },
    {
      venue: 'htx', market, dataset: 'trades', table: 'trades', ...csv, spill: 'back',
      until: HTX_CUT, margin: 'linear', header: false, columns: HTX_OLD_LINEAR_TRADE,
      project: { tradeId: 'id', price: 'price', size: 'contracts', baseSize: 'base',
        quoteSize: 'quote', side: SIDE },
      ts: 'rawTs',
    },
  ]),
  // Options were USDT-margined throughout (`BTC-USDT-201225-C-13000`), and their
  // trades are the linear contract shape column for column: contracts, base and
  // turnover, where turnover is the premium paid — price × base on every row
  // read. They stopped in 2021-06, so there is no later export of them.
  {
    venue: 'htx', market: 'option', dataset: 'trades', table: 'trades', ...csv, spill: 'back',
    until: HTX_CUT, header: false, columns: HTX_OLD_LINEAR_TRADE,
    project: { tradeId: 'id', price: 'price', size: 'contracts', baseSize: 'base',
      quoteSize: 'quote', side: SIDE },
    ts: 'rawTs',
  },
  {
    venue: 'htx', market: 'spot', dataset: 'klines', variant: '*', table: 'klines', ...csv, spill: 'back',
    until: HTX_CUT, header: false, columns: HTX_OLD_KLINE,
    project: { ...OHLC, volume: 'amount', quoteVolume: 'vol' }, ts: 'rawTs',
  },
  // On the days checked, `vol` and `amount` are exactly twice the day's trades
  // summed per minute, on every minute that traded: 1,438 of 1,438 on
  // `BTC-USDT` and 1,440 of 1,440 on `BTC-USD` for 2020-11-14, and every traded
  // minute of two option days of that month. Whether that holds elsewhere, and
  // why, is not known. They are stored as published.
  ...(['perp', 'future', 'option'] as const).map((market): Series => ({
    venue: 'htx', market, dataset: 'klines', variant: '*', table: 'klines', ...csv, spill: 'back',
    until: HTX_CUT, header: false, columns: HTX_OLD_KLINE,
    project: { ...OHLC, volume: 'vol' }, ts: 'rawTs',
  })),
  ...(['indexPrice', 'markPrice'] as const).map((dataset): Series => ({
    venue: 'htx', market: 'perp', dataset, variant: '*', table: dataset, ...csv, spill: 'back',
    until: HTX_CUT, header: false, columns: HTX_OLD_REFERENCE, project: OHLC, ts: 'rawTs',
  })),
  // Dated futures publish a mark price and no index. The same five columns in
  // the same order, read by position — and **some of these files do carry a
  // header**, `id,open,close,high,low`, where others of the same years do not
  // (`ADA210702` of 2021-07-02 has one, `BTC-USDT-230714` of 2023-07-14 none).
  // Read by position either way: a header line is a row whose timestamp does
  // not parse, and is dropped as every such row is.
  {
    venue: 'htx', market: 'future', dataset: 'markPrice', variant: '*', table: 'markPrice', ...csv, spill: 'back',
    until: HTX_CUT, header: false, columns: HTX_OLD_REFERENCE, project: OHLC, ts: 'rawTs',
  },
  {
    venue: 'htx', market: 'spot', dataset: 'trades', table: 'trades', ...csv, spill: 'back',
    from: HTX_CUT, header: true,
    project: { tradeId: 'tradeId', price: 'px', size: 'size', baseSize: 'size', side: SIDE },
    ts: 'ts',
  },
  ...(['perp', 'future'] as const).map((market): Series => ({
    venue: 'htx', market, dataset: 'trades', table: 'trades', ...csv, spill: 'back',
    from: HTX_CUT, header: true,
    project: { tradeId: 'tradeId', price: 'px', size: 'size', side: SIDE },
    ts: 'ts',
  })),
  // `vol` is the base amount on spot and the contract count on perpetuals, and
  // `volCcyQuote` the quote — confirmed by rebinning a day of trades into 1m
  // buckets: all twelve populated bars matched the published open, close and
  // both volumes exactly.
  ...(['spot', 'perp', 'future'] as const).map((market): Series => ({
    venue: 'htx', market, dataset: 'klines', variant: '*', table: 'klines', ...csv, spill: 'back',
    from: HTX_CUT, header: true,
    project: { ...OHLC, volume: 'vol', quoteVolume: 'volCcyQuote' }, ts: 'ts',
  })),
  {
    venue: 'htx', market: 'perp', dataset: 'funding', variant: 'realised', table: 'funding', ...csv, spill: 'back',
    from: HTX_CUT, header: true, project: { rate: 'fundingRate' }, ts: 'fundingTime',
  },
  ...(['indexPrice', 'markPrice'] as const).map((dataset): Series => ({
    venue: 'htx', market: 'perp', dataset, variant: '*', table: dataset, ...csv, spill: 'back',
    from: HTX_CUT, header: true, project: OHLC, ts: 'ts',
  })),
  {
    venue: 'htx', market: 'future', dataset: 'markPrice', variant: '*', table: 'markPrice', ...csv, spill: 'back',
    from: HTX_CUT, header: true, project: OHLC, ts: 'ts',
  },

  // ── Gate ────────────────────────────────────────────────────────────────────
  //
  // Headerless throughout. Spot deals carry fractional seconds at microsecond
  // precision and list rows in **descending** order — which costs nothing, since
  // every file is sorted by `ts` on the way out. Candles are whole seconds and
  // ascending, on both markets.
  {
    venue: 'gate', market: 'spot', dataset: 'trades', table: 'trades', ...csv,
    header: false, columns: GATE_SPOT_DEAL,
    project: { tradeId: 'id', price: 'price', size: 'size', baseSize: 'size',
      side: GATE_SPOT_SIDE },
    ts: 'rawTs',
  },
  {
    venue: 'gate', market: 'perp', dataset: 'trades', table: 'trades', ...csv,
    header: false, columns: GATE_FUT_TRADE,
    project: { tradeId: 'id', price: 'price', size: GATE_FUT_SIZE, side: GATE_FUT_SIDE },
    ts: 'rawTs',
  },
  // Spot and futures candles are one shape. **`volume` is the base leg on spot,
  // as it is on futures** — summing `spot/deals` over each hour reproduces the
  // candle's volume exactly (BTS_USDT 201812, to the last of six decimal places
  // on every hour), while the quote sum misses by a factor of the price.
  ...(['spot', 'perp'] as const).map((market): Series => ({
    venue: 'gate', market, dataset: 'klines', variant: '*', table: 'klines', ...csv,
    header: false, columns: GATE_CANDLE, project: OHLCV, ts: 'rawTs',
  })),
  // Stocks and other tradfi instruments are candles without a volume: five
  // columns, the spot candle's less its second. Settled from the rows: the
  // third is each bar's highest value and the fourth its lowest, and the second
  // of one bar is the fifth of the next on every consecutive pair read (AAPL
  // 1m, 2024-01) — a close and the open that follows it. Stamped in plain UTC
  // seconds: AAPL's first 1m bar of a day is 14:30 UTC, the New York open.
  {
    venue: 'gate', market: 'tradfi', dataset: 'klines', variant: '*', table: 'klines', ...csv,
    header: false, columns: GATE_TRADFI_CANDLE, project: OHLC, ts: 'rawTs',
  },
  {
    venue: 'gate', market: 'perp', dataset: 'markPrice', variant: 'ticks', table: 'markPrice', ...csv,
    header: false, columns: GATE_MARK, project: { price: 'price' }, ts: 'rawTs',
  },
  // What was charged at the end of an interval, against the running estimate
  // for the next one — 3 rows a day against 1,440, and a forecast is not a
  // fact. `kind` is a path level, so these are two partitions.
  {
    venue: 'gate', market: 'perp', dataset: 'funding', variant: 'realised', table: 'funding', ...csv,
    header: false, columns: GATE_FUNDING_APPLY, project: { rate: 'rate' }, ts: 'rawTs',
  },
  {
    venue: 'gate', market: 'perp', dataset: 'funding', variant: 'predicted', table: 'funding', ...csv,
    header: false, columns: GATE_FUNDING_UPDATE, project: { rate: 'rate' }, ts: 'rawTs',
  },

  // ── OKX ─────────────────────────────────────────────────────────────────────
  //
  // Every row names its instrument, which matters twice: a dated-futures file
  // holds a whole expiry chain, and the daily `all…` files hold a whole market.
  // Either way the rows are split by it, one vault file per instrument.
  //
  // **Buckets cut at 16:00 UTC** — midnight UTC+8 — exactly as bitget's do, so
  // every dataset spills `back`. Read off the candlesticks on 2026-10-04: the
  // day file dated 2020-06-15 holds 06-14 16:00 → 06-15 15:59 UTC, and the
  // June file 05-31 16:00 → 06-30 15:59. Declared venue-wide, as bitget's is: a
  // dataset that turned out UTC-aligned would make the trait a no-op.
  // Options are the same files with the same columns: a family's whole chain
  // in one (`BTC-USD-optionchain`), or every option there is (`alloption`). The
  // price is the premium in the coin and `size` the contract count, as on the
  // other contracts.
  ...(['spot', 'perp', 'future', 'option'] as const).map((market): Series => ({
    venue: 'okx', market, dataset: 'trades', table: 'trades', ...csv, spill: 'back',
    header: true, instrument: 'instrument_name',
    project: market === 'spot'
      ? { tradeId: 'trade_id', price: 'price', size: 'size', baseSize: 'size', side: SIDE }
      : { tradeId: 'trade_id', price: 'price', size: 'size', side: SIDE },
    ts: 'created_time',
  })),
  // Candlesticks name no interval anywhere; the catalog files them as `1m`, and
  // the bars agree — `open_time` steps by exactly 60000 across a file.
  //
  // **Many files repeat every row**, byte for byte: of twelve 2020 spot files
  // sampled on 2026-10-04, seven held each bar twice (BTC-USDT's June monthly:
  // 86,400 rows, 43,200 bars). Exact repeats are dropped.
  //
  // The earliest option bars spell an absent volume `None`, which reads as no
  // value at all (`BTC-USD-optionchain`, 2021-09-01).
  ...(['spot', 'perp', 'future', 'option'] as const).map((market): Series => ({
    venue: 'okx', market, dataset: 'klines', variant: '*', table: 'klines', ...csv, spill: 'back',
    repeatsRows: true,
    header: true, instrument: 'instrument_name',
    project: { ...OHLC, volume: 'vol', quoteVolume: 'vol_quote' }, ts: 'open_time',
  })),
  {
    venue: 'okx', market: 'perp', dataset: 'funding', variant: 'realised', table: 'funding', ...csv,
    spill: 'back', header: true, instrument: 'instrument_name', project: { rate: 'funding_rate' }, ts: 'funding_time',
  },
  // Keyed by currency rather than instrument, so the currency is the "symbol".
  {
    venue: 'okx', market: 'spot', dataset: 'borrowing', table: 'borrowing', ...csv,
    spill: 'back', header: true, instrument: 'currency_name',
    project: { currency: 'currency_name', rate: 'borrow_rate' }, ts: 'time',
  },

  // ── Bitget ──────────────────────────────────────────────────────────────────
  //
  // A day is split across numbered parts. Trades are CSV; klines and depth are
  // an **XLSX inside the same `.zip`**, so the container says nothing about the
  // format and each entry declares it.
  //
  // **Buckets cut at 16:00 UTC** — midnight UTC+8 — so every dataset spills
  // `back`: a file dated `20250101` opens at 2024-12-31 16:00 UTC. Verified on
  // spot trades (120 files sampled across 514 symbols and 2024→2026: zero rows
  // outside the shifted window, zero before it). Timestamps themselves are
  // plain epoch millis UTC — only which file holds a row is shifted.
  //
  // Both size legs are published: `price × size(base)` reproduces
  // `volume(quote)` on every one of 6,531 rows checked.
  ...(['spot', 'perp', 'future'] as const).flatMap((market): Series[] => [
    {
      venue: 'bitget', market, dataset: 'trades', table: 'trades', ...csv, spill: 'back',
      header: true,
      project: { tradeId: 'trade_id', price: 'price', size: '"size(base)"',
        baseSize: '"size(base)"', quoteSize: '"volume(quote)"', side: SIDE },
      ts: 'timestamp',
    },
    // Klines name no interval at any level; the catalog files them as `1m` and
    // `timestamp` steps by exactly 60000 where a bar is not missing.
    //
    // **Two layouts are served and both are read** — they interleave within a
    // month, never holding the same day twice. The older writes
    // `baseVolume`/`usdtVolume`, the newer `basevolume`/`usdtvolume`;
    // identifiers are case-insensitive in DuckDB, so `UNION ALL BY NAME` folds
    // the two into one column.
    {
      venue: 'bitget', market, dataset: 'klines', variant: '*', table: 'klines', ...xlsx, spill: 'back',
      header: true,
      project: { ...OHLC, volume: 'basevolume', quoteVolume: 'usdtvolume' }, ts: 'timestamp',
    },
    // "Depth" is best bid/ask over time, not a ladder.
    {
      venue: 'bitget', market, dataset: 'quotes', table: 'quotes', ...xlsx, spill: 'back',
      header: true,
      project: {
        bidPrice: quote('bid_price'), bidSize: quote('bid_volume'),
        askPrice: quote('ask_price'), askSize: quote('ask_volume'),
      },
      ts: 'timestamp',
    },
  ]),
];

/**
 * Every entry that can read a dataset, whatever its margining or era — what a
 * partition's identity depends on, and what decides which datasets are listed.
 */
export const seriesOf = (
  file: { venue: string; market: string; dataset: string; variant: string },
): Series[] => SERIES.filter(series =>
  series.venue === file.venue && series.market === file.market &&
  series.dataset === file.dataset && variantMatches(series, file.variant));

/**
 * The one entry that reads a file, or null when none does.
 *
 * Margining is asked of the file's own symbol — of the instrument, not of the
 * partition, since a partition holds every instrument of its market. The era is
 * the file's month.
 *
 * **More than one answer is a mistake in the map**, never a choice to make, so
 * it throws: two entries claiming a file would read it two ways depending on
 * their order.
 */
export const seriesFor = (file: ArchiveFile): Series | null => {
  const margin  = marginOf(file.venue, file.market, file.symbol);
  const matches = seriesOf(file).filter(series =>
    (! series.margin || series.margin === margin) &&
    (! series.from  || file.month >= series.from) &&
    (! series.until || file.month <  series.until));

  if (matches.length > 1)
    throw new Error(`${matches.length} series claim ${file.key} — the map is ambiguous`);

  return matches[0] ?? null;
};

/**
 * The levels a vault path carries below `dataset=`, from the catalog's variant.
 *
 * **Which ones is a property of the table, never of the venue.** A kline and
 * the reference-price bars carry their interval; funding carries its kind.
 * `ticks` is not an interval — it is a stream of point values — and carries
 * none. Everything else carries nothing, whatever the catalog's variant says
 * (`default` trades are just trades).
 */
export const extrasOf = (
  series: Series,
  variant: string,
): { interval?: string; kind?: string } => {
  if (series.table === 'funding') return variant ? { kind: variant } : {};

  if (series.table === 'klines' || (REFERENCE as readonly string[]).includes(series.table))
    return variant && variant !== 'ticks' ? { interval: variant } : {};

  return {};
};

// ── Internals ─────────────────────────────────────────────────────────────────

const variantMatches = (series: Series, variant: string): boolean =>
  series.variant === '*' ? variant !== '' : (series.variant ?? '') === variant;
