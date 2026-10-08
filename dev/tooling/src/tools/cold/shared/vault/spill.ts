import * as catalog from '../catalog';
import { matches } from '../disk';
import { shiftMonth } from '../keys';
import { MISSING } from './ledger';
import type { Archives } from '../disk';
import type { CatalogPartition, Stocked } from '../types';
import type { ColdConfig } from '../../types';

/**
 * The stocked partitions that can be completed now: stocked without the hours a
 * neighbouring month holds of them, whose neighbour's archives are on disk.
 *
 * **Whoever stocks the vault adds those hours beside the partition's own
 * files**, so it needs both the neighbour's archives and the partition's own
 * files on disk at once. That is what makes these partitions particular to
 * whoever moves files off the disk and back: their own files should not leave
 * while the neighbour is here, and should come back where they already have.
 *
 * A neighbour is here where any rendering of its month is on disk as the
 * catalog says it is — the count and the bytes, as everywhere else.
 */
export const completable = async (config: ColdConfig, archives: Archives, stocked: readonly Stocked[]): Promise<Stocked[]> => {
  const downloaded = new Map<string, Promise<CatalogPartition[]>>();
  const here       = new Map<string, boolean>();

  const neighbourHere = async (one: Stocked, by: number): Promise<boolean> => {
    const { venue, market, dataset, variant } = one.source;
    const month = shiftMonth(one.source.month, by);
    const key   = [venue, market, dataset, variant, month].join('|');

    if (! here.has(key)) {
      if (! downloaded.has(venue)) downloaded.set(venue, catalog.partitions(config, venue, { downloaded: 'true' }));

      const renderings = (await downloaded.get(venue)!)
        .filter(held => held.market === market && held.dataset === dataset && held.variant === variant && held.month === month);

      let found = false;

      for (const rendering of renderings)
        if (! found && matches(await archives.filesOf(rendering), rendering)) found = true;

      here.set(key, found);
    }

    return here.get(key)!;
  };

  const waiting: Stocked[] = [];

  for (const one of stocked) {
    const sides: number[] = [...(one.preVersion === MISSING ? [-1] : []), ...(one.postVersion === MISSING ? [1] : [])];

    for (const by of sides) {
      if (! await neighbourHere(one, by)) continue;

      waiting.push(one);

      break;
    }
  }

  return waiting;
};
