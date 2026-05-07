/**
 * Per-file resolver that maps a message's raw `timestamp` and `_date_` to the
 * canonical sort key `ts` and its epoch-ms form `tsMs`.
 *
 * For the vast majority of files — where every message either always has or
 * always lacks a timestamp — the result is simply `timestamp || _date_`.
 *
 * The only special case is a file where some messages have a real timestamp
 * and others do not. Once detected, missing-timestamp entries fall back to
 * `_date_ + lastDateDrift`, where `lastDateDrift` is the offset between the
 * exchange timestamp and reception date from the last real timestamp seen.
 * This keeps stray missing entries in the correct order relative to their
 * neighbours without disturbing any healthy entries.
 */
export interface TsResolver {
  resolve(tsRaw: string | null, date: string): { ts: string; tsMs: number };
}

export function createTsResolver(): TsResolver {
  let hasTimestamps: boolean = false;
  let lastDateDrift: number  = 0;

  return {
    resolve(tsRaw, date) {
      hasTimestamps ||= !! tsRaw;

      if (tsRaw)
        lastDateDrift = isoToMs(tsRaw.slice(0, 23)) - isoToMs(date.slice(0, 23));

      if (hasTimestamps && ! tsRaw) {
        const tsMs = isoToMs(date.slice(0, 23)) + lastDateDrift;

        return { ts: msToIso(tsMs), tsMs };
      }

      const ts   = (tsRaw || date).slice(0, 23);
      const tsMs = isoToMs(ts);

      return { ts, tsMs };
    },
  };
}

// ── Internal: ISO ms conversion ──────────────────────────────────────────────

/**
 * Epoch ms from a 23-char ISO string. Positional arithmetic — no locale or
 * timezone parsing.
 */
function isoToMs(ts: string): number {
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
function msToIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 23);
}

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_isoToMs = isoToMs;
export const _test_msToIso = msToIso;
