import { idOf } from './keys';
import type { Bin, CatalogPartition } from './types';

/**
 * Divide a venue-month's partitions into the tars they will travel in.
 *
 * **Whole partitions only.** A partition is never cut, so one heavier than the
 * cap is a tar of its own, at whatever it weighs. The rest are placed heaviest
 * first, each into the first tar that still has room for it — which lands close
 * enough to the cap, and nothing downstream cares that it is not exact.
 *
 * Deterministic: the same partitions always divide the same way.
 */
export const binsOf = (partitions: readonly CatalogPartition[], capBytes: number): Bin[] => {
  const sorted = [...partitions].sort((a, b) => b.bytes - a.bytes || (idOf(a) < idOf(b) ? -1 : 1));
  const bins: Bin[] = [];

  for (const one of sorted) {
    const fits = one.bytes > capBytes ? undefined : bins.find(bin => bin.bytes + one.bytes <= capBytes);

    if (fits) {
      fits.partitions.push(one);
      fits.bytes += one.bytes;
    } else bins.push({ partitions: [one], bytes: one.bytes });
  }

  return bins;
};
