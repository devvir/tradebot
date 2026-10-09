import * as catalog from '../catalog';
import { loadConfig } from '../../config';
import { Archives, matches } from '../disk';
import { idOf, shiftMonth } from '../keys';
import * as record from '../record';
import { MISSING, outdatedIn, stockedIn } from './ledger';
import { completable } from './spill';
import { warn } from '../../../../shared/ui/logger';
import type { DatabaseSync } from 'node:sqlite';
import type { CatalogPartition, Held, Needed, PartitionKey, Stocked } from '../types';
import type { Pullable } from '../../pull/types';
import type { ColdConfig } from '../../types';

/**
 * What the vault waits for that is in cold storage.
 *
 * **Everything is meant to leave the disk in the end, and it leaves once it is
 * stocked.** So a partition that cannot be stocked because what it is built
 * from has left already is stuck, and holds its neighbours on disk with it.
 * Two things leave a partition so:
 *
 * - **It is outdated** — stocked, at a revision that is no longer what would be
 *   stocked — and the archives it is stocked again from are not on disk: its
 *   own, or those of a neighbouring month it reads the edge of.
 * - **It can be completed** — stocked without a neighbouring month's hours,
 *   whose archives are on disk now — and its own vault files, which those hours
 *   are added beside, have been taken off the disk.
 *
 * **Any rendering of a month will do to stock from**, so a month is needed only
 * where none of its renderings is on disk as the catalog has it; what is asked
 * for then is the one it was stocked from, or failing that any that is stored.
 *
 * Nothing is brought back here: this says what would be.
 */
export const neededOf = async (
  db:     DatabaseSync,
  config: ColdConfig = loadConfig('archives'),
  vault:  ColdConfig = loadConfig('vault'),
): Promise<Needed> => {
  const disk     = new Archives(config.sourceRoot);
  const stocked  = stockedIn(vault.vaultRoot) ?? [];
  const outdated = outdatedIn(vault.vaultRoot);

  const waiting = new Map((await completable(vault, disk, stocked)).map(one => [one.partition, one.revision]));
  const away    = record.vaultFiles(db).filter(file =>
    file.state === 'stored' && file.evictedAt !== null && waiting.get(file.partition) === file.revision);

  const needed: Needed = { partitions: new Set(away.map(file => file.partition)).size, archives: [], vault: away, unstored: [] };
  const asked = new Set<string>();

  /** What the catalog and cold storage hold of each venue, asked once. */
  const listed = new Map<string, Promise<CatalogPartition[]>>();
  const held   = new Map<string, Held[]>();

  for (const one of outdated) {
    let waits = false;

    for (const month of monthsOf(one)) {
      const wanted = { ...one.source, month };
      const venue  = wanted.venue;

      if (! listed.has(venue)) {
        listed.set(venue, catalog.partitions(config, venue));
        held.set(venue, record.pullableOf(db, 'archives', venue));
      }

      const renderings = (await listed.get(venue)!).filter(other => sameData(other, wanted));

      let here = false;

      for (const rendering of renderings)
        if (! here && matches(await disk.filesOf(rendering), rendering)) here = true;

      if (here) continue;

      waits = true;

      // Stored at the version the catalog has: the rendering it was stocked from first, then whichever is stored.
      const versions = new Map(renderings.map(rendering => [idOf(rendering), rendering.version]));
      const stored   = held.get(venue)!
        .filter(other => sameData(other, wanted) && versions.get(idOf(other)) === other.version)
        .sort((a, b) => Number(idOf(b) === idOf(wanted)) - Number(idOf(a) === idOf(wanted)))[0];

      if (asked.has(dataOf(wanted))) continue;

      asked.add(dataOf(wanted));

      if (! stored) needed.unstored.push(idOf(wanted));
      else needed.archives.push({ held: stored, state: (await disk.filesOf(stored)).length === 0 ? 'away' : 'differs' } satisfies Pullable);
    }

    if (waits) needed.partitions++;
  }

  return needed;
};

/**
 * Say that the vault waits for files in cold storage, where it does — and
 * nothing where it does not, or where that could not be found out.
 *
 * For whatever reads the vault's ledger: bringing the files back is asked for
 * on purpose, by its own command, and is never a side effect of another.
 */
export const notice = async (db: DatabaseSync): Promise<void> => {
  let needed: Needed;

  try {
    needed = await catalog.once(() => neededOf(db));
  } catch {
    return;
  }

  if (needed.archives.length + needed.vault.length === 0) return;

  warn(`The vault needs files restored from backup in order to complete (${needed.partitions.toLocaleString('en-US')} `
    + `partition${needed.partitions === 1 ? '' : 's'}). Run \`tools cold pull needed\` to restore them`);
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** The months an outdated partition is stocked again from: its own, and each neighbour it read the edge of. */
const monthsOf = (one: Stocked): string[] => [
  one.source.month,
  ...(one.preVersion && one.preVersion !== MISSING ? [shiftMonth(one.source.month, -1)] : []),
  ...(one.postVersion && one.postVersion !== MISSING ? [shiftMonth(one.source.month, 1)] : []),
];

/** The data a partition holds in a month, whatever the rendering. */
const dataOf = (key: PartitionKey): string => [key.venue, key.market, key.dataset, key.variant, key.month].join('|');

const sameData = (a: PartitionKey, b: PartitionKey): boolean => dataOf(a) === dataOf(b);
