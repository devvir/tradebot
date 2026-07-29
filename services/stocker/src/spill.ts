import { dayAfter, dayOf, endOfMonth, monthShift } from './dates';
import type { Candidate, Series } from './types';

/**
 * Support for venues whose buckets do not cut at UTC midnight — see `spill` on
 * `Series`. Three consequences, each answered by one function here:
 *
 * - a file in the first or last bucket of its month also carries rows for a
 *   neighbouring month, so the walk must hand it to that partition too
 *   (`donatedMonths`);
 * - a partition assembled that way holds more than its month, so the build
 *   must clip its output to the month's bounds (`clipFor`);
 * - a month's tail can live in a bucket the collector has not fetched yet, so
 *   the readiness gate must wait for the neighbour to land (`requiredThrough`).
 *
 * All three assume the offset is smaller than one bucket, which `spill`'s
 * docblock states as the trait's limit.
 */

/**
 * Neighbouring months this file's rows can belong to. Empty for a series that
 * does not spill, and for files safely inside their month.
 *
 * A monthly bucket is its month's first and last bucket at once, so it donates
 * in every direction its series declares.
 */
export const donatedMonths = (file: Candidate): string[] => {
  const spill = file.series.spill;

  if (! spill) return [];

  const day    = dayOf(file.path);
  const months = [];

  if (spill !== 'forward' && (day === null || day.slice(6) === '01'))
    months.push(monthShift(file.month, -1));

  if (spill !== 'back' && (day === null || day === endOfMonth(file.month)))
    months.push(monthShift(file.month, 1));

  return months;
};

/**
 * The date collection must be settled through before this month is safe to
 * build. For a back-spilling series that is one day past the month's end — the
 * bucket holding the month's tail — which also covers monthly buckets, since
 * the next settled date a monthly dataset can reach is its next month's end.
 *
 * A forward spill needs no extension: the bucket carrying a month's head is
 * dated inside the *previous* month and settles before the month's own files.
 */
export const requiredThrough = (series: Series, month: string): string =>
  series.spill === 'back' || series.spill === 'both'
    ? dayAfter(endOfMonth(month))
    : endOfMonth(month);

/**
 * SQL clipping a spilling partition to its own month, in the µs unit `ts` is
 * projected into. Empty for a series whose buckets already match UTC cuts:
 * there the clip could only ever delete — a stray row outside its file's
 * period has no neighbour supplying it to any other partition.
 */
export const clipFor = (series: Series, month: string): string => {
  if (! series.spill) return '';

  const [year, index] = month.split('-').map(Number) as [number, number];
  const start = Date.UTC(year, index - 1, 1) * 1000;
  const end   = Date.UTC(year, index, 1) * 1000;

  return ` AND ts >= ${start} AND ts < ${end}`;
};
