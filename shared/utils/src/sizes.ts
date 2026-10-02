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

  while (scaled >= 1024 && unit < UNITS.length - 1) {
    scaled /= 1024;
    unit++;
  }

  return `${unit === 0 ? scaled : Math.round(scaled * 10) / 10} ${UNITS[unit]}`;
};

// ── Internals ─────────────────────────────────────────────────────────────────

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
