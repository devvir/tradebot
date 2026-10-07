import { q } from '../db';
import type { Format } from './types';
import type { Series } from '../types';

/**
 * Plain text, a record a line, its values parted by blanks — how gate writes
 * the small files it names by the moment they hold, where a line is an
 * instrument and nothing in the file says when.
 *
 * **Read whole and cut here, never handed to the CSV reader.** A blank is not a
 * delimiter that reader can be trusted with: gate's lines end in one, and some
 * begin with one (` DOGE_USD1 0.1003325 `), which a split on single blanks
 * turns into an empty first column and every value one place to the right. So
 * a line is trimmed and cut on runs of blanks, and what the series declares is
 * taken by position from that.
 *
 * Every row carries `filename`, asked for or not: the time of a row is in the
 * name of its file, and the series reads it from there.
 */
export const words: Format = {
  relation: (paths, series) => {
    const cells = declared(series).map((name, at) => `w[${at + 1}] AS "${name}"`);

    return `(SELECT filename, ${cells.join(', ')}, len(w) AS ${WIDTH} FROM (` +
      `SELECT filename, regexp_split_to_array(trim(line, ${BLANKS}), '\\s+') AS w FROM (` +
      `SELECT filename, unnest(string_split(content, chr(10))) AS line ` +
      `FROM read_text([${paths.map(q).join(', ')}])) WHERE trim(line, ${BLANKS}) <> ''))`;
  },

  wide: series => `${WIDTH} > ${series.columns!.length}`,

  /**
   * By each file's first line alone: a published file has one shape throughout,
   * and cutting every line of a month of them twice is most of the build.
   */
  overflow: (paths, series) =>
    `SELECT filename FROM (SELECT filename, ` +
    `len(regexp_split_to_array(trim(split_part(content, chr(10), 1), ${BLANKS}), '\\s+')) AS ${WIDTH} ` +
    `FROM read_text([${paths.map(q).join(', ')}])) WHERE ${WIDTH} > ${series.columns!.length}`,
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** How many values a line held, beside the ones the series names. */
const WIDTH = '_words_';

/** What a line is trimmed of: blanks, tabs and the carriage return of a CRLF file. */
const BLANKS = `' ' || chr(9) || chr(13)`;

const declared = (series: Series): string[] =>
  series.columns!.map((column, at) => column.as ?? `_drop_${at}`);
