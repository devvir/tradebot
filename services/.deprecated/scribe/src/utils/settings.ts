import config from '../config';
import type { TableConfig } from '../types';
import { getOrderedIndices, getTradingSymbols } from './symbols';

// trade & quote — S3 buckets missed the required pool field from pools rollout
// to 2026-07-13 (incl.). The gap is filled by collecting trade and quote data
// from the REST API for that period.
const TRADE_FROM = '20260416';
const QUOTE_FROM = '20260414';

const indexFilter = config.indexTickOnly ? { reference: 'BMI' } : undefined;

const BIN_SIZES = ['1m', '5m', '1h', '1d'];

/**
 * OHLCV bins, one table per resolution. All four share an endpoint and differ
 * only by `binSize`, so they are generated rather than spelled out. Names match
 * BitMEX's own table names (tradeBin1m, quoteBin5m, …) so they line up with the
 * WS tables the rest of the pipeline already speaks.
 *
 * No symbol fan-out: the endpoint returns every symbol's bars on one clock, so
 * a single timestamp-ordered stream is both cheaper and already sorted. No
 * `from` either — unlike raw trade/quote (whose early history is S3's), bins
 * exist only over REST, back to 2014-11-22.
 *
 * `pool=Primary` is pinned. Left unset, the endpoint tags bars `Primary` up to
 * 2026-03-03 and `Aggregated` from 2026-03-04 on — so an unpinned backfill would
 * change basis mid-history, and the tail would be the one form that cannot be
 * decomposed back into pools. Pinning holds one basis across the whole range.
 */
const binTables = (source: 'trade' | 'quote'): TableConfig[] =>
  BIN_SIZES.map(binSize => ({
    name:     `${source}Bin${binSize}`,
    path:     `/${source}/bucketed`,
    count:    1000,
    maxStart: 2500000,
    params:   { binSize, pool: 'Primary' },
  }));

const ALL_TABLES: TableConfig[] = [
  { name: 'compositeIndex', path: '/instrument/compositeIndex', maxStart: 2500000, count: 1000, filter: indexFilter,
    symbols: getOrderedIndices,
    tsField: 'logged' },

  { name: 'funding',        path: '/funding',    maxStart: 2500000, count: 500 },
  { name: 'insurance',      path: '/insurance',  maxStart: 2500000, count: 500 },
  { name: 'settlement',     path: '/settlement', maxStart: 2500000, count: 500 },

  { name: 'tick',  path: '/trade', maxStart: 100000,  count: 1000, filter: { size: 0 }                          },
  { name: 'trade', path: '/trade', maxStart: 100000,  count: 1000, from: TRADE_FROM, symbols: getTradingSymbols },
  { name: 'quote', path: '/quote', maxStart: 2500000, count: 1000, from: QUOTE_FROM, symbols: getTradingSymbols },

  ...binTables('trade'),
  ...binTables('quote'),
];

export const TABLES: TableConfig[] = config.tables.length === 0
  ? ALL_TABLES
  : ALL_TABLES.filter(t => config.tables.includes(t.name));
