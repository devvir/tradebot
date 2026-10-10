/**
 * A contiguous calendar range, inclusive on both ends. `from` and `to` use
 * dashed `YYYY-MM-DD` strings for readability; single-day ranges have
 * `from === to`.
 */
export interface DateRange {
  from: string;  // YYYY-MM-DD
  to:   string;  // YYYY-MM-DD
}

/**
 * Collapses a list of `YYYYMMDD` day keys into contiguous calendar ranges.
 *
 * Days that are adjacent in the calendar (UTC) form one range; any gap of one
 * or more missing days starts a new range. Output ranges are sorted ascending
 * and use `YYYY-MM-DD` strings for readability.
 *
 * Duplicates and unsorted input are tolerated — the function sorts and dedupes
 * before grouping.
 */
export function computeRanges(days: Iterable<string>): DateRange[] {
  const sorted = [...new Set(days)].filter(d => /^\d{8}$/.test(d)).sort();

  if (sorted.length === 0) return [];

  const ranges: DateRange[] = [];
  let   start = sorted[0]!;
  let   prev  = sorted[0]!;

  for (let i = 1; i < sorted.length; i++) {
    const day = sorted[i]!;

    if (nextDay(prev) === day) {
      prev = day;
      continue;
    }

    ranges.push({ from: dashed(start), to: dashed(prev) });
    start = day;
    prev  = day;
  }

  ranges.push({ from: dashed(start), to: dashed(prev) });

  return ranges;
}

/** `YYYYMMDD` → `YYYY-MM-DD`. */
export function dashed(day: string): string {
  return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
}

/** Returns the day after `day` (UTC) as a `YYYYMMDD` string. */
export function nextDay(day: string): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(4, 6));
  const d = Number(day.slice(6, 8));
  const date = new Date(Date.UTC(y, m - 1, d + 1));

  const yy = date.getUTCFullYear().toString().padStart(4, '0');
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = date.getUTCDate().toString().padStart(2, '0');

  return `${yy}${mm}${dd}`;
}

/**
 * Pretty-prints a range list as a single string.
 *
 *   []                              → "—"
 *   [{from,to}]                     → "2022-01-01 → 2026-05-10"
 *   [{from,to}, {from,to}]          → "2022-01-01 → 2023-12-31, 2024-06-01 → 2026-05-10"
 *   plus single day                 → "2026-05-10"
 */
export function formatRanges(ranges: DateRange[]): string {
  if (ranges.length === 0) return '—';

  return ranges
    .map(r => r.from === r.to ? r.from : `${r.from} → ${r.to}`)
    .join(', ');
}

/**
 * Same as `formatRanges` but collapses to `min → max (N gaps)` when the list
 * has more than `maxRanges` entries. Keeps output readable for tables and
 * timelines with many small holes (e.g. monthly snapshots).
 */
export function formatRangesAdaptive(ranges: DateRange[], maxRanges = 2): string {
  if (ranges.length === 0)         return '—';
  if (ranges.length <= maxRanges)  return formatRanges(ranges);

  const first = ranges[0]!;
  const last  = ranges[ranges.length - 1]!;
  const gaps  = ranges.length - 1;

  return `${first.from} → ${last.to} (${gaps} gap${gaps === 1 ? '' : 's'})`;
}
