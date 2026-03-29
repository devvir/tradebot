import type { TableConfig } from '../types';

export const PAGE_SIZE = 500;

export const TABLES: TableConfig[] = [
  { name: 'compositeIndex', path: '/instrument/compositeIndex', maxStart: 2500000 },
  { name: 'funding',        path: '/funding',                   maxStart: 2500000 },
  { name: 'insurance',      path: '/insurance',                 maxStart: 2500000 },
  { name: 'settlement',     path: '/settlement',                maxStart: 2500000 },
];
