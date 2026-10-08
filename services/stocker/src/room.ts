import config from './config';
import { MOST, needsExtracting, weightsOf } from './containers';
import { freeGb } from './vault';
import type { Wrapped } from './containers';
import type { Short } from './types';

/**
 * Whether there is room to extract archives, asked before any are.
 *
 * **Nothing is extracted that would leave the vault's volume under its floor.**
 * What the archives inflate to is read off them — see `weightsOf` — and set
 * against the free space as it is at that moment, less `STOCKER_MIN_FREE_GB`.
 * A full volume is then something a partition is not started for, and never
 * something a build finds out by failing to write.
 *
 * **Archives are opened only where the answer could be no.** Nothing inflates
 * to more than `MOST` times its size, so archives that fit at that ratio fit,
 * and they are most of what there is.
 */

/** What these archives lack of the room to extract them, or null where they fit. `compressed` is their weight on disk. */
export const shortOf = async (inputs: readonly Wrapped[], compressed: number): Promise<Short | null> => {
  if (! needsExtracting(inputs)) return null;

  const free  = await freeGb() * GB;
  const spare = free - config.minFreeGb * GB;

  if (compressed * MOST <= spare) return null;

  const needs = (await weightsOf(inputs)).reduce((total, one) => total + one, 0);

  return needs <= spare ? null : { needs, free };
};

/** Archives that were not extracted, for want of room. */
export class NoRoom extends Error {
  constructor(readonly short: Short) {
    super(`extracting needs ${(short.needs / GB).toFixed(1)} GB and the vault volume has ${(short.free / GB).toFixed(1)} GB free`);
  }
}

const GB = 1024 ** 3;
