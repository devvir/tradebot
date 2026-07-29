import { q } from '../db';
import type { Format } from './types';

/**
 * Bitget ships klines and depth as Excel inside the zip, while its trades are
 * plain CSV — so the container extension says nothing about the format and the
 * series must declare it.
 *
 * Unlike the CSVs, these files *do* carry a header row.
 */
export const xlsx: Format = {
  extensions: ['excel'],

  /**
   * One reader per file, unioned **by name**.
   *
   * `read_xlsx` takes a single path — unlike `read_csv` it rejects a list — so
   * a month of daily sheets cannot be handed over as one relation.
   *
   * **It accepts a glob and then reads only one of the matches**, with no error:
   * two sheets of 4,663 and 8,893 rows glob to 8,893, not 13,556. That is a
   * silent loss of a month's data, so a glob is not an alternative here even
   * where the files could be gathered into one directory — which they cannot
   * be anyway, since each zip extracts to its own scratch directory and a glob
   * wide enough to span them would also catch whatever another build is
   * extracting at that moment.
   *
   * `BY NAME` rather than positionally, because the sheets carry headers and a
   * union by position would silently transpose two columns if a venue ever
   * reordered them mid-history. Matching on the names the header states costs
   * nothing and cannot misalign.
   *
   * These files are small — a day of Bitget depth is a few hundred KB against
   * the hundreds of MB a CSV month runs to — so the per-reader overhead that
   * makes this shape wrong for CSV does not arise.
   */
  relation: (paths) => {
    if (paths.length === 0) throw new Error('xlsx needs at least one sheet file');

    const read = (path: string) =>
      `SELECT * FROM read_xlsx(${q(path)}, header = true, all_varchar = true)`;

    return `(${paths.map(read).join(' UNION ALL BY NAME ')})`;
  },
};
