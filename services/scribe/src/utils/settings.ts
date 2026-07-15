import config from '../config';
import type { TableConfig } from '../types';
import { getOrderedIndices, getTradingSymbols } from './symbols';

// trade & quote — S3 buckets missed the required pool field from pools rollout
// to 2026-07-13 (incl.). The gap is filled by collecting trade and quote data
// from the REST API for that period.
const TRADE_FROM = '20260416';
const QUOTE_FROM = '20260414';

const indexFilter = config.indexTickOnly ? { reference: 'BMI' } : undefined;

const ALL_TABLES: TableConfig[] = [
  { name: 'compositeIndex', path: '/instrument/compositeIndex', maxStart: 2500000, count: 1000, filter: indexFilter, symbols: getOrderedIndices, tsField: 'logged' },

  { name: 'funding',        path: '/funding',    maxStart: 2500000, count: 500                       },
  { name: 'insurance',      path: '/insurance',  maxStart: 2500000, count: 500                       },
  { name: 'settlement',     path: '/settlement', maxStart: 2500000, count: 500                       },

  { name: 'tick',  path: '/trade', maxStart: 100000,  count: 1000, filter: { size: 0 }                          },
  { name: 'trade', path: '/trade', maxStart: 100000,  count: 1000, from: TRADE_FROM, symbols: getTradingSymbols },
  { name: 'quote', path: '/quote', maxStart: 2500000, count: 1000, from: QUOTE_FROM, symbols: getTradingSymbols },
];

export const TABLES: TableConfig[] = config.tables.length === 0
  ? ALL_TABLES
  : ALL_TABLES.filter(t => config.tables.includes(t.name));
