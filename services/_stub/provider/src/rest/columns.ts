import type { DataItem } from '../types';

/** Project a record down to the requested `columns` (BitMEX `columns` param). */
export const pick = (doc: DataItem, columns: string[]): DataItem => {
  const out: DataItem = {};

  for (const col of columns) if (col in doc) out[col] = doc[col];

  return out;
};
