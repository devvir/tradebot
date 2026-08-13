import { after, htmlList } from './listing';
import { atCutover } from './granularity';
import type { ArchiveFile } from '../types';
import type { VenueArchive } from './types';

const HOST = 'https://public.bybit.com';

/**
 * Bybit publishes an HTML directory index. Filenames are **inconsistent across
 * categories** — `BTCUSDT2026-07-25.csv.gz` under `trading/`,
 * `BTCUSDT_2026-07-25.csv.gz` under `spot/`, and monthly `BTCUSDT-2022-11.csv.gz`
 * in spot's early history — so names are always taken from the listing and never
 * constructed. No checksums.
 */
export const bybit: VenueArchive = {
  name: 'bybit',

  /**
   * The oldest key bybit publishes **anywhere** is `20191001`, on the premium
   * index and spot index of `BTCUSD`, `EOSUSD`, `ETHUSD` and `XRPUSD` — 1,104
   * files across three months. Read from the catalog, which lists every key of
   * every tree, rather than from bybit's founding date.
   *
   * **A floor is the earliest key of any dataset, not of the deepest one.** This
   * said `202001` for a long time, taken from the oldest of 2,649 *trade* ranges
   * — true of trades, and three months short of the archive. Those months were
   * therefore never walked and never closed, while raw fetched by an earlier
   * symbol-first pass sat on disk unaccounted for, and stocker built partitions
   * from four symbols of a period nothing had collected properly.
   */
  floor: '201910',

  datasets: [
    // Perp publishes days and nothing else — 2,316 files on BTCUSDT, not one of
    // them monthly — so its history is days all the way back to 2020-03-25.
    // Spot lists 44 monthly files alongside their days, which is a duplication
    // the cutover resolves. Both facts come out of the listing, not from here.
    { id: 'perp-trades', kind: 'trades', market: 'trading', path: 'trading' },
    { id: 'spot-trades', kind: 'trades', market: 'spot',    path: 'spot'    },

    // MT4 klines nest a year below the symbol, so listing the symbol directory
    // returns year folders rather than files — hence the extra descent below.
    { id: 'mt4-klines', kind: 'klines', market: 'kline_for_metatrader4',
      path: 'kline_for_metatrader4' },

    // Both ended in March 2020 and never resumed. Collected because they are
    // small, complete, and the only premium/index history Bybit ever published.
    { id: 'premium-index', kind: 'index', market: 'premium_index', path: 'premium_index' },
    { id: 'spot-index',    kind: 'index', market: 'spot_index',    path: 'spot_index'    },
  ],

  symbols: async (dataset) => {
    const entries = await htmlList(`${HOST}/${dataset.market}/`);

    return entries.map(e => e.replace(/\/$/, '')).filter(Boolean).sort();
  },

  files: async (dataset, symbol, since) => {
    const dir     = `${dataset.market}/${symbol}/`;
    const entries = await htmlList(`${HOST}/${dir}`);

    const listed = await walk(dir, entries);

    const files = listed
      .filter(e => e.endsWith('.csv.gz'))
      .map<ArchiveFile>(name => ({
        url:    `${HOST}/${dir}${name}`,
        path:   `${dir}${name}`,
        date:   dateOf(name),
        symbol,
        period: isMonthly(name) ? 'monthly' : 'daily',
      }))
      .filter(f => f.date !== '');

    // Spot lists a monthly file and that month's dailies in the same directory
    // — 44 months over on BTCUSDT alone. Perp publishes dailies only, so before
    // the cutover it contributes nothing and after it contributes everything.
    return after(atCutover(files), since);
  },
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Collect every file beneath a directory, whatever depth it is nested at.
 *
 * Bybit's categories disagree: trades sit directly under the symbol, MT4 klines
 * are grouped by year below it. Rather than encode either shape, this follows
 * whatever directories it finds — a category that adds a level later is picked
 * up without a change here.
 */
const walk = async (base: string, entries: string[]): Promise<string[]> => {
  const files = entries.filter(e => ! e.endsWith('/'));
  const dirs  = entries.filter(e =>   e.endsWith('/'));

  const nested = await Promise.all(dirs.map(async sub => {
    const inner = await htmlList(`${HOST}/${base}${sub}`);

    return (await walk(`${base}${sub}`, inner)).map(name => `${sub}${name}`);
  }));

  return [...files, ...nested.flat()];
};

const isMonthly = (name: string): boolean => /-\d{4}-\d{2}\.csv\.gz$/.test(name);

/**
 * The date a file covers, taken as the **last** one appearing in its name.
 *
 * Bybit dates its files four different ways and only two of them put the date
 * last: trades end in it (`BTCUSDT2026-07-28.csv.gz`), MT4 klines carry a range
 * (`BTCUSDT_15_2023-01-01_2023-01-31.csv.gz`), and the index series *suffix* it
 * with the series name (`BTCUSD2019-10-01_premium_index.csv.gz`). Anchoring on
 * the extension therefore silently discarded every index file — the dataset
 * listed hundreds and collected none.
 *
 * Scanning for dates anywhere and taking the last keeps all four working, and
 * keeps the wanted behaviour on a range: a period is settled once the whole
 * span it covers is complete, so the file is keyed by the end of its range.
 */
const dateOf = (name: string): string => {
  const days = [...name.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)];

  if (days.length) {
    const [, year, month, day] = days[days.length - 1]!;

    return `${year}${month}${day}`;
  }

  const months = [...name.matchAll(/(\d{4})-(\d{2})(?!\d)/g)];

  if (months.length) {
    const [, year, month] = months[months.length - 1]!;

    return `${year}${month}`;
  }

  return '';
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_dateOf = dateOf;
