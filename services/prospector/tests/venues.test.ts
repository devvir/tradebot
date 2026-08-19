import { describe, expect, it } from 'vitest';
import { binance } from '../src/adapters/binance';
import { bybitPrimary as bybit } from '../src/adapters/bybit.primary';
import { bybitSecondary } from '../src/adapters/bybit.secondary';
import { htx } from '../src/adapters/htx';
import { kucoin } from '../src/adapters/kucoin';
import { bitget } from '../src/adapters/bitget';
import { gate } from '../src/adapters/gate';
import { okx } from '../src/adapters/okx';
import { pathSymbolOf } from '../src/adapters/bitget/symbols';
import { tokenOf, unknownMargin } from '../src/adapters/bitget/shapes';
import { _test_marginOf } from '../src/adapters/bitget/instruments';
import { VENUE_NAMES, adaptersForVenue, adaptersFor } from '../src/venues';
import type { Adapter, Unsettled } from '../src/types';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addressVenues } from '../src/venues';
import { venues } from '../src/catalog';
import { openCatalog } from '../src/database';

const S3  = [binance, htx, kucoin, bybit];
const ALL = [...S3];

describe('every adapter', () => {
  /**
   * The reason the scanner is a separate concept. Four venues, one paging
   * implementation — if this ever stops holding, someone has copied a walk.
   */
  it('shares one scanner across every S3 venue', () => {
    expect(new Set(S3.map(a => a.scanner))).toHaveLength(1);
    expect(S3.every(a => a.scanner.name === 's3')).toBe(true);
  });

  /**
   * A venue is surveyed wherever it answers a listing, which is not always the
   * host it serves files from. Bybit's CDN answers none, so both addresses point
   * at the bucket behind it; binance's CDN serves files while the bucket is
   * listed.
   */
  it('lists from a host that answers a listing API', () => {
    expect(bybit.list).toContain('amazonaws.com');
    expect(bybit.list.startsWith('https://')).toBe(true);
  });

  /**
   * A venue whose listings carry size, ETag and last-modified is settled by the
   * walk alone; probing it would be a request per file to learn what is already
   * known.
   */
  it('does not probe a venue that publishes a listing', () => {
    for (const adapter of S3) expect(adapter.probes ?? false).toBe(false);
  });

  /**
   * A root is either empty — survey the whole bucket and strip nothing — or a
   * directory prefix. Anything else leaves a path that neither reconstructs as
   * `base + '/' + root + path` nor stands on its own.
   */
  it('declares a root that is empty or a directory prefix', () => {
    for (const adapter of ALL)
      expect(adapter.root === '' || adapter.root.endsWith('/')).toBe(true);
  });

  it('serves files from a base with no trailing slash', () => {
    for (const adapter of ALL) expect(adapter.base.endsWith('/')).toBe(false);
  });

  /**
   * Checksum sidecars are half of every page binance and KuCoin serve. They are
   * dropped by `dateOf` returning null rather than by a rule naming them, so
   * this is the test that keeps the catalog half the size it would be.
   *
   * **Asked only of the venues that publish them**, because it is a claim about
   * what a venue serves rather than about the scanner it is read with. Those
   * three anchor the date to `.zip`, which is what declines a name continuing
   * past it. Bybit could not: it publishes the date in the *middle* of a
   * filename — `BTCUSD2019-10-01_premium_index.csv.gz` — so its `dateOf` takes
   * the first date wherever it falls, and would stamp a sidecar if one existed.
   * None does; its trees hold `.csv.gz` and `.csv.zip` and nothing else.
   */
  it('refuses to catalogue a checksum sidecar', () => {
    for (const adapter of [binance, htx, kucoin])
      expect(adapter.dateOf('spot/trades/BTCUSDT/BTCUSDT-trades-2025-01-15.zip.CHECKSUM')).toBeNull();
  });

  it('refuses to catalogue a path carrying no date', () => {
    for (const adapter of ALL) expect(adapter.dateOf('spot/trades/BTCUSDT/')).toBeNull();
  });
});

describe('binance', () => {
  it('reads a daily date', () => {
    expect(binance.dateOf('spot/daily/trades/BTCUSDT/BTCUSDT-trades-2025-03-31.zip'))
      .toBe('20250331');
  });

  /**
   * **A month is dated as a month.** A file covering all of March is `202503`,
   * not `20250301`: it is not a file for the 1st and may hold nothing for that
   * day. Six characters sort correctly among that month's days because a month
   * is their prefix, so a month is matched the way any prefix is.
   */
  it('dates a monthly file as a month, not as its first day', () => {
    expect(binance.dateOf('spot/monthly/trades/BTCUSDT/BTCUSDT-trades-2025-03.zip'))
      .toBe('202503');
  });
});

describe('htx', () => {
  it('reads dates from both shapes it publishes', () => {
    expect(htx.dateOf('spot/daily/trades/BTC-USDT/BTC-USDT-trades-2026-02-01.zip'))
      .toBe('20260201');
    expect(htx.dateOf('spot/daily/orderbook/lv400/BTC-USDT/BTC-USDT-2026-02-01.tar.gz'))
      .toBe('20260201');
  });
});

describe('kucoin', () => {
  it('reads a daily date', () => {
    expect(kucoin.dateOf('spot/daily/trades/BTC-USDT/BTC-USDT-trades-2024-07-03.zip'))
      .toBe('20240703');
  });
});

/**
 * Bybit's four 2021 expiries, which the venue does not offer and does not
 * maintain.
 */
describe('bybit, the abandoned expiries', () => {
  it('refuses the four 2021 futures, directory and key alike', () => {
    for (const symbol of ['BTCUSDU21', 'BTCUSDZ21', 'ETHUSDU21', 'ETHUSDZ21']) {
      expect(bybit.accepts!(`trading/${symbol}/`)).toBe(false);
      expect(bybit.accepts!(`trading/${symbol}/${symbol}2021-07-26_v2.csv.gz`)).toBe(false);
    }
  });

  /** Every later expiry is an ordinary maintained series and stays surveyed. */
  it('keeps the expiries bybit does offer', () => {
    for (const symbol of ['BTCUSDU22', 'ETHUSDZ22', 'BTCUSDH26', 'ETHUSDM24'])
      expect(bybit.accepts!(`trading/${symbol}/`)).toBe(true);
  });

  /** The year is what is refused, not the letters around it. */
  it('does not refuse a perpetual that merely ends in those characters', () => {
    expect(bybit.accepts!('trading/BTCUSDT/')).toBe(true);
    expect(bybit.accepts!('trading/ETHUSD/')).toBe(true);
  });
});

describe('gate', () => {
  it('dates a monthly file as a month, not as its first day', () => {
    expect(gate.dateOf('futures_btc/candlesticks_10s/201901/ADA_USD-201901.csv.gz'))
      .toBe('201901');
    expect(gate.dateOf('spot/deals/202606/0G_USDT-202606.csv.gz')).toBe('202606');
  });

  it('reads a daily file', () => {
    expect(gate.dateOf('spot/candlesticks_1m/202606/0G_USDT-20260601.csv.gz')).toBe('20260601');
  });

  /**
   * Books are 24 files a day, and the hour is what tells them apart — so it is
   * kept. Dropping it gave all 24 one date and left nothing able to name them
   * individually.
   */
  it('reads an hourly file, at both extensions, keeping the hour', () => {
    expect(gate.dateOf('spot/orderbooks/202606/0G_USDT-2026060107.csv.gz')).toBe('2026060107');
    expect(gate.dateOf('spot/orderbooks_slice/202606/BTC_USDT-2026060100.gz')).toBe('2026060100');
  });

  /**
   * A delivery contract carries its expiry inside the symbol, so the filename
   * holds two dates and only the last one is the file's.
   */
  it('takes the trailing stamp, not the expiry in the symbol', () => {
    expect(gate.dateOf('delivery_usdt/orderbooks/202305/BTC_USDT_20230512-2023050508.csv.gz'))
      .toBe('2023050508');
  });

  /**
   * The venue-wide snapshots have no symbol and no extension — just an epoch.
   * The same number is a different period in each tree, so the tree decides how
   * far the stamp is rendered: `spot_index` is hourly, `options_ticker` is not.
   */
  it('reads a snapshot from the epoch it is named for, at the tree\'s own grain', () => {
    expect(gate.dateOf('spot_index/202606/slice_index_1780272000')).toBe('2026060100');
    expect(gate.dateOf('options_ticker/202509/slice_options_ticker_1756691460'))
      .toBe('202509010151');
  });

  it('says nothing for a stamp of a length gate does not publish', () => {
    expect(gate.dateOf('spot/deals/202606/BTC_USDT-1234567.csv.gz')).toBeNull();
    expect(gate.dateOf('spot_index/')).toBeNull();
  });

  it('surveys only the trees gate still publishes', () => {
    for (const tree of ['spot/', 'futures_usdt/', 'futures_btc/', 'tradfi/',
      'delivery_usdt/', 'spot_index/', 'options_ticker/'])
      expect(gate.accepts!(tree)).toBe(true);
  });

  /**
   * Refused as directories, so descent never enters them — which is the whole
   * saving, since each holds months of keys nothing would store.
   */
  it('refuses dead trees and other entities books', () => {
    for (const tree of ['v2/', 'hk/', 'malta/', 'future_usdt/', 'futures_usd/', 'gatepay/'])
      expect(gate.accepts!(tree)).toBe(false);
  });

  /** 571 keys sit a level above where they belong, with no dataset segment. */
  it('refuses a bare month where a dataset name belongs', () => {
    expect(gate.accepts!('spot/201905/')).toBe(false);
    expect(gate.accepts!('spot/201905/ABT_ETH-201905.csv.gz')).toBe(false);
    expect(gate.accepts!('futures_usdt/202107/')).toBe(false);
  });

  /**
   * The same misfiling the other way round: 179 snapshots sit directly under
   * their tree instead of under its month, each a byte-identical duplicate —
   * same size, same ETag — of the key that is filed properly.
   */
  it('refuses a snapshot filed where its month belongs', () => {
    expect(gate.accepts!('spot_index/slice_index_1702857600')).toBe(false);
    expect(gate.accepts!('options_ticker/slice_options_ticker_1756691460')).toBe(false);

    expect(gate.accepts!('spot_index/202312/slice_index_1702857600')).toBe(true);
    expect(gate.accepts!('options_ticker/202509/')).toBe(true);
  });

  /**
   * The same misfiling one level lower: 227 keys of spot deals sit inside the
   * daily-candlestick tree of a single month. Refused as a directory, so descent
   * never enters it.
   */
  it('refuses the stray directory inside a dataset', () => {
    expect(gate.accepts!('spot/candlesticks_1d/201802/s3deals/')).toBe(false);
    expect(gate.accepts!('spot/candlesticks_1d/201802/s3deals/ABT_ETH-201802.csv.gz')).toBe(false);
  });

  /** The month it sits in is otherwise ordinary, and stays surveyed. */
  it('keeps the month the stray directory sits in', () => {
    expect(gate.accepts!('spot/candlesticks_1d/201802/')).toBe(true);
    expect(gate.accepts!('spot/candlesticks_1d/201802/ABT_ETH-201802.csv.gz')).toBe(true);
  });

  /**
   * The two snapshot trees put a month directly under the tree by design, so the
   * rule above has to be scoped or it deletes them.
   */
  it('keeps a month sitting directly under a tree that has no datasets', () => {
    expect(gate.accepts!('spot_index/202608/')).toBe(true);
    expect(gate.accepts!('options_ticker/202608/')).toBe(true);
  });
});

describe('bybit', () => {
  it('reads a date the symbol runs straight into', () => {
    expect(bybit.dateOf('trading/BTCUSDT/BTCUSDT2020-03-25.csv.gz')).toBe('20200325');
  });

  it('reads a date with a suffix after it', () => {
    expect(bybit.dateOf('premium_index/BTCUSD/BTCUSD2019-10-01_premium_index.csv.gz'))
      .toBe('20191001');
    expect(bybit.dateOf('spot_index/BTCUSD/BTCUSD2019-10-01_index_price.csv.gz'))
      .toBe('20191001');
  });

  /** A month with no day is stamped at the first, so a month query catches it. */
  it('dates a monthly file as a month, not as its first day', () => {
    expect(bybit.dateOf('spot/BTCUSDT/BTCUSDT-2022-11.csv.gz')).toBe('202211');
  });

  it('dates a range by where it starts', () => {
    expect(bybit.dateOf('kline_for_metatrader4/BTCUSDT/2020/BTCUSDT_15_2020-04-01_2020-04-30.csv.gz'))
      .toBe('20200401');
  });

  it('catalogues nothing from a directory name', () => {
    expect(bybit.dateOf('kline_for_metatrader4/BTCUSDT/2020/')).toBeNull();
  });
});

describe('the registry', () => {
  /**
   * More servers than venues: bybit publishes its order books on a host of its
   * own, so naming the venue selects both. The split is bybit's business, not
   * the caller's.
   */
  it('returns every server when nothing is named', () => {
    expect(adaptersFor([]).length).toBeGreaterThan(VENUE_NAMES.length);
  });

  it('returns only what was named', () => {
    expect(adaptersFor(['htx']).map((a: Adapter) => a.name)).toEqual(['htx']);
  });

  it('selects every host of a venue named once', () => {
    const hosts = adaptersForVenue('bybit');

    expect(hosts.map(a => a.host).sort()).toEqual(['primary', 'secondary']);
    expect(new Set(hosts.map(a => a.name))).toEqual(new Set(['bybit']));
  });

  /** A venue is what a person configures; a host is not something they name. */
  it('offers each venue once, however many servers it has', () => {
    expect(VENUE_NAMES.filter(name => name === 'bybit')).toHaveLength(1);
  });

  it('names the known venues when asked for one that does not exist', () => {
    expect(() => adaptersForVenue('bitmex')).toThrow(/bitmex/);
    expect(() => adaptersForVenue('bitmex')).toThrow(/binance/);
  });
});

/**
 * The order books, on their own server. A separate adapter because nothing is
 * shared: a different tree, browsable indexes rather than a bucket listing, and
 * its own limiter.
 */
describe('bybit secondary', () => {
  it('reads the date that leads the filename', () => {
    expect(bybitSecondary.dateOf('orderbook/linear/BTCUSDT/2023-01-18_BTCUSDT_ob500.data.zip'))
      .toBe('20230118');
  });
  /** An index states no size or checksum, so every row it yields is unsettled. */
  it('probes, because its listings carry no metadata', () => {
    expect(bybitSecondary.probes).toBe(true);
    expect(bybitSecondary.scanner.name).toBe('html');
  });

  /** Two servers, two limiters — a stand-down on one must not stop the other. */
  it('gets a budget of its own', () => {
    expect(bybitSecondary.host).not.toBe(bybit.host);
    expect(bybitSecondary.name).toBe(bybit.name);
  });
});



/**
 * A venue is useful before it is reachable: an exclusion keys on a venue row and
 * configuration validates against the registry, and neither needs a scanner.
 */
/**
 * The venue whose bucket will not admit what it does not have. Every shape below
 * was measured against 4.8M rows of bitget's own index and the 1.46M files held
 * locally, and confirmed against the CDN where the two disagreed.
 */
describe('bitget', () => {
  it('is known to configuration and selected with the rest', () => {
    expect(VENUE_NAMES).toContain(bitget.name);
    expect(adaptersForVenue(bitget.name)).toEqual([bitget]);
    expect(adaptersFor([])).toContain(bitget);
  });

  it('probes, because nothing it emits has been seen', () => {
    expect(bitget.probes).toBe(true);
    expect(bitget.listable).toBe(false);
  });

  /**
   * **The distinction the whole venue rests on.** S3 answering `AccessDenied` is
   * a statement about the object; a CDN answering under its own name is a
   * statement about us. Read the first as the second and the venue stands down
   * on its first missing file, for ever.
   */
  it('tells a hidden key from a refusal by who answered', () => {
    const missing = new Headers({ server: 'AmazonS3', 'content-type': 'application/xml' });
    const turned  = new Headers({ server: 'CloudFront' });

    expect(bitget.refusesUs!(403, missing)).toBe(false);
    expect(bitget.refusesUs!(403, turned)).toBe(true);

    expect(bitget.ruleOnFailure!(403, missing, 1)).toBe('drop');
    expect(bitget.ruleOnFailure!(403, turned, 1)).toBe(null);

    // A refusal that is about us is never counted against a key, however often
    // it arrives.
    expect(bitget.ruleOnFailure!(429, new Headers(), 9)).toBe(null);
  });

  /**
   * Both eras, both markets, all four tokens, and the digit depth names a market
   * by. Only the date is read back: bitget cannot be listed, so every key it
   * meets was generated from a series it already holds — the market and dataset
   * come from that row, not from the path.
   */
  it('dates every shape it publishes', () => {
    const shapes: [string, string, string, string][] = [
      ['kline/BTCUSDT/BTCUSDT_SP_1min_20180725.zip',        'spot', 'klines', '20180725'],
      ['kline/BTCUSDT/SP/20260813.zip',                     'spot', 'klines', '20260813'],
      ['kline/BTCUSD/BTCUSD_UMCBL_1min_20190423.zip',       'perp', 'klines', '20190423'],
      ['kline/BTCUSD/UMCBL/20260813.zip',                   'perp', 'klines', '20260813'],
      ['trades/SPBL/BTCUSDT/BTCUSDT_SPBL_20180725_001.zip', 'spot', 'trades', '20180725'],
      ['trades/SPBL/BTCUSDT/20260813_001.zip',              'spot', 'trades', '20260813'],
      ['trades/DMCBL/BTCUSD/BTCUSD_DMCBL_20210519_001.zip', 'perp', 'trades', '20210519'],
      ['trades/CMCBL/BTCPERP/20260813_004.zip',             'perp', 'trades', '20260813'],

      /** `depth` is the best bid and offer, and `1`/`2` is the market. */
      ['depth/BTCUSDT/1/20240709.zip',                      'spot', 'quotes', '20240709'],
      ['depth/BTCUSDT/2/20240709.zip',                      'perp', 'quotes', '20240709'],
    ];

    for (const [path, , , date] of shapes) expect(bitget.dateOf(path)).toBe(date);
  });

  /**
   * A day of trades is cut every 100,000 rows and nothing in the path says how
   * many parts there are, so each one asks for the next and the archive ends the
   * chain by not answering.
   */
  /** The hook takes a whole row; these rules read only its path. */
  const probed = (path: string): Unsettled =>
    ({ venueId: 1, path, date: '20260813', tries: 0, existence: 'assumed', seriesId: null });

  /**
   * **Skipped while the experimental seed runs.** `ruleOnSuccess` is temporarily
   * something else: it jumps a series to the newest date the download index
   * claimed, so a run establishes the real bounds without probing the years
   * between. The part-following rule is commented out in the adapter beside it
   * and returns here when that comes back.
   */
  it.skip('asks for the part after the one that arrived, and only for trades', () => {
    expect(bitget.ruleOnSuccess!(probed('trades/SPBL/BTCUSDT/20260813_001.zip'), 1_093_006))
      .toEqual({ action: 'accept', next: 'trades/SPBL/BTCUSDT/20260813_002.zip' });

    expect(bitget.ruleOnSuccess!(probed('trades/SPBL/BTCUSDT/20260813_099.zip'), 1))
      .toEqual({ action: 'accept', next: 'trades/SPBL/BTCUSDT/20260813_100.zip' });

    expect(bitget.ruleOnSuccess!(probed('kline/BTCUSDT/SP/20260813.zip'), 1)).toBe(null);
    expect(bitget.ruleOnSuccess!(probed('depth/BTCUSDT/1/20240709.zip'), 1)).toBe(null);
  });
});

/**
 * The venue with nothing to list. Its paths are built rather than read, so the
 * shapes below are the whole of what a survey can ask about — every one of them
 * verified against the archive.
 */
describe('okx', () => {
  /**
   * The bucket behind the CDN is faster and refuses nothing, but it holds only
   * one of the two book prefixes — and answers the other with a 404 that reads
   * exactly like "never published". One address that serves everything is worth
   * more than a faster one that is silently incomplete.
   */
  it('surveys from the CDN, which is the only address serving both book prefixes', () => {
    expect(okx.base).toBe('https://static.okx.com');
    expect(okx.root).toBe('cdn/');
  });

  /** Measured: clean at 100 a second, refused at 200, and the refusal sticks. */
  it('declares the cadence it was measured at', () => {
    expect(okx.pacing?.perSecond).toBe(100);
  });

  /**
   * **The one venue where a probe decides whether the file exists at all.**
   * Every key here is constructed, so a walk establishes nothing and the row it
   * writes is a candidate. Without this the whole venue would sit in `wip` for
   * ever.
   *
   * **TEMPORARY: it retires a key on the first 404.** okx spells absence as a
   * 404 and refusal as a 403, so one answer settles it; the core's three
   * confirmations protect a trailing edge this run does not have. The hook goes
   * when the experiment does.
   */
  it('probes, because nothing it emits has been seen', () => {
    expect(okx.probes).toBe(true);
    expect(okx.ruleOnFailure!(404, new Headers(), 1)).toBe('drop');
    expect(okx.ruleOnFailure!(403, new Headers(), 1)).toBe(null);
  });

  it('reads both grains it publishes', () => {
    expect(okx.dateOf('okex/traderecords/trades/monthly/202109/BTC-USDT-trades-2021-09.zip'))
      .toBe('202109');
    expect(okx.dateOf('okex/traderecords/trades/daily/20260701/BTC-USDT-trades-2026-07-01.zip'))
      .toBe('20260701');
    expect(okx.dateOf(
      'okx/match/orderbook/pro/L2/400lv/daily/20260812/BTC-USD-L2orderbook-400lv-2026-08-12.tar.gz'))
      .toBe('20260812');
  });
});

/**
 * Give the adapters their addresses, as startup does.
 *
 * **Where a venue is lives in the `venue` table**, written by a migration, so an
 * adapter carries no address until it is handed one. A test that uses a real
 * venue needs that step; one that invents its own venue does not.
 */
const address = () => {
  const here = mkdtempSync(join(tmpdir(), 'addresses-'));
  const db   = openCatalog(join(here, 'catalog.db'));

  addressVenues(venues(db));

  db.close();
  rmSync(here, { recursive: true, force: true });
};

address();

/**
 * How bitget's own name for an instrument becomes the archive's, which is the
 * one thing about this venue that cannot be probed into existence.
 */
describe('bitget instrument naming', () => {
  it('derives the two spellings that have a rule', () => {
    expect(pathSymbolOf('FUTURES', 'AAVEUSDC')).toBe('AAVEPERP');
    expect(pathSymbolOf('FUTURES', 'AAVEUSD_CM')).toBe('AAVECM');

    // Spot never renames, and a plain futures symbol is filed as it is listed.
    expect(pathSymbolOf('SPOT', 'BTCUSDT')).toBe('BTCUSDT');
    expect(pathSymbolOf('FUTURES', 'BTCUSDT')).toBe('BTCUSDT');
  });

  /**
   * **The dated contracts derive too**, in both directions: the display name
   * states the expiry date, that date is the month's last Friday which fixes the
   * year, and the letter is the futures calendar's - H, M, U, Z.
   */
  it('derives a quarterly contract from the expiry its name states', () => {
    expect(pathSymbolOf('FUTURES', 'BTCUSD0327')).toBe('BTCUSDH26');
    expect(pathSymbolOf('FUTURES', 'BTCUSD0328')).toBe('BTCUSDH25');
    expect(pathSymbolOf('FUTURES', 'ETHUSD0926')).toBe('ETHUSDU25');
  });

  /**
   * **A re-issued ticker has no rule at all**, and is not guessed at here: the
   * venue states it through its own search, per instrument, at the moment one is
   * discovered. What this answers is the spelling it was listed under, which is
   * right for every instrument that has never been re-issued.
   */
  it('leaves a name it cannot derive exactly as the venue lists it', () => {
    expect(pathSymbolOf('FUTURES', 'APPUSDT')).toBe('APPUSDT');
    expect(pathSymbolOf('SPOT', 'rAAPL/USDT')).toBe('RAAPLUSDT');
  });

  /**
   * A futures trades token is the instrument's margin type, which nothing in the
   * symbol or the path reveals — only the category the venue lists it under.
   */
  it('files trades under the margin type the venue lists', () => {
    const at = (market: string, category: string) =>
      tokenOf({ market, category, symbol: 'X', launchedAt: null }, 'trades');

    expect(at('SPOT',    'SPOT')).toBe('SPBL');
    expect(at('FUTURES', 'USDT-FUTURES')).toBe('UMCBL');
    expect(at('FUTURES', 'COIN-FUTURES')).toBe('DMCBL');
    expect(at('FUTURES', 'USDC-FUTURES')).toBe('CMCBL');
  });

  /** Candlesticks and depth use one token per market, whatever the margin. */
  it('files candlesticks under one token for both margin types', () => {
    const coin = { market: 'FUTURES', category: 'COIN-FUTURES', symbol: 'X', launchedAt: null };
    const spot = { market: 'SPOT', category: 'SPOT', symbol: 'X', launchedAt: null };

    expect(tokenOf(coin, 'klines')).toBe('UMCBL');
    expect(tokenOf(spot, 'klines')).toBe('SP');
    expect(tokenOf(spot, 'depth')).toBe('1');
    expect(tokenOf(coin, 'depth')).toBe('2');
  });

  /**
   * **A contract type nobody has seen still gets candlesticks and depth.** Those
   * are right whatever the margin; only its trades token is a guess, and the
   * venue is asked once rather than the instrument being dropped.
   */
  it('carries on for an unknown contract type, and says that it did', () => {
    const odd = { market: 'FUTURES', category: 'EUR-FUTURES', symbol: 'X', launchedAt: null };

    expect(unknownMargin(odd)).toBe(true);
    expect(tokenOf(odd, 'trades')).toBe('UMCBL');
    expect(tokenOf(odd, 'klines')).toBe('UMCBL');

    expect(unknownMargin({ ...odd, category: 'COIN-FUTURES' })).toBe(false);
    expect(unknownMargin({ market: 'SPOT', category: 'SPOT', symbol: 'X', launchedAt: null }))
      .toBe(false);
  });

  /**
   * **What the listing has to hand on, because nothing later can recover it.**
   *
   * The token is a directory segment and the category that decides it is known
   * only where the contract was read. A margin line that departs from the
   * pattern's default is therefore stated as a transform against the instrument;
   * one that agrees with it is left unstated, since a row repeating the default
   * is the default written twice.
   */
  it('declares a margin token only where it departs from the pattern default', () => {
    const declared = (market: string, category: string, stated: string | null = null) =>
      _test_marginOf({ market, category, symbol: 'X', live: true }, stated);

    expect(declared('FUTURES', 'COIN-FUTURES')).toEqual([
      { dataset: 'trades', kind: 'marginToken', transform: 'DMCBL', from_: '19700101', to_: null },
    ]);

    expect(declared('FUTURES', 'USDC-FUTURES')?.[0]?.transform).toBe('CMCBL');

    expect(declared('FUTURES', 'USDT-FUTURES')).toBeUndefined();
    expect(declared('SPOT',    'SPOT')).toBeUndefined();

    /** A contract type these shapes have never met keeps the default and is reported. */
    expect(declared('FUTURES', 'EUR-FUTURES')).toBeUndefined();
  });

  /**
   * **The venue states the token; deriving it is the fallback.** Its search
   * returns `symbolId` as `<symbol>_<token>`, and the preamble has already asked
   * about exactly the instruments that need one — so a stated token is used even
   * where the category would have said something else, and it is what lets a
   * contract type these shapes have never met be filed correctly instead of
   * quietly defaulting.
   */
  it('prefers the token the venue stated over the one the category implies', () => {
    const declared = (market: string, category: string, stated: string | null) =>
      _test_marginOf({ market, category, symbol: 'X', live: true }, stated);

    expect(declared('FUTURES', 'USDT-FUTURES', 'DMCBL')?.[0]?.transform).toBe('DMCBL');
    expect(declared('FUTURES', 'COIN-FUTURES', 'UMCBL')).toBeUndefined();

    /** A category nothing here knows is filed correctly once the venue has said so. */
    expect(declared('FUTURES', 'EUR-FUTURES', 'CMCBL')?.[0]?.transform).toBe('CMCBL');
  });
});
