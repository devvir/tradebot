import config from '../config';
import type { TableConfig } from '../types';

export const PAGE_SIZE = 500;

const indexFilter = config.indexTickOnly ? { reference: 'BMI' } : undefined;

export const TABLES: TableConfig[] = [
  { name: 'compositeIndex', path: '/instrument/compositeIndex', maxStart: 2500000, count: 1000, filter: indexFilter },
  { name: 'tick',           path: '/trade',                     maxStart: 100000,  count: 1000, filter: { size: 0 } },
  { name: 'funding',        path: '/funding',                   maxStart: 2500000, count: 500                       },
  { name: 'insurance',      path: '/insurance',                 maxStart: 2500000, count: 500                       },
  { name: 'settlement',     path: '/settlement',                maxStart: 2500000, count: 500                       },
];
