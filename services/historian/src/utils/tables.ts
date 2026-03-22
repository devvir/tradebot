import type { TableConfig } from '../types.js';

export const PAGE_SIZE = 500;

export const TABLES: TableConfig[] = [
  { name: 'funding',        path: '/funding',                     auth: false, symbolSource: null,          idFields: ['timestamp', 'symbol'],     maxStart: 2500000 },
  { name: 'compositeIndex', path: '/instrument/compositeIndex',   auth: false, symbolSource: 'indices',     idFields: null,                        maxStart: 2500000, symbolField: 'indexSymbol' },
  { name: 'insurance',      path: '/insurance',                   auth: false, symbolSource: null,          idFields: ['currency', 'timestamp'],   maxStart: 2500000 },
  { name: 'quote',          path: '/quote',                       auth: false, symbolSource: 'instruments', idFields: null,                        maxStart: 2500000 },
  { name: 'settlement',     path: '/settlement',                  auth: false, symbolSource: null,          idFields: ['timestamp', 'symbol'],     maxStart: 2500000 },
  { name: 'trade',          path: '/trade',                       auth: false, symbolSource: null,          idFields: null,                        maxStart: 100000  },
];
