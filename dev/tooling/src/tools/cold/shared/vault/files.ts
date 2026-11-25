import { locate } from './layout';
import { groupBy } from '../group';
import { byKey } from '../../order';
import { fmtBytes } from '../../../../shared/utils/format';
import type { StoredFile } from '../types';

/** Vault files by the venue of their partition, venues in order. */
export const byVenue = (files: readonly StoredFile[]): Map<string, StoredFile[]> =>
  new Map([...groupBy(files, file => locate(file.partition).levels['venue'] ?? '')].sort(byKey));

/** What vault files weigh together. */
export const bytesOf = (files: readonly StoredFile[]): number => files.reduce((sum, file) => sum + file.bytes, 0);

/** Vault files in a line: how many, how they stand, in how many partitions, and what they weigh — `12 files away in 3 partitions (1.2 GB)`. */
export const loadOf = (files: readonly StoredFile[], standing: string): string => {
  const partitions = new Set(files.map(file => file.partition)).size;

  return `${files.length.toLocaleString('en-US')} file${files.length === 1 ? '' : 's'} ${standing} `
    + `in ${partitions.toLocaleString('en-US')} partition${partitions === 1 ? '' : 's'} (${fmtBytes(bytesOf(files))})`;
};
