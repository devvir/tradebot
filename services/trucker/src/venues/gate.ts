import { logger } from '@devvir/service-kit';
import { GATE_202107_SPOT_AT_FUTURES_URL } from './gate.excluded';
import { after, ttlCache } from './listing';
import {
  dateRange, endOfMonth, latest, monthRange, msToYMD, nextDay, nextMonth, thisMonthUTC,
  yesterdayUTC,
} from '../dates';
import type { ArchiveFile, Dataset } from '../types';
import type { VenueArchive } from './types';

const HOST  = 'https://download.gatedata.org';

/**
 * The download portal's own symbol list — the one place delisted pairs still
 * appear, keyed by the same market names used throughout.
 */
const PORTAL_SYMBOLS = 'https://www.gate.com/api/web/v1/tst/market_symbols';

/**
 * TradFi keeps its own catalogue — 680 instruments, gold and equity indices
 * rather than pairs, and absent from every crypto endpoint including the portal
 * symbol list. Same browser headers as the rest of gate's web API.
 */
const TRADFI_SYMBOLS = 'https://www.gate.com/apim/v3/tradfi-api/v1/symbols';

/**
 * It answers 403 to anything that does not look like a browser navigating to
 * it. Each of these was removed in turn and each removal brought the 403 back,
 * so they are sent verbatim rather than trimmed to what looks necessary.
 */
const BROWSER: Record<string, string> = {
  'sec-ch-ua-platform': '"Linux"',
  'sec-fetch-dest':     'document',
  'sec-fetch-mode':     'navigate',
  'sec-fetch-site':     'none',
  'sec-fetch-user':     '?1',
  'user-agent':         'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
                      + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
};
const START = '201801';

/**
 * TradFi opened later than the crypto markets: `XAUUSD` 1h is 404 for every
 * month of 2023 tried and 200 from 2024-01 onward.
 */
const TRADFI_START = '202401';

/** The portal dates the book archive to August 2021. */
const BOOKS_START = '20210801';

/**
 * Gate publishes **monthly** files at constructible URLs with no listing, so
 * months are enumerated and probed; a 404 means the market did not trade that
 * month.
 *
 * Monthly is the only shape offered, at every date — the cutover does not apply
 * here, because there is nothing to choose between. A month appears only once it
 * has closed (`202607` was 404 while July was running, `202606` served 200), so
 * the running month is simply absent until it is not, and the generous absence
 * window for monthly periods is what stops the cursor stepping over one that
 * publishes a few days late.
 *
 * Spot calls its trade series `deals`, futures call theirs `trades`.
 */
export const gate: VenueArchive = {
  name: 'gate',

  constructsUrls: true,

  /**
   * Bisected on `BTC_USDT` spot deals: `201712` is 404 and `201801` is 200,
   * with 2016-01 through 2017-11 all absent. Gate's own download form offers
   * only 2023-01 onward, so the portal understates the archive by five years —
   * see `docs/venues/GATE.md`.
   */
  floor: START,

  datasets: [
    { id: 'spot-deals',          kind: 'trades', market: 'spot',         path: 'deals'  },
    { id: 'futures_usdt-trades', kind: 'trades', market: 'futures_usdt', path: 'trades' },
    { id: 'futures_btc-trades',  kind: 'trades', market: 'futures_btc',  path: 'trades' },

    // Intervals differ per market and were probed one by one rather than
    // assumed. Futures publish 10s, 1m, 5m, 1h, 4h, 1d and 7d; 30s, 15m, 30m
    // and 8h are 404. **Spot publishes only the four longest** — its 1m and 5m
    // are absent at both 2024-08 and 2026-05, which is why spot candlesticks
    // were once thought not to exist at all.
    // 30s, 1m and 5m are **daily** files — gate generates only those three per
    // day, which is why every monthly URL for them answers NoSuchKey.
    { id: 'spot-candlesticks_30s', kind: 'klines', market: 'spot', path: 'candlesticks_30s' },
    { id: 'spot-candlesticks_1m',  kind: 'klines', market: 'spot', path: 'candlesticks_1m'  },
    { id: 'spot-candlesticks_5m',  kind: 'klines', market: 'spot', path: 'candlesticks_5m'  },

    { id: 'spot-candlesticks_1h', kind: 'klines', market: 'spot', path: 'candlesticks_1h' },
    { id: 'spot-candlesticks_4h', kind: 'klines', market: 'spot', path: 'candlesticks_4h' },
    { id: 'spot-candlesticks_1d', kind: 'klines', market: 'spot', path: 'candlesticks_1d' },
    { id: 'spot-candlesticks_7d', kind: 'klines', market: 'spot', path: 'candlesticks_7d' },

    { id: 'futures_usdt-candlesticks_10s', kind: 'klines', market: 'futures_usdt', path: 'candlesticks_10s' },
    { id: 'futures_usdt-candlesticks_1m', kind: 'klines', market: 'futures_usdt', path: 'candlesticks_1m' },
    { id: 'futures_usdt-candlesticks_5m', kind: 'klines', market: 'futures_usdt', path: 'candlesticks_5m' },
    { id: 'futures_usdt-candlesticks_1h', kind: 'klines', market: 'futures_usdt', path: 'candlesticks_1h' },
    { id: 'futures_usdt-candlesticks_4h', kind: 'klines', market: 'futures_usdt', path: 'candlesticks_4h' },
    { id: 'futures_usdt-candlesticks_1d', kind: 'klines', market: 'futures_usdt', path: 'candlesticks_1d' },
    { id: 'futures_usdt-candlesticks_7d', kind: 'klines', market: 'futures_usdt', path: 'candlesticks_7d' },

    { id: 'futures_btc-candlesticks_10s', kind: 'klines', market: 'futures_btc',  path: 'candlesticks_10s' },
    { id: 'futures_btc-candlesticks_1m',  kind: 'klines', market: 'futures_btc',  path: 'candlesticks_1m' },
    { id: 'futures_btc-candlesticks_5m',  kind: 'klines', market: 'futures_btc',  path: 'candlesticks_5m' },
    { id: 'futures_btc-candlesticks_1h',  kind: 'klines', market: 'futures_btc',  path: 'candlesticks_1h' },
    { id: 'futures_btc-candlesticks_4h',  kind: 'klines', market: 'futures_btc',  path: 'candlesticks_4h' },
    { id: 'futures_btc-candlesticks_1d',  kind: 'klines', market: 'futures_btc',  path: 'candlesticks_1d' },
    { id: 'futures_btc-candlesticks_7d',  kind: 'klines', market: 'futures_btc',  path: 'candlesticks_7d' },

    // TradFi — gold, indices and their leveraged variants. Candlesticks only:
    // no trades, no depth, no funding, and no 5m or 7d. Monthly files, from
    // 2024-01 (2023-12 and earlier are 404).
    { id: 'tradfi-candlesticks_10s', kind: 'klines', market: 'tradfi', path: 'candlesticks_10s' },
    { id: 'tradfi-candlesticks_1m',  kind: 'klines', market: 'tradfi', path: 'candlesticks_1m'  },
    { id: 'tradfi-candlesticks_15m', kind: 'klines', market: 'tradfi', path: 'candlesticks_15m' },
    { id: 'tradfi-candlesticks_1h',  kind: 'klines', market: 'tradfi', path: 'candlesticks_1h'  },
    { id: 'tradfi-candlesticks_4h',  kind: 'klines', market: 'tradfi', path: 'candlesticks_4h'  },
    { id: 'tradfi-candlesticks_1d',  kind: 'klines', market: 'tradfi', path: 'candlesticks_1d'  },

    { id: 'futures_usdt-mark_prices', kind: 'mark', market: 'futures_usdt', path: 'mark_prices' },
    { id: 'futures_btc-mark_prices',  kind: 'mark', market: 'futures_btc',  path: 'mark_prices' },

    // Two distinct series: what was applied at the end of an interval, and the
    // running estimate for the next one.
    { id: 'futures_usdt-funding_applies', kind: 'funding', market: 'futures_usdt', path: 'funding_applies' },
    { id: 'futures_usdt-funding_updates', kind: 'funding', market: 'futures_usdt', path: 'funding_updates' },
    { id: 'futures_btc-funding_applies',  kind: 'funding', market: 'futures_btc',  path: 'funding_applies' },
    { id: 'futures_btc-funding_updates',  kind: 'funding', market: 'futures_btc',  path: 'funding_updates' },

    // Books are the one series Gate publishes **hourly** — 24 files per day.
    //
    // Two products, and they are not two names for one thing. `orderbooks` is
    // the event stream: `timestamp, side, action, price, amount, begin_id,
    // merged`, where `set` re-benchmarks and `take`/`make` adjust. Its
    // companion `orderbooks_slice` is the state: `asks[price, qty],
    // bids[price, qty], update, current, id` — whole book snapshots, and a
    // plain `.gz` rather than `.csv.gz`.
    { id: 'spot-orderbooks',         kind: 'book', market: 'spot',         path: 'orderbooks' },
    { id: 'futures_usdt-orderbooks', kind: 'book', market: 'futures_usdt', path: 'orderbooks' },
    { id: 'futures_btc-orderbooks',  kind: 'book', market: 'futures_btc',  path: 'orderbooks' },

  ],

  symbols: async (dataset) => [...(await listings(dataset)).keys()].sort(),

  files: async (dataset, symbol, since) => {
    const listed = (await listings(dataset)).get(symbol) ?? `${START}01`;

    if (dataset.kind === 'book') return hourly(dataset, symbol, since, listed);

    if (DAILY.has(dataset.id)) return byDay(dataset, symbol, since, listed);

    // Starting each symbol at the month it began trading is what makes a
    // constructing venue affordable: without it every symbol is probed from the
    // archive floor regardless of when it listed, and 856 of Gate's 867 USDT
    // contracts began after 2019.
    const floor  = dataset.market === 'tradfi' ? TRADFI_START : START;
    const opened = latest(since ? nextMonth(since.slice(0, 6)) : floor, listed.slice(0, 6));
    const files  = monthRange(opened, thisMonthUTC()).map<ArchiveFile>(month => {
      const name = `${symbol}-${month}.csv.gz`;

      return {
        url:    `${HOST}/${dataset.market}/${dataset.path}/${month}/${name}`,
        path:   `${dataset.market}/${dataset.path}/${month}/${name}`,
        // Keyed by the month's last day: progress is counted in days on every
        // venue, whatever span its files happen to cover.
        date:   endOfMonth(month),
        symbol,
        period: 'monthly',
      };
    });

    return after(excluded(dataset, files), since);
  },
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Drop the files gate publishes but that are not what their path claims.
 *
 * One month, one dataset: `futures_usdt/trades/202107` served the spot file for
 * 85 symbols. Filtered here rather than downloaded and cleaned up afterwards,
 * because a cleanup lives in the filesystem and the filesystem is rebuilt from
 * this walk — every ledger reset would restore the garbage otherwise.
 */
const excluded = (dataset: Dataset, files: ArchiveFile[]): ArchiveFile[] => {
  if (dataset.id !== 'futures_usdt-trades') return files;

  return files.filter(file => ! (file.date.startsWith('202107')
    && GATE_202107_SPOT_AT_FUTURES_URL.includes(file.symbol)));
};

/**
 * The series gate generates a file a day for, rather than a file a month.
 *
 * Only the three shortest spot intervals. Everything else — futures at every
 * interval, and spot from 1h up — is monthly, and asking for a day of it
 * answers NoSuchKey.
 */
const DAILY = new Set([
  'spot-candlesticks_30s', 'spot-candlesticks_1m', 'spot-candlesticks_5m',
]);

/** A day per file, under the month's directory — `…/202607/BTC_USDT-20260701.csv.gz`. */
const byDay = (
  dataset: Dataset,
  symbol:  string,
  since:   string | null,
  listed:  string,
): ArchiveFile[] => {
  const from  = latest(since ? nextDay(since) : `${START}01`, latest(listed, `${START}01`));
  const files = dateRange(from, yesterdayUTC()).map<ArchiveFile>((date) => {
    const name = `${symbol}-${date}.csv.gz`;
    const path = `${dataset.market}/${dataset.path}/${date.slice(0, 6)}/${name}`;

    return { url: `${HOST}/${path}`, path, date, symbol, period: 'daily' };
  });

  return after(files, since);
};

/**
 * Books are published as 24 files a day, `{symbol}-{yyyymmdd}{HH}.csv.gz`.
 *
 * All 24 carry the **same date**, so the day settles only once every hour of it
 * has landed and the cursor never steps over a partial day. Re-listing a day
 * already on disk costs 24 `stat` calls and no requests, which is why an
 * interrupted day is simply resumed rather than tracked hour by hour.
 */
const hourly = (
  dataset: Dataset,
  symbol:  string,
  since:   string | null,
  listed:  string,
): ArchiveFile[] => {
  const from  = latest(since ? nextDay(since) : BOOKS_START, latest(listed, BOOKS_START));
  const files: ArchiveFile[] = [];

  for (const date of dateRange(from, yesterdayUTC())) {
    for (let hour = 0; hour < 24; hour++) {
      const name = `${symbol}-${date}${String(hour).padStart(2, '0')}.csv.gz`;
      const path = `${dataset.market}/${dataset.path}/${date.slice(0, 6)}/${name}`;

      files.push({ url: `${HOST}/${path}`, path, date, symbol, period: 'daily' });
    }
  }

  return after(files, since);
};

/**
 * symbol → listing date (`yyyymmdd`) per market, cached with an expiry so the
 * periodic rescan discovers new listings. Shared by `symbols` and `files`, so a
 * sweep asks the API once per market rather than once per dataset.
 */
const cache = ttlCache<Map<string, string>>(12 * 60 * 60 * 1000);

/**
 * Symbols with the date each began trading.
 *
 * Gate publishes no archive listing, so without this every symbol is probed
 * across every month back to the archive floor — 856 of the 867 USDT contracts
 * began after 2019, and under a 2019 ceiling every one of those probes is a
 * guaranteed 404.
 *
 * Futures carry `launch_time` and `create_time`, spot `buy_start` and
 * `sell_start`, all in **seconds**. None of them is reliable alone: Gate's spot
 * pairs disagree between their two stamps often enough to matter — `PEIPEI_USDT`
 * reads 2024-06-14 to buy and 2020-12-07 to sell — so the earliest of whatever
 * is populated is taken. A floor that is too early only costs probes; one that
 * is too late silently skips data that exists.
 */
const listings = async (dataset: Dataset): Promise<Map<string, string>> => {
  const market = dataset.market;
  const held   = cache.get(market);

  if (held) return held;

  const map = new Map<string, string>();

  if (market === 'tradfi') {
    // No listing date is published for these — `open_time` is the current
    // session's, not the instrument's first day — so each starts at the
    // market's own floor.
    for (const symbol of await tradfi()) map.set(symbol, `${TRADFI_START}01`);

    cache.set(market, map);

    return map;
  }

  if (market === 'spot') {
    const pairs = await api<{ id: string; buy_start?: number; sell_start?: number }>('spot/currency_pairs');

    for (const pair of pairs) map.set(pair.id, openedAt(pair.buy_start, pair.sell_start));
  } else {
    const settle    = market === 'futures_btc' ? 'btc' : 'usdt';
    const contracts = await api<{ name: string; launch_time?: number; create_time?: number }>(`futures/${settle}/contracts`);

    for (const c of contracts) map.set(c.name, openedAt(c.launch_time, c.create_time));
  }

  // Delisted pairs are absent from the API and their files are still served, so
  // the archive is reachable only for as long as the name is known. The download
  // portal's own list keeps them. A dead pair has no listing date left to read
  // and is walked from the archive floor.
  for (const name of await retired(market)) {
    if (! map.has(name)) map.set(name, market === 'spot' ? START : `${START}01`);
  }

  cache.set(market, map);

  return map;
};

/**
 * TradFi's instrument list. A failure leaves the market empty for this pass
 * rather than stopping the venue.
 */
const tradfi = async (): Promise<string[]> => {
  try {
    const res = await fetch(TRADFI_SYMBOLS, { headers: BROWSER });

    if (! res.ok) throw new Error(`status ${res.status}`);

    const body = await res.json() as { data?: { list?: { symbol?: string }[] } };

    return (body.data?.list ?? []).map(entry => entry.symbol ?? '').filter(Boolean);
  } catch (err) {
    logger.warn({ err }, 'Gate TradFi symbol list unavailable — skipping the market this pass');

    return [];
  }
};

/**
 * Every symbol the download portal knows for a market, living or not.
 *
 * The endpoint refuses anything that does not look like a browser navigating to
 * it — every one of these headers was removed in turn and each removal brought
 * back a 403 — so they are sent verbatim rather than trimmed to what looks
 * necessary.
 *
 * A failure is not fatal: the live catalogue is already in hand, so a pass
 * collects what is trading and misses the dead ones until the next sweep.
 */
const retired = async (market: string): Promise<string[]> => {
  try {
    const res = await fetch(PORTAL_SYMBOLS, { headers: BROWSER });

    if (! res.ok) throw new Error(`status ${res.status}`);

    const body = await res.json() as { data?: Record<string, string[]> };

    // Keyed by gate's own market names, and spelt in lower case where the
    // archive is upper — `cvxg_usdt` for `CVXG_USDT`.
    return (body.data?.[market] ?? []).map(name => name.toUpperCase());
  } catch (err) {
    logger.warn({ err, market },
      'Gate portal symbol list unavailable — delisted pairs will be missed this pass');

    return [];
  }
};

/** The earliest of the stamps a market populates, or the archive floor. */
const openedAt = (...stamps: (number | undefined)[]): string => {
  const seconds = stamps.filter((s): s is number => Number.isFinite(s) && s! > 0);

  if (seconds.length === 0) return `${START}01`;

  return msToYMD(Math.min(...seconds) * 1000);
};

/**
 * Gate's public API, with the failure modes made loud: a non-2xx or an empty
 * universe throws, so a metadata blip fails the dataset for this sweep instead
 * of being read as "no symbols" and collecting nothing in silence.
 */
const api = async <T>(path: string): Promise<T[]> => {
  const res = await fetch(`https://api.gateio.ws/api/v4/${path}`);

  if (! res.ok) throw new Error(`Gate listing failed ${res.status}: ${path}`);

  const body = await res.json() as T[];

  if (! Array.isArray(body) || body.length === 0)
    throw new Error(`Gate returned no entries for ${path}`);

  return body;
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_resetCache = (): void => cache.clear();
