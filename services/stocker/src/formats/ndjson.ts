import { q } from '../db';
import type { Format } from './types';

/**
 * One JSON object per line — how OKX and HTX publish order books. Read as
 * loosely-typed JSON so a venue adding a field cannot break the read; the
 * projection decides what is kept.
 */
export const ndjson: Format = {
  relation: (paths) =>
    `read_json([${paths.map(q).join(', ')}], format = 'newline_delimited', union_by_name = true)`,
};
