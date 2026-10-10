/**
 * ISO ↔ epoch-ms conversion shared across the data pipeline.
 *
 * Positional arithmetic only — no locale or timezone parsing, no `Date.parse`.
 * All timestamps are canonical UTC ISO strings; a trailing `Z` (or anything
 * past the milliseconds) is ignored.
 */

/** Epoch ms from a canonical ISO string. */
export function isoToMs(ts: string): number {
  const year   = +ts.slice(0, 4);
  const month  = +ts.slice(5, 7) - 1;
  const day    = +ts.slice(8, 10);
  const hour   = +ts.slice(11, 13);
  const minute = +ts.slice(14, 16);
  const second = +ts.slice(17, 19);
  const millis = ts.length > 20 ? +ts.slice(20, 23) : 0;

  return Date.UTC(year, month, day, hour, minute, second, millis);
}

/** Inverse of `isoToMs` — 23-char ISO string from epoch ms. */
export function msToIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 23);
}
