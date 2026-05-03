import { parse, type Parser } from 'csv-parse';

/**
 * Canonical CSV format used by the vault and every tool that reads or writes
 * vault files.
 *
 * Writing:  use `rowToCsv` on every record. Fields are quoted only when they
 *           contain `,`, `"`, or `\n`; embedded quotes are doubled per RFC 4180.
 *
 * Reading:  use `createCsvParser()` — a `csv-parse` stream configured with the
 *           exact options the vault uses to read its own files. Any tool that
 *           round-trips vault data MUST use this rather than a hand-rolled
 *           splitter, otherwise multi-line quoted fields are mis-parsed.
 *
 * The asymmetry is intentional: parsing quoted multi-line CSV correctly is
 * non-trivial and worth a library; emitting it for our schema is trivial and
 * worth owning so the on-disk bytes stay stable.
 */

/** Serialize a row into a single CSV line (no trailing newline). */
export const rowToCsv = (row: Record<string, unknown>, cols: string[]): string =>
  cols.map(col => csvValue(row[col])).join(',');

const csvValue = (val: unknown): string => {
  if (val === null || val === undefined) return '';

  const s = typeof val === 'object' ? JSON.stringify(val) : String(val);

  return s.includes(',') || s.includes('"') || s.includes('\n')
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
 */
export const createCsvParser = (columns: false | true | string[] = true): Parser =>
  parse({
    columns,
    cast:             false,
    skip_empty_lines: true,
  });
