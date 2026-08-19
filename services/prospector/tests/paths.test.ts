import { describe, expect, it } from 'vitest';
import { binance } from '../src/adapters/binance';
import { bybitPrimary } from '../src/adapters/bybit.primary';
import { bybitSecondary } from '../src/adapters/bybit.secondary';
import { gate } from '../src/adapters/gate';
import { htx } from '../src/adapters/htx';
import { kucoin } from '../src/adapters/kucoin';
import { _test_patternise as patternise, _test_excluded as excludedAnywhere } from '../src/paths';
import { keyFor } from '../src/catalog';
import type { Inspection, Publishing, Slots } from '../src/types';

/**
 * Reading a listing venue's paths back into series.
 *
 * **Every path below was taken from the catalog**, not invented: they are keys
 * these venues actually served and this service actually stored. What is checked
 * is that the pattern derived from one would rebuild it — because a pattern that
 * does not is a series generating URLs the venue has never heard of.
 */

const of = (seen: Inspection) => {
  expect(seen.of).toBe('series');

  if (seen.of !== 'series') throw new Error('unreachable');

  return seen;
};

/**
 * Put the instrument and the stamp back into a pattern **through the generator
 * itself**, never a copy of it.
 *
 * A second renderer written here would let a pattern round-trip in the test and
 * fail in production — and it is `keyOf` that builds every URL an update asks
 * for, so `keyOf` is what has to agree with the venue.
 */
const rebuild = (pattern: string, symbol: string, date: string, slots?: Slots): string =>
  keyFor({ pattern, urlSymbol: symbol } as Publishing, date, slots);

/**
 * The property that matters, checked the same way for every venue: read a real
 * key, then rebuild it from what was read. Anything less is a pattern nobody has
 * proved generates the file it came from.
 */
const roundTrips = (read: (path: string) => Inspection, path: string, slots?: Slots) => {
  const seen = of(read(path));

  /**
   * **Rebuilt from the archive's spelling**, which is what generation uses: a
   * series carries `urlSymbol` exactly where the venue's name for an instrument
   * is not the catalog's, and `keyFor` reads that rather than the symbol.
   */
  const spelling = seen.found.urlSymbol ?? seen.found.symbol;

  expect(rebuild(seen.found.pattern, spelling, seen.date, slots), path).toBe(path);

  return seen;
};

describe('binance', () => {
  it('reads a monthly spot kline, interval and all', () => {
    const seen = roundTrips(binance.inspectUrl!,
      'data/spot/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2026-08.zip');

    expect(seen.found).toMatchObject({ market: 'spot', dataset: 'klines', symbol: 'BTCUSDT' });
    expect(seen.date).toBe('202608');

    // The interval stays literal: a different one is a different series.
    expect(seen.found.pattern).toContain('/1h/');
  });

  /**
   * **Aggregated trades are trades.** `aggTrades` is binance's word for one
   * rendering of them, so it is a variant rather than a dataset of its own —
   * a consumer asking for trades finds both without knowing that word.
   */
  it('reads a monthly spot aggTrades as aggregated trades', () => {
    const seen = roundTrips(binance.inspectUrl!,
      'data/spot/monthly/aggTrades/BNBBTC/BNBBTC-aggTrades-2017-07.zip');

    expect(seen.found).toMatchObject({ market: 'spot', dataset: 'trades',
      variant: 'aggregated', symbol: 'BNBBTC' });
  });

  /** The margin segment is part of the market, because `um` and `cm` are markets. */
  it('reads a coin-margined futures daily file', () => {
    const seen = roundTrips(binance.inspectUrl!,
      'data/futures/cm/daily/aggTrades/BTCUSD_PERP/BTCUSD_PERP-aggTrades-2026-08-03.zip');

    /** Coin-margined and USD-margined are one market: both are perpetual swaps. */
    expect(seen.found).toMatchObject({ market: 'perp', dataset: 'trades',
      variant: 'aggregated' });
    expect(seen.date).toBe('20260803');
  });

  it('reads the same dataset under the monthly tree', () => {
    const seen = roundTrips(binance.inspectUrl!,
      'data/spot/monthly/klines/ETHBTC/1d/ETHBTC-1d-2020-12.zip');

    expect(seen.found).toMatchObject({
      market: 'spot', dataset: 'klines', variant: '1d', symbol: 'ETHBTC',
    });
  });

});

describe('htx', () => {
  it('reads an index kline, dataset before market', () => {
    const seen = roundTrips(htx.inspectUrl!,
      'data/index-klines/linear-swap/daily/1INCH-USDT/15min/1INCH-USDT-15min-2021-07-02.zip');

    expect(seen.found).toMatchObject({
      market: 'perp', dataset: 'indexPrice', variant: '15m', symbol: '1INCH-USDT',
    });

    expect(seen.date).toBe('20210702');
  });

  it('reads an order book at its level', () => {
    const seen = roundTrips(htx.inspectUrl!,
      'data/orderbook/spot/daily/lv400/PIXEL-USDT/PIXEL-USDT-l2orderbook-400lv-2026-06-21.tar.gz');

    /** The depth is a path level, and it is what tells two books apart. */
    expect(seen.found).toMatchObject({
      market: 'spot', dataset: 'books', variant: '400,incremental',
    });
  });
});

describe('htx, which has two trees', () => {
  /**
   * **The same data under two arrangements**, documented in `docs/venues/HTX.md`:
   * the unannounced tree puts the dataset first, the offered one puts the market
   * first. A reader that knew only one read none of the other — 4,000 files off
   * disk, not one of them placed.
   */
  it('reads the offered tree, market first', () => {
    const seen = roundTrips(htx.inspectUrl!,
      'historical_data/futures/daily/klines/TRX-USD-PERP/1m/TRX-USD-PERP-klines-1m-2026-07-02.zip');

    expect(seen.found).toMatchObject({
      market: 'perp', dataset: 'klines', variant: '1m', symbol: 'TRX-USD',
    });
  });

  /**
   * **`-PERP` is a constant of the shape, so it lives in the pattern.** Every
   * series of the offered tree's perpetual patterns carries it and none of its
   * dated ones do — so writing it into the template leaves the instrument named
   * the way `data/` names it, and the two trees' rows fall under one symbol
   * instead of two spellings of one contract.
   *
   * The round trip is what keeps that honest: the key has to rebuild from the
   * pattern and the instrument alone.
   */
  it('puts the perpetual suffix in the pattern and not in the symbol', () => {
    const seen = roundTrips(htx.inspectUrl!,
      'historical_data/futures/daily/trades/ADA-USDT-PERP/ADA-USDT-PERP-trades-2026-02-01.zip');

    expect(seen.found.symbol).toBe('ADA-USDT');
    expect(seen.found.pattern).toBe(
      'historical_data/futures/daily/trades/{SYMBOL}-PERP/{SYMBOL}-PERP-trades-{YYYY}-{MM}-{DD}.zip');

    /** A dated contract of the same tree keeps the plain shape. */
    const dated = roundTrips(htx.inspectUrl!,
      'historical_data/futures/daily/trades/BTC-USDT-260206/BTC-USDT-260206-trades-2026-02-01.zip');

    expect(dated.found.symbol).toBe('BTC-USDT-260206');
    expect(dated.found.pattern).toBe(
      'historical_data/futures/daily/trades/{SYMBOL}/{SYMBOL}-trades-{YYYY}-{MM}-{DD}.zip');
  });

  /**
   * The payoff: one contract, one name, whichever branch its files came from.
   * `data/` has always called it `BTC-USDT`, and the offered tree's suffix no
   * longer makes that a different instrument.
   */
  it('names a perpetual the same in both trees', () => {
    const offered = of(htx.inspectUrl!(
      'historical_data/futures/daily/trades/BTC-USDT-PERP/BTC-USDT-PERP-trades-2026-02-01.zip'));

    const old = of(htx.inspectUrl!(
      'data/trades/linear-swap/daily/BTC-USDT/BTC-USDT-trades-2026-01-05.zip'));

    expect(offered.found.symbol).toBe(old.found.symbol);
    expect(offered.found.market).toBe(old.found.market);
    expect(offered.found.pattern).not.toBe(old.found.pattern);
  });

  it('reads a level segment where the dataset has one', () => {
    const seen = roundTrips(htx.inspectUrl!,
      'historical_data/spot/daily/orderbook/lv400/M-USDT/M-USDT-l2orderbook-400lv-2026-07-13.tar.gz');

    expect(seen.found).toMatchObject({
      market: 'spot', dataset: 'books', variant: '400,incremental', symbol: 'M-USDT',
    });
  });

  it('still reads the unannounced tree, dataset first', () => {
    const seen = roundTrips(htx.inspectUrl!,
      'data/index-klines/linear-swap/daily/1INCH-USDT/15min/1INCH-USDT-15min-2021-07-02.zip');

    expect(seen.found).toMatchObject({ market: 'perp', dataset: 'indexPrice', variant: '15m' });
  });

  /**
   * **`linear-swap` says how a contract settles, not what kind it is.** A weekly
   * expiry sits in the same directory as the perpetual it settles against, so
   * the word cannot separate them and the symbol has to — the offered tree asks
   * the same question of `futures` and answers it with a `-PERP` suffix instead.
   *
   * Both keys below are real, and reading them as one market is what put 616
   * expired contracts among htx's perpetuals.
   */
  it('tells a dated contract from a perpetual in the tree that merges them', () => {
    const dated = roundTrips(htx.inspectUrl!,
      'data/mark-price-klines/linear-swap/daily/BTC-USDT-230707/15min/BTC-USDT-230707-15min-2023-07-07.zip');

    expect(dated.found).toMatchObject({
      market: 'future', dataset: 'markPrice', variant: '15m', symbol: 'BTC-USDT-230707',
    });

    const perpetual = roundTrips(htx.inspectUrl!,
      'data/index-klines/linear-swap/daily/BTC-USDT/15min/BTC-USDT-15min-2021-07-02.zip');

    expect(perpetual.found).toMatchObject({ market: 'perp', symbol: 'BTC-USDT' });
  });

  /**
   * The same instrument either side of the migration. It is one contract, and
   * the two trees spell it identically here — so the markets must agree too, or
   * the branches cannot be joined on what they have in common.
   */
  it('gives one dated contract the same market from either tree', () => {
    const old = of(htx.inspectUrl!(
      'data/mark-price-klines/linear-swap/daily/BTC-USDT-260206/15min/BTC-USDT-260206-15min-2026-01-23.zip'));

    const offered = of(htx.inspectUrl!(
      'historical_data/futures/daily/trades/BTC-USDT-260206/BTC-USDT-260206-trades-2026-02-01.zip'));

    expect(old.found.market).toBe('future');
    expect(offered.found.market).toBe('future');
    expect(old.found.symbol).toBe(offered.found.symbol);
  });

  /**
   * **The coin-margined tree needs no such test**, and would fail one written
   * for the other spelling: its dated symbols carry neither a dash nor a quote
   * currency. The market word already answers, which is why only the two words
   * that group by settlement are asked.
   *
   * The name is separated back out, because the offered tree calls the same
   * contract `ADA-USD-200807` and one contract should not be two instruments.
   */
  it('reads an undashed coin-margined expiry from the word alone', () => {
    const seen = roundTrips(htx.inspectUrl!,
      'data/trades/future/daily/ADA200807/ADA200807-trades-2020-07-31.zip');

    expect(seen.found).toMatchObject({
      market: 'future', dataset: 'trades', symbol: 'ADA-USD-200807', urlSymbol: 'ADA200807',
    });
  });

  /**
   * **The old tree joins a pair's two halves and the rest of htx separates
   * them.** That cannot live in the pattern — the change is inside the name — so
   * the symbol takes the dashed form and the archive's spelling is recorded
   * beside it. The round trip is what proves the key can still be rebuilt.
   */
  it('separates an old-tree spot pair and keeps its spelling', () => {
    const seen = roundTrips(htx.inspectUrl!,
      'data/klines/spot/daily/BTCUSDT/15min/BTCUSDT-15min-2020-06-01.zip');

    expect(seen.found).toMatchObject({
      market: 'spot', dataset: 'klines', variant: '15m',
      symbol: 'BTC-USDT', urlSymbol: 'BTCUSDT',
    });
  });

  /**
   * **The split is by longest quote, not first.** `USDTRUB` is `USDT` against
   * the rouble, and a rule that stopped at the first currency it recognised
   * would read it as `USD` against `TRUB` — a currency that does not exist.
   */
  it('splits a joined pair at its longest quote', () => {
    const seen = roundTrips(htx.inspectUrl!,
      'data/klines/spot/daily/USDTRUB/15min/USDTRUB-15min-2022-05-18.zip');

    expect(seen.found).toMatchObject({ symbol: 'USDT-RUB', urlSymbol: 'USDTRUB' });
  });

  /**
   * An option's symbol ends in its strike, whose width is not fixed, so a
   * six-figure one would read as an expiry. `option` is never asked the dated
   * question — the market word settles it whatever the strike happens to be.
   */
  it('keeps an option out of the dated test', () => {
    const seen = roundTrips(htx.inspectUrl!,
      'data/trades/option/daily/BTC-USDT-200828-C-10500/BTC-USDT-200828-C-10500-trades-2020-08-26.zip');

    expect(seen.found).toMatchObject({ market: 'option', dataset: 'trades' });
  });
});

describe('bybit', () => {
  /** The instrument runs straight into the date, with no separator to anchor on. */
  it('reads a name joined to its date', () => {
    const seen = roundTrips(bybitPrimary.inspectUrl!, 'trading/FIOUSDT/FIOUSDT2025-03-21.csv.gz');

    expect(seen.found).toMatchObject({ market: 'perp', dataset: 'trades', symbol: 'FIOUSDT' });
  });

  /**
   * **The directory need not agree with the filename.** Bybit renamed `DATAUSDT`
   * to `DATAOLD01USDT`, moved the directory and left every filename alone: 527
   * files across eighteen months in the archive, and no `trading/DATAUSDT/` at
   * all. A reader anchored on the directory repeating itself read none of them.
   */
  it('reads a file whose directory was renamed under it', () => {
    const seen = roundTrips(bybitPrimary.inspectUrl!, 'trading/DATAOLD01USDT/DATAUSDT2024-08-23.csv.gz');

    expect(seen.found).toMatchObject({ market: 'perp', dataset: 'trades', symbol: 'DATAUSDT' });
    expect(seen.found.pattern).toBe('trading/DATAOLD01USDT/{SYMBOL}{YYYY}-{MM}-{DD}.csv.gz');
  });

  /** Dated futures carry a hyphen and an expiry, which is part of the name. */
  it('reads a dated future, expiry and all', () => {
    const seen = roundTrips(bybitPrimary.inspectUrl!, 'trading/ETH-27JUN25/ETH-27JUN252024-08-23.csv.gz');

    expect(seen.found.symbol).toBe('ETH-27JUN25');
    expect(seen.date).toBe('20240823');
  });

  /** Options are dated first and keyed by the underlying coin. */
  it('reads an option file, dated first', () => {
    const seen = roundTrips(bybitPrimary.inspectUrl!,
      'trade/option/BTC/2026-08-03_BTC_USDT.trades.csv.zip');

    expect(seen.found).toMatchObject({ market: 'option', dataset: 'trades', symbol: 'BTC' });
  });

  /**
   * **A range is a month, once the data says so.** Every one of the 4,423 files
   * in the archive covers a whole calendar month — five intervals, no exceptions
   * — so `kline_for_metatrader4` is an ordinary monthly series that spells out
   * its own last day, which `{MONTH_LAST_DAY}` renders.
   */
  it('reads a range that is a whole calendar month', () => {
    const seen = roundTrips(bybitPrimary.inspectUrl!,
      'kline_for_metatrader4/ADAUSDT/2021/ADAUSDT_15_2021-01-01_2021-01-31.csv.gz',
      bybitPrimary.slotsFor);

    expect(seen.found).toMatchObject({ dataset: 'klines', variant: '15m', symbol: 'ADAUSDT' });
    expect(seen.date).toBe('202101');
    expect(seen.found.pattern).toContain('{YYYY}-{MM}-01_{YYYY}-{MM}-{MONTH_LAST_DAY}');
  });

  /** February, so a wrong `{MONTH_LAST_DAY}` would be off by one in three years of four. */
  it('reads a leap February at its own length', () => {
    roundTrips(bybitPrimary.inspectUrl!,
      'kline_for_metatrader4/BTCUSDT/2020/BTCUSDT_1_2020-02-01_2020-02-29.csv.gz',
      bybitPrimary.slotsFor);
  });

  /**
   * **A range that is not a whole month is not this series.** Bybit has never
   * published one, and reading it as monthly would generate keys for months it
   * would then report missing.
   */
  it('refuses a range that is not a whole month', () => {
    expect(bybitPrimary.inspectUrl!(
      'kline_for_metatrader4/ADAUSDT/2021/ADAUSDT_15_2021-01-01_2021-01-15.csv.gz').of)
      .toBe('unknown');
  });
});

describe('bybit, second host', () => {
  /**
   * The order-book host is a different arrangement entirely: the market first,
   * then the instrument, then a filename that **leads** with the date and ends
   * with the depth. Its root is `orderbook/`, so the catalog sees it stripped.
   */
  it('reads a book at its market and depth', () => {
    const seen = roundTrips(bybitSecondary.inspectUrl!, 'linear/BTCUSDT/2025-08-21_BTCUSDT_ob200.data.zip');

    expect(seen.found).toMatchObject({
      market: 'perp', dataset: 'books', variant: '200,incremental', symbol: 'BTCUSDT',
    });

    expect(seen.date).toBe('20250821');
  });

  /**
   * **The depth stays literal**, because bybit moved from 500 levels to 200 and
   * a symbol has files of both. Different depth, different series — the same
   * treatment an interval gets everywhere else.
   */
  it('keeps the depth out of the slots', () => {
    const five = roundTrips(bybitSecondary.inspectUrl!, 'inverse/AAVEUSD/2025-03-07_AAVEUSD_ob500.data.zip');
    const two  = roundTrips(bybitSecondary.inspectUrl!, 'inverse/AAVEUSD/2025-08-21_AAVEUSD_ob200.data.zip');

    /**
     * Both markets are perpetual swaps; what separates these two files is the
     * depth, which is the variant and stays literal in the pattern.
     */
    expect(five.found.market).toBe('perp');
    expect(five.found.variant).toBe('500,incremental');
    expect(two.found.variant).toBe('200,incremental');
    expect(five.found.pattern).toContain('ob500');
    expect(two.found.pattern).toContain('ob200');
    expect(five.found.pattern).not.toBe(two.found.pattern);
  });
});

describe('kucoin', () => {
  it('reads a futures funding rate', () => {
    const seen = roundTrips(kucoin.inspectUrl!,
      'futures/daily/fundingRates/1INCHUSDTM/1INCHUSDTM-fundingRates-2023-01-01.zip');

    expect(seen.found).toMatchObject({
      market: 'perp', dataset: 'funding', variant: 'realised', symbol: '1INCHUSDTM',
    });
  });

  /** The only place this tree is three deep before the instrument. */
  it('reads an order book under its depth group', () => {
    const seen = roundTrips(kucoin.inspectUrl!,
      'futures/daily/depth/orderbooklv50/0GUSDTM/0GUSDTM-orderbooklv50-2026-08-01.zip');

    /** Whole books, fifty levels a side, one per row — read off a real file. */
    expect(seen.found).toMatchObject({
      market: 'perp', dataset: 'books', variant: '50,snapshot',
    });
  });

  it('reads a kline with its interval', () => {
    const seen = roundTrips(kucoin.inspectUrl!,
      'futures/daily/klines/ADAUSDTM/1h/ADAUSDTM-1h-2024-05-06.zip');

    expect(seen.found).toMatchObject({ dataset: 'klines', symbol: 'ADAUSDTM' });
    expect(seen.found.pattern).toContain('/1h/');
  });
});

describe('gate', () => {
  /**
   * The month is a directory *and* part of the filename, so the pattern carries
   * `{YYYY}{MM}` twice — which is exactly what a round trip proves.
   */
  it('reads a futures candlestick, month in two places', () => {
    const seen = roundTrips(gate.inspectUrl!,
      'futures_btc/candlesticks_1h/202107/BTC_USD-202107.csv.gz');

    /**
     * **Canonical throughout**: gate's `futures_btc` is a perpetual like its
     * `futures_usdt`, and the bar length it spells into the dataset name becomes
     * the variant. The pattern below keeps gate's own words, because that is the
     * one place they are still used — to rebuild the URL.
     */
    expect(seen.found).toMatchObject({
      market: 'perp', dataset: 'klines', variant: '1h', symbol: 'BTC_USD',
    });

    expect(seen.date).toBe('202107');
    expect(seen.found.pattern).toBe('futures_btc/candlesticks_1h/{YYYY}{MM}/{SYMBOL}-{YYYY}{MM}.csv.gz');
  });

  it('reads a funding update', () => {
    roundTrips(gate.inspectUrl!, 'futures_usdt/funding_updates/202007/BTC_USDT-202007.csv.gz');
  });



  /**
   * **Both grains live in the same monthly directory**, and the stamp's length is
   * the only thing that says which. Gate generates its short intervals daily and
   * its long ones monthly, so a reader that knew only the month read none of the
   * former — thousands of files a day across spot and tradfi.
   */
  it('reads a daily file filed under its month', () => {
    const seen = roundTrips(gate.inspectUrl!,
      'spot/candlesticks_1m/202608/0G_USDT-20260801.csv.gz');

    expect(seen.date).toBe('20260801');
    expect(seen.found.pattern).toBe('spot/candlesticks_1m/{YYYY}{MM}/{SYMBOL}-{YYYY}{MM}{DD}.csv.gz');
  });

  /** A one-letter instrument, which tradfi has plenty of. */
  it('reads a tradfi daily candlestick', () => {
    roundTrips(gate.inspectUrl!, 'tradfi/candlesticks_15m/202608/A-20260803.csv.gz');
  });

  /**
   * **Which trees are surveyed is `accepts`' decision, not this expression's.**
   * Six of gate's thirteen are refused there — `v2/` stopped in 2022, `hk/` and
   * `malta/` were separate entities whose `BTC_USDT` is a different order book,
   * `future_usdt/` and `futures_usd/` are dead, `gatepay/` is spreadsheets — so
   * nothing here needs to know their names, and nothing here overrules them.
   */
  it('matches by shape, leaving which trees are surveyed to the adapter', () => {
    const seen = roundTrips(gate.inspectUrl!, 'delivery_usdt/trades/202305/BTC_USDT-202305.csv.gz');

    /** Delivery contracts genuinely expire, so they are not perpetuals. */
    expect(seen.found.market).toBe('future');
  });

  /**
   * **An hour is a grain like any other.** Gate's books are 24 files a day filed
   * under their month, 152,975 of them in the archive, and a pattern that could
   * not name an hour left every one of them untracked — found once by a walk and
   * never extended again.
   */
  it('reads an hourly book', () => {
    const seen = roundTrips(gate.inspectUrl!,
      'futures_usdt/orderbooks/202107/1INCH_USDT-2021071200.csv.gz');

    expect(seen.date).toBe('2021071200');
    expect(seen.found.pattern)
      .toBe('futures_usdt/orderbooks/{YYYY}{MM}/{SYMBOL}-{YYYY}{MM}{DD}{HH}.csv.gz');
  });

  /** The depth snapshot is a plain `.gz` where everything else is `.csv.gz`. */
  it('reads the hourly snapshot beside it', () => {
    roundTrips(gate.inspectUrl!, 'spot/orderbooks_slice/202108/BTC_USDT-2021080103.gz');
  });

  /**
   * The dated-futures books name the expiry **inside the instrument**, so the
   * stamp is read from the last separator rather than the first date in the
   * name — `ADA_USDT_20230512-2023050508` is the 2023-05-12 expiry, hour 08 of
   * 2023-05-05.
   */
  it('does not mistake an expiry inside the instrument for the date', () => {
    const seen = roundTrips(gate.inspectUrl!,
      'delivery_usdt/orderbooks/202305/BTC_USDT_20230512-2023050508.csv.gz');

    expect(seen.found.symbol).toBe('BTC_USDT_20230512');
    expect(seen.date).toBe('2023050508');
  });

  /**
   * **The snapshot trees name an instant and nothing else**, so their pattern
   * carries no date at all — only the slot that renders one back. Venue-wide
   * files, so no symbol either: the dataset is the whole identity.
   */
  it('reads an hourly snapshot named by its epoch', () => {
    const seen = roundTrips(gate.inspectUrl!, 'spot_index/202312/slice_index_1702857600',
      gate.slotsFor);

    /**
     * **A slice carries every instrument, so its symbol is the bucket.** Gate's
     * own name for it is nothing at all, which is why the catalog gives it one —
     * `@` filters and sorts like any other symbol, where an empty string was a
     * case every reader had to remember.
     */
    expect(seen.found).toMatchObject({ dataset: 'indexPrice', variant: 'ticks', symbol: '@' });
    expect(seen.found.pattern).toBe('spot_index/{YYYY}{MM}/slice_index_{EPOCH_HH}');
    expect(seen.date).toBe('2023121800');
  });

  /** The same shape a minute at a time, which is why the two slots differ. */
  it('reads a per-minute snapshot at its own grain', () => {
    const seen = roundTrips(gate.inspectUrl!, 'options_ticker/202509/slice_options_ticker_1756691460',
      gate.slotsFor);

    expect(seen.found.pattern).toBe('options_ticker/{YYYY}{MM}/slice_options_ticker_{EPOCH_MI}');
    expect(seen.date).toHaveLength(12);
  });
});

describe('deriving a pattern from a path', () => {
  /** Both occurrences, because a venue that names the instrument twice means it. */
  it('replaces every occurrence of the instrument', () => {
    expect(patternise('a/BTC/BTC-x-2026-08.zip', 'BTC', '202608'))
      .toBe('a/{SYMBOL}/{SYMBOL}-x-{YYYY}-{MM}.zip');
  });

  /** Longest first, or a day would be read as a month with a stray tail. */
  it('prefers the day form over the month it contains', () => {
    expect(patternise('a/2026-08-03.zip', '', '20260803')).toBe('a/{YYYY}-{MM}-{DD}.zip');
  });

  it('handles a date that appears undashed and twice', () => {
    expect(patternise('a/202608/x-202608.gz', 'x', '202608'))
      .toBe('a/{YYYY}{MM}/{SYMBOL}-{YYYY}{MM}.gz');
  });
});

/**
 * The three things no venue should ever catalogue.
 *
 * Not one venue's rule: binance and kucoin both ship a checksum beside every
 * archive, bybit writes an index page into every folder, and an uncompressed
 * `.csv` is a mistake wherever it appears — archival data is published
 * compressed, so one sitting beside its own `.csv.gz` is the same file left
 * behind. A rule written into one reader leaves every other venue counting
 * thousands of them as shapes nobody has read yet.
 */
describe('what is excluded at every venue', () => {
  it('drops a checksum whatever venue served it', () => {
    expect(excludedAnywhere('data/spot/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2026-08.zip.CHECKSUM'))
      .toBe(true);

    expect(excludedAnywhere(
      'futures/daily/depth/orderbooklv50/ASTRUSDTM/ASTRUSDTM-orderbooklv50-2026-07-17.zip.CHECKSUM',
    )).toBe(true);
  });

  /** Bybit writes one of these into every folder it has, per instrument per dataset. */
  it('drops a directory index page', () => {
    expect(excludedAnywhere('trading/BTCUSDT/index.html')).toBe(true);
  });

  /**
   * Gate left 99 of these beside 482 compressed ones in `spot/candlesticks_1m/201802`.
   * None of the 6.37M files ever collected from any venue is an uncompressed CSV.
   */
  it('drops an uncompressed csv', () => {
    expect(excludedAnywhere('spot/candlesticks_1m/201802/ABT_ETH-20180201.csv')).toBe(true);
  });

  /**
   * S3 lists a zero-byte key for a folder that was created rather than implied,
   * so `data3/` arrives beside the keys beneath it. It names a place, and
   * binance's own rule refuses `data3/<file>` — which a bare marker is not.
   */
  it('drops a directory marker', () => {
    expect(excludedAnywhere('data3/')).toBe(true);
    expect(excludedAnywhere('futures/daily/depth/')).toBe(true);
  });

  /** The compressed file beside it is the data, which is the whole distinction. */
  it('keeps the compressed file beside it', () => {
    expect(excludedAnywhere('spot/candlesticks_1m/201802/ABT_ETH-20180201.csv.gz')).toBe(false);
    expect(excludedAnywhere('data/spot/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2026-08.zip')).toBe(false);
  });
});

/**
 * Gate's own words, in the catalog's.
 *
 * **The translation is the adapter's whole reason for seeing a path.** What
 * these assert is that nothing venue-specific survives it: two trees become one
 * market, a family of dataset names becomes one dataset with a variant, and a
 * file carrying everything gets the bucket symbol.
 */
describe('gate speaks canonically', () => {
  const readOf = (path: string): Record<string, unknown> => {
    const seen = gate.inspectUrl!(path);

    if (seen.of !== 'series') throw new Error(`gate could not read ${path}`);

    return seen.found as unknown as Record<string, unknown>;
  };

  it('folds both perpetual trees into one market', () => {
    expect(readOf('futures_usdt/trades/202107/BTC_USDT-202107.csv.gz').market).toBe('perp');
    expect(readOf('futures_btc/trades/202107/BTC_USD-202107.csv.gz').market).toBe('perp');
  });

  it('keeps expiring contracts out of it', () => {
    expect(readOf('delivery_usdt/trades/202305/BTC_USDT-202305.csv.gz').market).toBe('future');
  });

  /** `7d` and `1w` are one duration, whatever gate writes. */
  it('canonicalises the interval it spells into the dataset name', () => {
    expect(readOf('spot/candlesticks_7d/202107/BTC_USDT-202107.csv.gz'))
      .toMatchObject({ dataset: 'klines', variant: '1w' });
    expect(readOf('spot/candlesticks_30s/202407/BTC_USDT-20240701.csv.gz'))
      .toMatchObject({ dataset: 'klines', variant: '30s' });
  });

  /** Two funding series that are not interchangeable in any calculation. */
  it('separates what was charged from what was estimated', () => {
    expect(readOf('futures_usdt/funding_applies/202007/BTC_USDT-202007.csv.gz').variant)
      .toBe('realised');
    expect(readOf('futures_usdt/funding_updates/202007/BTC_USDT-202007.csv.gz').variant)
      .toBe('predicted');
  });

  /** Read off real files: a delta stream at full depth, and 20-level snapshots. */
  it('tells gate\'s two books apart', () => {
    expect(readOf('futures_usdt/orderbooks/202107/1INCH_USDT-2021071200.csv.gz'))
      .toMatchObject({ dataset: 'books', variant: 'full,incremental' });
    expect(readOf('spot/orderbooks_slice/202108/BTC_USDT-2021080103.gz'))
      .toMatchObject({ dataset: 'books', variant: '20,snapshot' });
  });

  it('marks a mark price that is ticks rather than bars', () => {
    expect(readOf('futures_usdt/mark_prices/202107/BTC_USDT-202107.csv.gz'))
      .toMatchObject({ dataset: 'markPrice', variant: 'ticks' });
  });

  it('refuses a tree it has no canonical name for', () => {
    expect(gate.inspectUrl!('nonsense/trades/202107/BTC_USDT-202107.csv.gz').of).toBe('unknown');
  });
});
