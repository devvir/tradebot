import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Container } from './types';

/** DuckDB decompresses gzip itself, so these are never extracted. */
export const gzip: Container = {
  native: true,
  unpack: async () => { throw new Error('gzip is read natively and is never unpacked'); },

  /**
   * A small file inflated where it stands. One that is large, or that will not
   * inflate, is not answered for: the engine reads it, and says what is wrong
   * with it.
   */
  members: (absolute) => {
    const size = statSync(absolute).size;

    if (size === 0) return [];
    if (size > SMALL_BYTES) return null;

    try {
      return [{ name: basename(absolute).replace(/\.gz$/, ''), data: gunzipSync(readFileSync(absolute)) }];
    } catch {
      return null;
    }
  },
};

/** The largest file read into memory, as it lies on disk. */
const SMALL_BYTES = 32 * 1024;
