import type { Series, Spill } from './types';

/**
 * Support for venues whose buckets do not cut at UTC midnight — see `spill` on
 * `Series`.
 *
 * A file in the first bucket of a month can carry the previous month's tail
 * (`back`), and one in the last bucket the next month's head (`forward`). So a
 * spilling partition is built from its own files **plus a neighbouring month's
 * edge**, and clipped to its own month so the neighbour's rows land only where
 * they belong.
 *
 * The trait assumes the offset is smaller than one bucket, so one neighbour in
 * each direction is enough.
 */

/**
 * Which neighbouring months a partition reaches into, and which edge of each:
 * a back-spilling month needs the next month's first bucket, a forward-spilling
 * one the previous month's last.
 */
export const reachOf = (spill: Spill | undefined): { by: number; side: 'first' | 'last' }[] => {
  if (! spill) return [];

  const reach: { by: number; side: 'first' | 'last' }[] = [];

  if (spill !== 'forward') reach.push({ by: 1, side: 'first' });
  if (spill !== 'back')    reach.push({ by: -1, side: 'last' });

  return reach;
};

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
