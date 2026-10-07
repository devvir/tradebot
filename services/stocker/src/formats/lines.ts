import { q } from '../db';
import type { Format } from './types';

/**
 * A file whose every line is one value, read into one column, `line` — for a
 * file that is JSON a line under a one-word header, which KuCoin publishes as
 * a `.csv`. Its lines are full of commas and quotes that are JSON's, not a
 * table's, so nothing is split and nothing is unquoted: the series' own `rows`
 * decides what a line holds.
 */
export const lines: Format = {
  relation: (paths, _series, named) =>
    `read_csv([${paths.map(q).join(', ')}], header = false, auto_detect = false, ` +
    `delim = ${SEPARATOR}, quote = '', escape = '', max_line_size = ${LONGEST}, ` +
    `columns = {'line': 'VARCHAR'}${named ? ', filename = true' : ''})`,
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** A character no line holds, so no line is ever split. */
const SEPARATOR = `'\\x1F'`;

/** The longest line read, in bytes: a book of hundreds of levels a side is tens of kilobytes. */
const LONGEST = 16 * 1024 ** 2;
