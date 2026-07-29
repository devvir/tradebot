import type { Container } from './types';

/** DuckDB decompresses gzip itself, so these are never extracted. */
export const gzip: Container = {
  native: true,
  unpack: async () => { throw new Error('gzip is read natively and is never unpacked'); },
};
