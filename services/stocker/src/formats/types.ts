import type { Series } from '../types';

/**
 * A format turns decoded files into a SQL relation the engine can select from.
 *
 * Keeping this behind an interface is what lets a new shape — a JSON book
 * stream, a spreadsheet, whatever a future REST collector writes — arrive
 * without touching the build pipeline.
 */
export interface Format {
  /** DuckDB extensions this format needs loaded before it can be read. */
  extensions?: string[];

  /** A relation expression: valid anywhere a table name would go in `FROM`. */
  relation(paths: string[], series: Series): string;

  /**
   * A query listing files whose shape is wider than the series describes, or
   * null where the format cannot be read positionally and the question does not
   * arise. One row per offending file, first column its path.
   *
   * Positional reading is only meaningful while the width matches; a wider file
   * is a different file, and mapping it by position is silently wrong rather
   * than merely incomplete.
   */
  overflow?(paths: string[], series: Series): string | null;

  /**
   * A query listing files that do not parse into columns at all, or null where
   * the format cannot fail that way.
   *
   * **Asked only after a build has already failed, unlike `overflow`.** The two
   * guard opposite risks and so run at opposite times. A file *wider* than the
   * series is read successfully and means something other than what the map
   * says, so it has to be caught before anything is written. A file that will
   * not parse cannot produce wrong data — it produces no data — so the build
   * fails on its own, and this exists only to say *why* in terms of the file
   * rather than in terms of SQL.
   *
   * That asymmetry is what keeps it free: the happy path never runs it.
   */
  malformed?(paths: string[], series: Series): string | null;
}
