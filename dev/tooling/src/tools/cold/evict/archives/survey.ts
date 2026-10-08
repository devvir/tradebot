import * as catalog from '../../shared/catalog';
import { SETTLE_DAYS } from '../../config';
import { Archives } from '../../shared/disk';
import { idOf, partitionOf, shiftMonth } from '../../shared/keys';
import * as record from '../../shared/record';
import { MISSING } from '../../shared/vault/ledger';
import { filesOf } from '../../shared/vault/layout';
import type { DatabaseSync } from 'node:sqlite';
import type { CatalogPartition, PartitionKey, Stocked } from '../../shared/types';
import type { ColdConfig, Origin } from '../../types';
import type { Evictable, HeldBack } from '../types';

/**
 * What of one venue's archives can go, and what stays and why.
 *
 * The catalog is asked twice: for the partitions that are downloaded and
 * settled, which are the candidates, and for every partition it holds, which
 * says what each one's version is now and which months a dataset has.
 *
 * The record says which of them have gone already, at the version they have
 * now, so that what was evicted is not offered again. The disk says nothing,
 * and is not asked — unless `returned` is given: then each partition that went
 * is looked for there, and goes again where any file of it is back.
 */
export const survey = async (
  db:       DatabaseSync,
  config:   ColdConfig,
  origin:   Origin,
  venue:    string,
  stocked:  readonly Stocked[],
  now:      number = Date.now(),
  returned?: Archives,
): Promise<Evictable> => {
  const all        = await catalog.partitions(config, venue);
  const candidates = await catalog.partitions(config, venue, { downloaded: 'true', settled: 'true' });

  const versions = new Map(all.map(one => [idOf(one), one.version]));
  const inCold   = new Map(record.storedOf(db, origin, venue).map(one => [idOf(one), one.version]));
  const evicted  = record.evictedOf(db, origin, venue);

  /** The months each dataset has anything in, whatever the rendering. */
  const months = new Map<string, Set<string>>();

  for (const one of all) months.set(dataOf(one), (months.get(dataOf(one)) ?? new Set()).add(one.month));

  /** The ledger's lines by the data they hold: a dataset's month, in whichever rendering it was stocked from. */
  const lines = new Map<string, Stocked[]>();

  for (const one of stocked) {
    if (one.source.venue !== venue) continue;

    const at = `${dataOf(one.source)}|${one.source.month}`;

    lines.set(at, [...lines.get(at) ?? [], one]);
  }

  /**
   * **The vault's own copy has to be somewhere**: in cold storage, as the record
   * says, or on disk. The record is asked first and answers without touching
   * anything; only a partition it does not have stored is looked for in the
   * vault, and each one once.
   */
  const vaultStored = record.vaultStored(db);
  const found       = new Map<string, boolean>();

  const held = (one: Stocked): boolean => {
    if (vaultStored.get(one.partition)?.has(one.revision)) return true;

    if (! found.has(one.partition)) found.set(one.partition, filesOf(config.vaultRoot, one) !== null);

    return found.get(one.partition)!;
  };

  /** Whether a side a line names is as the catalog has it: not named, not there to be read, or the neighbour's version still. */
  const sideHolds = (one: Stocked, side: string, by: number): boolean =>
    ! side || side === MISSING || versions.get(idOf({ ...one.source, month: shiftMonth(one.source.month, by) })) === side;

  /** Whether the versions a line was stocked from are still the catalog's, and what was stocked is still held. */
  const current = (one: Stocked): boolean =>
    versions.get(idOf(one.source)) === one.version
    && sideHolds(one, one.preVersion, -1)
    && sideHolds(one, one.postVersion, 1)
    && held(one);

  /** The line a month of a dataset is stocked by, in whichever rendering; nothing where it is not stocked. */
  const lineOf = (data: string, month: string): Stocked | undefined =>
    (lines.get(`${data}|${month}`) ?? []).find(current);

  const out: Evictable = {
    venue, ready: [], gone: 0, returned: 0,
    held: { 'not in cold storage': 0, 'not stocked': 0, 'a neighbouring month still needs it': 0 },
  };

  for (const one of candidates) {
    const why = heldBack(one, inCold, months.get(dataOf(one)) ?? new Set(), lineOf, settlable(now));

    if (why) {
      out.held[why]++;

      continue;
    }

    if (evicted.get(idOf(one)) !== one.version) {
      out.ready.push(one);
    } else if (returned && await isBack(returned, one)) {
      out.ready.push(one);
      out.returned++;
    } else {
      out.gone++;
    }
  }

  return out;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Whether any file of a partition is on disk. */
const isBack = async (archives: Archives, partition: CatalogPartition): Promise<boolean> => {
  const mine = idOf(partition);

  for (const { names } of await archives.monthDirsOf(partition))
    for (const name of names) {
      const key = partitionOf(name);

      if (key && idOf(key) === mine) return true;
    }

  return false;
};

/** Why a partition stays on disk, or null where it can go. */
const heldBack = (
  one:       CatalogPartition,
  inCold:    ReadonlyMap<string, string>,
  months:    ReadonlySet<string>,
  lineOf:    (data: string, month: string) => Stocked | undefined,
  settlable: string,
): HeldBack | null => {
  if (inCold.get(idOf(one)) !== one.version) return 'not in cold storage';

  const data = dataOf(one);
  const own  = lineOf(data, one.month);

  if (! own) return 'not stocked';

  /** Whether a neighbouring month has, in the vault, the hours these files hold of it. */
  const given = (version: string | undefined): boolean => !! version && version !== MISSING;

  // Its last hours are in the next month's files — so its own hold the last hours of the month before.
  if (own.postVersion) {
    const before = shiftMonth(one.month, -1);

    if (months.has(before) && ! given(lineOf(data, before)?.postVersion)) return 'a neighbouring month still needs it';
  }

  // Its first hours are in the files of the month before — so its own hold the first hours of the month after.
  if (own.preVersion) {
    const after = shiftMonth(one.month, 1);

    // Not in the catalog, and it has not had its time yet: not published is not ended.
    if (months.has(after) ? ! given(lineOf(data, after)?.preVersion) : after > settlable) return 'a neighbouring month still needs it';
  }

  return null;
};

/** The newest month that can be settled at this moment, as `YYYYMM`: the one that ended `SETTLE_DAYS` ago or more. */
const settlable = (now: number): string => {
  const at = new Date(now - SETTLE_DAYS * 86_400_000);

  return shiftMonth(`${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, '0')}`, -1);
};

/** The data a partition holds, whatever the rendering: its venue, market, dataset and variant. */
const dataOf = (key: PartitionKey): string => [key.venue, key.market, key.dataset, key.variant].join('|');

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_survey = survey;
