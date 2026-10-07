import { q } from '../db';
import type { Format } from './types';

/**
 * One JSON object per line — how OKX, HTX, Bybit and Gate publish order books.
 *
 * Where the series names the fields it reads and their types (`fields`), those
 * are what is read: nothing is sampled, a field a venue adds is ignored, and one
 * a record lacks is NULL. Sampling is wrong for a book — a file whose first
 * records hold an empty side gives that side no type at all. Without `fields`
 * the shape is inferred and files are folded by name.
 */
export const ndjson: Format = {
  relation: (paths, series, named) => {
    const shape = series.fields
      ? `columns = {${Object.entries(series.fields).map(([name, type]) => `${q(name)}: ${q(type)}`).join(', ')}}`
      : 'union_by_name = true';

    return `read_json([${paths.map(q).join(', ')}], format = 'newline_delimited', ${shape}, ` +
      `maximum_object_size = ${LARGEST}${named ? ', filename = true' : ''})`;
  },
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** The largest record read, in bytes: a book image of thousands of levels a side is a megabyte on one line. */
const LARGEST = 256 * 1024 ** 2;
