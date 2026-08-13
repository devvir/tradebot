import { logger } from '@devvir/service-kit';
import { after, ttlCache } from './listing';
import { DAILY_FROM, MONTHLY_THROUGH } from './granularity';
import {
  dashed, dashedMonth, dateRange, endOfMonth, latest, monthRange, msToYMD, nextDay,
  yesterdayUTC,
} from '../dates';
import type { ArchiveFile, Dataset } from '../types';
import type { OkxInstrument, VenueArchive } from './types';

/**
 * Everything OKX publishes on this CDN lives under `cdn/okex/traderecords/`, so
 * that whole prefix is addressing rather than organisation. The stored path
 * starts at the data type (`trades/`, and later `swaprate/`, `aggtrades/`).
 */
const HOST = 'https://static.okx.com/cdn/okex/traderecords';
const API   = 'https://www.okx.com/api/v5/public/instruments';

/**
 * The download portal's own instrument list, which is the only place delisted
 * instruments still appear. Undocumented, so it is asked once per instrument
 * type per sweep and never per symbol.
 */
const PORTAL_INSTRUMENTS = 'https://www.okx.com/priapi/v5/broker/public/trade-data/instruments';

/**
 * Verified against okx's own file-list endpoint, not read off the portal: a
 * window covering 25 August to 5 September 2021 returns nothing before the
 * 1st. See `docs/venues/OKX.md`.
 */
const START = '20210901';

/**
 * Books sit on an entirely different prefix, found only through the portal's
 * download call — no guess at the `traderecords` layout reaches them.
 */
const BOOKS_HOST  = 'https://static.okx.com/cdn/okx/match';

/**
 * Portal text, and **not** what the index reports: `BTC-USDT` books begin
 * 2023-12-18, with nothing in February, March, June, October or late November
 * of 2023. The portal's "March 2023" therefore describes the archive rather
 * than any one instrument.
 *
 * Kept at the earlier date deliberately. Too early costs probes below whichever
 * symbol started first; too late loses that symbol's history outright.
 */
const BOOKS_START = '20230301';
const RATES_START = '20211201';

/** Stands in for the symbol on datasets published as one file for all of them. */
const VENUE_WIDE = 'ALL';

/**
 * OKX publishes no file listing — none has been found, and the one third-party
 * downloaders use goes through `api.tardis.dev` rather than OKX itself. So URLs
 * are **constructed** from the date range and probed; a 404 means "never
 * published", which is the expected answer, not an error.
 *
 * The instruments endpoint carries `listTime`, and using it matters: without
 * it every symbol is probed from 2021 regardless of when it listed, so a recent
 * listing like `0G-USDT-SWAP` (2025-09-22) burns ~1,480 round trips on dates
 * that cannot exist. Starting each symbol at its own listing date removes
 * essentially all of that.
 *
 * Three prefixes are in play. `traderecords/` holds trades, candlesticks and
 * the venue-wide funding and borrowing files; `okx/match/` holds the L2 books.
 * Neither the book prefix nor the correct `swaprates`/`borrowrates` spelling is
 * reachable by guessing at the `traderecords` layout — both came from watching
 * what the download portal actually requests.
 */
export const okx: VenueArchive = {
  name: 'okx',

  constructsUrls: true,

  /**
   * Checked against okx's own file-list endpoint rather than trusted: a window
   * covering 25 August to 5 September 2021 returns nothing before the 1st. On
   * bitget the equivalent portal claim proved wrong by six years, so this one
   * was measured before being relied on. See `docs/venues/OKX.md`.
   */
  floor: START.slice(0, 6),

  /**
   * **Unfounded, and to be removed with discovery rather than repaired.** The
   * claim behind it — this URL answering 404 and then 200 seconds later — did
   * not hold up: 219 of okx's 46,847 recorded absences were re-probed and every
   * one was still absent, and none had ever been retried. `docs/venues/OKX.md`
   * has the measurement.
   */
  unreliableAbsence: true,

  datasets: [
    { id: 'swap-trades',   kind: 'trades', market: 'SWAP',    path: 'trades' },
    { id: 'spot-trades',   kind: 'trades', market: 'SPOT',    path: 'trades' },
    { id: 'future-trades', kind: 'trades', market: 'FUTURES', path: 'trades' },

    { id: 'swap-candlesticks',   kind: 'klines', market: 'SWAP',    path: 'candlesticks' },
    { id: 'spot-candlesticks',   kind: 'klines', market: 'SPOT',    path: 'candlesticks' },
    { id: 'future-candlesticks', kind: 'klines', market: 'FUTURES', path: 'candlesticks' },

    // Venue-wide: one daily file carries every instrument, so there is no
    // symbol axis at all. A monthly per-symbol form also exists, but taking the
    // daily-all file is both complete and thousands of requests cheaper — most
    // symbols have no rows on most days.
    { id: 'all-fundingrates', kind: 'funding', market: 'ALL', path: 'swaprates'   },
    { id: 'all-borrowrates',  kind: 'borrow',  market: 'ALL', path: 'borrowrates' },

    // The deepest book archive published anywhere. The two depths are **not the
    // same data at different depths**: 400lv is event-driven at ~10 ms, 5000lv
    // is conflated to exactly 1 s. On one BTC-USD-SWAP day, 2,015,702 records
    // against 86,074. Neither contains the other, so both are collected.
    { id: 'spot-orderbook400',   kind: 'book', market: 'SPOT',    path: '400lv'  },
    { id: 'spot-orderbook5000',  kind: 'book', market: 'SPOT',    path: '5000lv' },
    { id: 'swap-orderbook400',   kind: 'book', market: 'SWAP',    path: '400lv'  },
    { id: 'swap-orderbook5000',  kind: 'book', market: 'SWAP',    path: '5000lv' },

    // Dated futures are published as one file per **underlying**, bundling the
    // whole expiry chain, so these enumerate underlyings rather than instruments.
    // Options are not collected at all: they need an options pricing model rather
    // than a price series, each chain holds hundreds of thinly-traded series, and
    // one chain file would explode into hundreds of partitions downstream.
    { id: 'future-orderbook400',  kind: 'book', market: 'FUTURES', path: '400lv'  },
    { id: 'future-orderbook5000', kind: 'book', market: 'FUTURES', path: '5000lv' },
  ],

  symbols: async (dataset) => {
    if (dataset.market === 'ALL') return [VENUE_WIDE];

    // Dated futures are published per **underlying**, bundling the whole expiry
    // chain into one file, whatever the data kind — `BTC-USD-trades-…` exists
    // and `BTC-USD-260731-trades-…` is a 404. Enumerating instruments here
    // therefore collected nothing at all for the futures trades and
    // candlesticks datasets.
    if (chained(dataset)) return underlyings(dataset.market);

    return [...(await instruments(dataset.market)).keys()].sort();
  },

  files: async (dataset, symbol, since) => {
    if (dataset.kind === 'funding' || dataset.kind === 'borrow')
      return venueWide(dataset, since);

    if (dataset.kind === 'book') return books(dataset, symbol, since);

    const listed = await listingOf(dataset, symbol);
    const from   = latest(since ? nextDay(since) : START, listed);
    const type   = dataset.path;

    /**
     * A month is not a summary of its days — it is the same rows in one file.
     * Checked on `1INCH-USDT-SWAP` for June 2026: 550,733 rows in the monthly
     * file against 19,162 for a single day, same columns. Taking both would
     * store every trade twice for a thirtieth of the requests' benefit, so the
     * cutover splits them: months to its left, days to its right, no overlap.
     *
     * Monthly files verified present for every month from 202110 to 202606;
     * 202109 is 404 at both granularities, so the archive starts in October.
     */
    const stem  = stemOf(dataset, symbol);
    const files = monthRange(from.slice(0, 6), MONTHLY_THROUGH)
      .map<ArchiveFile>(month => ({
        url:    `${HOST}/${type}/monthly/${month}/${name(stem, type, dashedMonth(month))}`,
        path:   `${type}/monthly/${month}/${name(stem, type, dashedMonth(month))}`,
        date:   endOfMonth(month),
        symbol,
        period: 'monthly',
      }));

    for (const date of dateRange(latest(from, DAILY_FROM), yesterdayUTC()))
      files.push({
        url:    `${HOST}/${type}/daily/${date}/${name(stem, type, dashed(date))}`,
        path:   `${type}/daily/${date}/${name(stem, type, dashed(date))}`,
        date,
        symbol,
        period: 'daily',
      });

    return after(files, since);
  },
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * One file a day covering the whole venue, so the "symbol" is a placeholder and
 * the cursor is a single row per dataset.
 */
const venueWide = (dataset: Dataset, since: string | null): ArchiveFile[] => {
  const stem  = dataset.path === 'swaprates' ? 'allswap-fundingrates' : 'allmargin-borrowrates';
  const from  = since ? nextDay(since) : RATES_START;
  const files = dateRange(from, yesterdayUTC()).map<ArchiveFile>(date => {
    const path = `${dataset.path}/daily/${date}/${stem}-${dashed(date)}.zip`;

    return { url: `${HOST}/${path}`, path, date, symbol: VENUE_WIDE, period: 'daily' };
  });

  return after(files, since);
};

/**
 * L2 books live on a different prefix from everything else OKX publishes
 * (`cdn/okx/match/…` rather than `cdn/okex/traderecords/…`) and only as days.
 */
const books = async (
  dataset: Dataset,
  symbol:  string,
  since:   string | null,
): Promise<ArchiveFile[]> => {
  const listed = chained(dataset)
    ? BOOKS_START
    : latest((await instruments(dataset.market)).get(symbol) ?? BOOKS_START, BOOKS_START);

  const from  = latest(since ? nextDay(since) : listed, listed);
  const stem  = stemOf(dataset, symbol);
  const files = dateRange(from, yesterdayUTC()).map<ArchiveFile>(date => {
    const name = `${stem}-L2orderbook-${dataset.path}-${dashed(date)}.tar.gz`;
    const path = `orderbook/L2/${dataset.path}/daily/${date}/${name}`;

    return { url: `${BOOKS_HOST}/${path}`, path, date, symbol, period: 'daily' };
  });

  return after(files, since);
};

/** Dated futures are published one file per underlying chain, not per contract. */
const chained = (dataset: Dataset): boolean => dataset.market === 'FUTURES';

const chainOf = (): string => 'futureschain';

/**
 * The filename stem for a symbol, which for a chained dataset is **not** the
 * symbol.
 *
 * A dated-futures file is named for the underlying *and marked as a chain*:
 * `BTC-USD-futureschain-trades-2026-07-01.zip` holds every live expiry at once
 * — six contracts on the day this was checked, from `BTC-USD-260703` out to
 * `BTC-USD-261225`. That is the only way to get an expired contract's history,
 * since nothing is published per contract.
 *
 * The marker is not optional decoration. `BTC-USD-trades-…` also answers 200,
 * but its rows carry `instrument_name: BTC-USD` — a different instrument
 * altogether. Dropping the marker therefore does not fail, it silently collects
 * the wrong series, which is why the stem is derived here rather than assumed
 * to be the symbol.
 */
const stemOf = (dataset: Dataset, symbol: string): string =>
  chained(dataset) ? `${symbol}-${chainOf()}` : symbol;

/**
 * When a symbol's archive begins.
 *
 * For an instrument that is its own file, its listing date. For a chained
 * dataset the symbol is an underlying rather than an instrument, so the answer
 * is the earliest listing across the chain — anything later would skip files
 * belonging to expiries that listed before the one that happens to be first in
 * the map.
 */
const listingOf = async (dataset: Dataset, symbol: string): Promise<string> =>
  chained(dataset)
    ? (await chainListings(dataset.market)).get(symbol) ?? START
    : (await instruments(dataset.market)).get(symbol) ?? START;

/** Underlying → earliest listing date across its expiry chain. */
const chainListings = async (instType: string): Promise<Map<string, string>> => {
  const cached = chainCache.get(instType);

  if (cached) return cached;

  const body = await instrumentData(instType);
  const map  = new Map<string, string>();

  for (const inst of body) {
    if (! inst.uly) continue;

    const listed  = Number(inst.listTime);
    const date    = Number.isFinite(listed) && listed > 0 ? msToYMD(listed) : START;
    const current = map.get(inst.uly);

    if (! current || date < current) map.set(inst.uly, date);
  }

  if (map.size === 0) throw new Error(`OKX returned no ${instType} underlyings`);

  chainCache.set(instType, map);

  return map;
};

/** The distinct underlyings of an instrument type — `BTC-USD`, `ETH-USD`, … */
const underlyings = async (instType: string): Promise<string[]> => {
  const body = await instrumentData(instType);
  const ulys = [...new Set(body.map(i => i.uly).filter(Boolean) as string[])].sort();

  if (ulys.length === 0) throw new Error(`OKX returned no ${instType} underlyings`);

  return ulys;
};

/**
 * instId → listing date (`yyyymmdd`) per instrument type, cached with an
 * expiry so the periodic rescan sees new listings without refetching per
 * symbol. An empty or non-2xx answer **throws rather than caching** — a cached
 * empty universe would silently collect nothing for hours.
 */
const cache = ttlCache<Map<string, string>>(12 * 60 * 60 * 1000);

/** The same, keyed by underlying rather than instrument, for chained datasets. */
const chainCache = ttlCache<Map<string, string>>(12 * 60 * 60 * 1000);

const instruments = async (instType: string): Promise<Map<string, string>> => {
  const cached = cache.get(instType);

  if (cached) return cached;

  const body = await instrumentData(instType);
  const map  = new Map<string, string>();

  for (const inst of body) {
    if (! inst.instId) continue;

    const listed = Number(inst.listTime);

    map.set(inst.instId, Number.isFinite(listed) && listed > 0 ? msToYMD(listed) : START);
  }

  if (map.size === 0) throw new Error(`OKX returned no ${instType} instruments`);

  // Delisted instruments are absent from the public endpoint and their files are
  // still served, so the archive is reachable only for as long as the name is
  // known. The portal's own list keeps them — 2,148 spot instruments against
  // 1,335 live — and costs one request, so it is asked every run rather than
  // frozen into a seed. A dead instrument has no `listTime` left to read and is
  // walked from the venue floor.
  for (const instId of await retired(instType)) {
    if (! map.has(instId)) map.set(instId, START);
  }

  cache.set(instType, map);

  return map;
};

/**
 * Every instrument the download portal knows of a type, living or not.
 *
 * A failure here is not fatal: the live catalogue is already in hand, so the
 * pass collects what is trading and simply misses the dead ones until the next
 * sweep. Losing everything to an endpoint that is not documented would be the
 * worse trade.
 */
const retired = async (instType: string): Promise<string[]> => {
  try {
    const res = await fetch(`${PORTAL_INSTRUMENTS}?instType=${instType}`);

    if (! res.ok) throw new Error(`status ${res.status}`);

    const body = await res.json() as { data?: { instList?: string[] } };

    return body.data?.instList ?? [];
  } catch (err) {
    logger.warn({ err, instType },
      'OKX portal instrument list unavailable — delisted instruments will be missed this pass');

    return [];
  }
};

const instrumentData = async (instType: string): Promise<OkxInstrument[]> => {
  const res = await fetch(`${API}?instType=${instType}`);

  if (! res.ok) throw new Error(`OKX instruments listing failed ${res.status} for ${instType}`);

  const body = await res.json() as { data?: OkxInstrument[] };

  return body.data ?? [];
};

const name = (symbol: string, type: string, period: string): string =>
  `${symbol}-${type}-${period}.zip`;

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_resetCache = (): void => { cache.clear(); chainCache.clear(); };
export const _test_stemOf     = stemOf;
