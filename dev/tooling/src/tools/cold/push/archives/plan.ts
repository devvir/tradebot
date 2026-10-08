import { binsOf } from './bins';
import * as catalog from '../../shared/catalog';
import { tarName } from '../../config';
import { idOf } from '../../shared/keys';
import * as record from '../../shared/record';
import { fmtBytes } from '../../../../shared/utils/format';
import { info } from '../../../../shared/ui/logger';
import { byKey } from '../../order';
import type { DatabaseSync } from 'node:sqlite';
import type { CatalogPartition } from '../../shared/types';
import type { ColdConfig, Origin, Tar } from '../../types';
import type { Planned } from '../types';

/**
 * Set what the catalog says is ready against what the record holds, venue by
 * venue, and write down what follows from the difference.
 *
 * - **A partition the record does not have** is planned into a new tar of its
 *   venue-month.
 * - **One it has at another version** is noted as changed, and its tar — where
 *   Mega already holds it — becomes one to bring back and correct.
 * - **One it has at this version** needs nothing.
 *
 * A partition the catalog does not answer with is left exactly as it is: it is
 * outside the lens, still downloading, or still changing, and none of those is
 * a reason to touch what is stored.
 */
export const plan = async (
  db:     DatabaseSync,
  config: ColdConfig,
  origin: Origin,
  venues: readonly string[],
  lens:   string | null,
  say:    (line: string) => void = info,
): Promise<Planned> => {
  const settledBefore = config.settledHours === null
    ? null
    : new Date(Date.now() - config.settledHours * 3_600_000).toISOString();
  const total: Planned = { tars: 0, added: 0, changed: 0, stale: 0 };

  for (const venue of venues) {
    const ready = await catalog.readyPartitions(config, venue, settledBefore, lens);

    // Asked first, dropped second: a catalog that does not answer leaves the plan as it was.
    record.dropPlanned(db, origin, venue);

    const held  = new Map(record.heldOf(db, origin, venue).map(one => [idOf(one), one]));
    const fresh = new Map<string, CatalogPartition[]>();

    let changed = 0;

    for (const one of ready) {
      const had = held.get(idOf(one));

      if (! had) {
        fresh.set(one.month, [...fresh.get(one.month) ?? [], one]);

        continue;
      }

      if (had.version === one.version || had.next?.version === one.version) continue;

      record.noteChange(db, had, one);
      changed++;
    }

    let tars = 0;

    for (const [month, partitions] of [...fresh].sort(byKey))
      for (const bin of binsOf(partitions, config.capBytes)) {
        record.planTar(db, origin, venue, month, seq => ({
          remote: `${venue}/${month.slice(0, 4)}/${tarName(venue, month, seq)}`,
          local:  `${venue}/${tarName(venue, month, seq)}`,
        }), bin.partitions);

        tars++;
      }

    const added = [...fresh.values()].reduce((sum, list) => sum + list.length, 0);

    say(`  ${venue.padEnd(8)} ${loadOf(db, toPush(outstanding(db, origin, [venue])))}`
      + (changed > 0 ? ` · ${changed} stored partition${changed === 1 ? '' : 's'} changed` : ''));

    total.tars    += tars;
    total.added   += added;
    total.changed += changed;
  }

  total.stale = record.tarsOf(db, origin).filter(tar => tar.state === 'stale').length;

  return total;
};

/** The tars of these venues that are not in cold storage as the record wants them. */
export const outstanding = (db: DatabaseSync, origin: Origin, venues: readonly string[]): Tar[] =>
  record.tarsOf(db, origin).filter(tar => tar.state !== 'stored' && venues.includes(tar.venue));

/** The tars that hold partitions not in cold storage yet, as opposed to stored ones being corrected. */
export const toPush = (tars: readonly Tar[]): Tar[] =>
  tars.filter(tar => ! ['stale', 'fetching', 'fetched'].includes(tar.state));

/** What these tars amount to, in a line. */
export const loadOf = (db: DatabaseSync, tars: readonly Tar[]): string => {
  const held = tars.flatMap(tar => record.heldIn(db, tar.id));

  if (held.length === 0) return 'nothing new';

  const files = held.reduce((sum, one) => sum + one.files, 0);
  const bytes = held.reduce((sum, one) => sum + one.bytes, 0);

  return `${held.length.toLocaleString('en-US')} new partition${held.length === 1 ? '' : 's'} ready to push `
    + `(${files.toLocaleString('en-US')} file${files === 1 ? '' : 's'} · `
    + `${tars.length} tar${tars.length === 1 ? '' : 's'} · ${fmtBytes(bytes)})`;
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_plan = plan;
