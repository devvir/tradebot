import { q } from '../db';
import type { Format } from './types';

/**
 * Two ways to read a CSV, chosen per series by whether a header can be relied
 * on across the whole of its history.
 *
 * **By name** (`header: true`) for a venue that has always published one. A
 * column appended later then costs nothing: Bybit added `RPI` to perpetual
 * trades and `rpi` to spot in 2025-04, and a name-keyed projection did not
 * notice.
 *
 * **By position** (`header: false`) for everything else, with every column
 * declared in published order. That is the only option for a file carrying no
 * header — Binance spot, Gate, Bybit's MT4 klines — and it is also the right one
 * for a file that *grew* a header partway through its history, which nine
 * Binance futures datasets did between 2021-01 and 2022-07. Read positionally,
 * both eras are one shape: the header line in the later files parses as a row
 * whose timestamp is the text `open_time`, resolves to NULL, and is dropped by
 * the build. No boundary date is encoded anywhere.
 *
 * `null_padding` covers the mirror case — a file from before a column was
 * appended is short, and padding it keeps one declared list valid across the
 * change rather than splitting the series in two.
 *
 * Types are declared rather than sniffed: DuckDB's sampler reads the first
 * rows, and a column that is integral for a thousand rows and fractional later
 * would be typed wrong and silently truncated.
 */
/**
 * The column a positional read must never find anything in.
 *
 * One more name than the series declares, so a file wider than the map fills it
 * instead of being silently truncated to the declared width.
 */
const OVERFLOW = '_overflow_';

const positional = (paths: string[], names: string[]): string =>
  `read_csv([${paths.map(q).join(', ')}], header = false, all_varchar = true, ` +
  `null_padding = true, names = [${names.map(q).join(', ')}])`;

const declared = (series: { columns?: { as: string | null }[] }): string[] =>
  series.columns!.map((c, i) => c.as ?? `_drop_${i}`);

export const csv: Format = {
  relation: (paths, series) => {
    if (series.header)
      return `read_csv([${paths.map(q).join(', ')}], header = true, all_varchar = true)`;

    return positional(paths, [...declared(series), OVERFLOW]);
  },

  /**
   * Whether any file is **wider** than the series describes, sampled one row
   * per file.
   *
   * The asymmetry is the whole point. `null_padding` deliberately tolerates a
   * *short* row, because a venue appending a column later is ordinary evolution
   * and the older files simply lack it. A *wide* row is the opposite: this is
   * not the file the series describes, and reading it positionally cannot be
   * anything but wrong.
   *
   * Gate is why this exists. For 2021-07 it served **truncated copies of its
   * spot files** at the futures URL — 85 symbols — and spot carries an extra
   * column: `ts, id, price, size, side` against the futures `ts, id, price,
   * signed size`. Taking the first four columns of that put the *spot* size
   * where the signed futures size belongs, and since the side is derived from
   * that sign, every trade in 65 built partitions came out as `buy`. Twenty
   * more failed only by luck, on a truncated final line.
   *
   * One row per file rather than a scan: a published file has one shape
   * throughout, and the alternative is reading every month twice.
   */
  overflow: (paths, series) => {
    if (series.header) return null;

    const names = [...declared(series), OVERFLOW];

    // The overflow column is referenced, never quoted as a literal — `q()` here
    // would compare the string "_overflow_" against NULL and flag every file.
    const sample = (path: string) =>
      `SELECT ${q(path)} AS file, ${OVERFLOW} AS spill ` +
      `FROM (SELECT * FROM ${positional([path], names)} LIMIT 1)`;

    return `SELECT file FROM (${paths.map(sample).join(' UNION ALL ')}) WHERE spill IS NOT NULL`;
  },

  /**
   * Files that will not split into columns at all.
   *
   * **A CSV whose rows are narrower than its own header has no delimiter DuckDB
   * can agree on.** It tries each candidate, finds that none gives every line
   * the same field count, and falls back to reading each line whole — one
   * column, named for the entire header. The build then fails on a column that
   * plainly exists in the file, which is the least useful true statement
   * available: KuCoin's futures `1d` klines declare `time,open,high,low,close,
   * volume` and write five fields, and the error was
   * `Referenced column "time" not found in FROM clause! Candidate bindings:
   * "time", …` — the suggestion being the giant column whose *name* contains it.
   *
   * One column is the signal, and it needs no knowledge of the delimiter. Every
   * series maps a timestamp and at least one value, so a file this catalog can
   * use never parses as a single column; when one does, it is not the file the
   * series describes.
   *
   * Only header reads can land here. A positional read declares its own column
   * names and pads short rows by design, so it parses whatever it is given.
   */
  malformed: (paths, series) => {
    if (! series.header) return null;

    const shape = (path: string) =>
      `SELECT ${q(path)} AS file, len(Columns) AS cols FROM sniff_csv(${q(path)})`;

    return `SELECT file FROM (${paths.map(shape).join(' UNION ALL ')}) WHERE cols < 2`;
  },
};
