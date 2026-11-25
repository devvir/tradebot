import { parse, type Parser } from 'csv-parse';

/**
 * Canonical CSV format for tabular market data.
 *
 * Writing:  use `rowToCsv` on every record. Fields are quoted only when they
 *           contain `,`, `"`, `\n` or `\r`; embedded quotes are doubled per
 *           RFC 4180. Objects and arrays are written as JSON.
 *
 * Reading:  use `createCsvParser()` — a `csv-parse` stream configured to read
 *           exactly what `rowToCsv` writes, multi-line quoted fields included.
 *           A hand-rolled splitter mis-parses those fields.
 *
 * The asymmetry is intentional: parsing quoted multi-line CSV correctly is
 * non-trivial and worth a library; emitting it is trivial and worth owning so
 * the bytes written stay stable.
 */

/** Serialize a row into a single CSV line (no trailing newline). */
export const rowToCsv = (row: Record<string, unknown>, cols: string[]): string =>
  cols.map(col => csvValue(row[col])).join(',');

const csvValue = (val: unknown): string => {
  if (val === null || val === undefined) return '';

  const s = typeof val === 'object' ? JSON.stringify(val) : String(val);

  return /[,"\n\r]/.test(s)
    ? `"${s.replace(/"/g, '""')}"`
    : s;
};

/**
 * Create a CSV parser stream that reads vault-format files.
 *
 * `columns = true`     → first record of the stream is the header (default);
 *                        records are emitted as `Record<string, string>` keyed
 *                        by column name.
 * `columns = string[]` → file has no header row; use the supplied columns and
 *                        treat the first record as data.
 * `columns = false`    → header-agnostic mode; records are emitted as raw
 *                        `string[]` arrays in column order. The caller is
 *                        responsible for interpreting the header record.
 *
 * `skip_empty_lines` drops fully-empty CSV records (not blank lines inside
 * quoted fields — those are data and are preserved by the parser).
 *
 * `relaxColumnCount` (default false): when true, rows whose field count does
 * not match the column count are passed through to the consumer instead of
 * throwing. Use this when the consumer wants to detect and report corruption
 * itself rather than aborting the whole stream.
 */
export const createCsvParser = (
  columns: false | true | string[] = true,
  relaxColumnCount: boolean        = false,
): Parser => parse({
  columns,
  cast: false,
  skip_empty_lines: true,
  relax_column_count: relaxColumnCount,
});
