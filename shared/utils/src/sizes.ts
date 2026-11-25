/**
 * A byte count at a scale a person can read: `912 B`, `18.1 MB`, `2.4 GB`.
 *
 * **The one way every service writes a size in a log.** Fixing on one unit makes
 * most lines useless — a thin symbol's day rounds to `0 MB` while a busy month
 * runs to four figures — so the unit follows the number.
 *
 * Binary steps rather than decimal, so the number matches what `ls -lah` says
 * about the same file. One decimal place: these are for reading, not arithmetic.
 */
export const sizeOf = (bytes: number): string => {
  let scaled = bytes;
  let unit   = 0;

  // The unit is chosen on the number as printed, so a value that rounds up to
  // 1024 of one unit is written as 1 of the next.
  while (unit < UNITS.length - 1 && shown(scaled, unit) >= 1024) {
    scaled /= 1024;
    unit++;
  }

  return `${shown(scaled, unit)} ${UNITS[unit]}`;
};

// ── Internals ─────────────────────────────────────────────────────────────────

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Bytes print whole; every larger unit prints to one decimal place. */
const shown = (scaled: number, unit: number): number =>
  unit === 0 ? scaled : Math.round(scaled * 10) / 10;
