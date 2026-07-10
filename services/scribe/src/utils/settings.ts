import config from '../config';
import type { TableConfig, RowFilter } from '../types';
import { getOrderedIndices, getTradingSymbols } from './symbols';

/** S3/courier owns trade & quote history up to 2026-03-31; scribe takes over from here. */
const TRADE_QUOTE_FROM = '20260401';

const indexFilter = config.indexTickOnly ? { reference: 'BMI' } : undefined;

/** Keep real trades; drop referential index prints (size 0 — those go to `tick`). */
const realTrades: RowFilter = row => row['size'] !== 0;

const ALL_TABLES: TableConfig[] = [
  { name: 'compositeIndex', path: '/instrument/compositeIndex', maxStart: 2500000, count: 1000, filter: indexFilter, symbols: getOrderedIndices, tsField: 'logged' },
  { name: 'tick',           path: '/trade',                     maxStart: 100000,  count: 1000, filter: { size: 0 } },
  { name: 'funding',        path: '/funding',                   maxStart: 2500000, count: 500                       },
  { name: 'insurance',      path: '/insurance',                 maxStart: 2500000, count: 500                       },
  { name: 'settlement',     path: '/settlement',                maxStart: 2500000, count: 500                       },

  // trade & quote — REST collection from 2026-04-01 (S3/courier owns earlier
  // history). Pool is selected through the generic `filter`; each splits into a
  // Primary (canonical) and a Secondary (analytics) table. trade has no symbol
  // filter (single task) and drops referential prints post-fetch; quote needs a
  // per-symbol subtask over trading symbols.
  { name: 'trade',           path: '/trade', maxStart: 100000,  count: 1000, from: TRADE_QUOTE_FROM, filter: { pool: 'Primary'   }, keep: realTrades },
  { name: 'trade.secondary', path: '/trade', maxStart: 100000,  count: 1000, from: TRADE_QUOTE_FROM, filter: { pool: 'Secondary' }, keep: realTrades },
  { name: 'quote',           path: '/quote', maxStart: 2500000, count: 1000, from: TRADE_QUOTE_FROM, filter: { pool: 'Primary'   }, symbols: getTradingSymbols },
  { name: 'quote.secondary', path: '/quote', maxStart: 2500000, count: 1000, from: TRADE_QUOTE_FROM, filter: { pool: 'Secondary' }, symbols: getTradingSymbols },
];

export const TABLES: TableConfig[] = config.tables.length === 0
  ? ALL_TABLES
  : ALL_TABLES.filter(t => config.tables.includes(t.name));
