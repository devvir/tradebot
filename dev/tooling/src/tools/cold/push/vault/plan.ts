import * as record from '../../shared/record';
import { backedUpIn, noteBackedUp, stockedIn } from '../../shared/vault/ledger';
import { filesOf, locate } from '../../shared/vault/layout';
import { byKey } from '../../order';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig } from '../../types';
import type { StoredFile } from '../../shared/types';
import type { VaultPlan } from '../types';

/**
 * Set the ledger against the record, and plan what the record does not have.
 *
 * A partition's files are found on disk and measured here, once: what they
 * weigh is what Mega has to hold for them to count as stored. A partition the
 * vault does not hold as its ledger says — files missing, or some of them moved
 * out before it was ever stored — is left out and counted.
 *
 * What was on its way for a revision the ledger has moved on from is
 * forgotten: the files at those paths are another revision's now.
 */
export const plan = (db: DatabaseSync, config: ColdConfig, venues: readonly string[]): VaultPlan => {
  const stored  = record.vaultStored(db);
  const ledger  = stockedIn(config.vaultRoot) ?? [];
  const current = new Map(ledger.map(one => [one.partition, one.revision]));
  const out: VaultPlan = { venues: new Map(), skipped: 0 };

  // On its way for a revision the ledger has moved on from: the file at that path is no longer the one that was planned.
  for (const file of record.vaultFilesPending(db))
    if (current.get(file.partition) !== file.revision) record.dropVaultPending(db, file.partition, file.revision);

  // What the record holds as stored and the vault has not been told: a file removed, or a run stopped in between.
  const told = backedUpIn(config.vaultRoot);

  for (const [partition, revisions] of stored)
    for (const revision of revisions)
      if (current.get(partition) === revision && ! told.get(partition)?.has(revision)) noteBackedUp(config.vaultRoot, partition, revision);

  for (const one of ledger) {
    const venue = locate(one.partition).levels['venue'] ?? '';

    if (venues.length > 0 && ! venues.includes(venue)) continue;
    if (stored.get(one.partition)?.has(one.revision)) continue;

    let files = record.vaultFilesOf(db, one.partition, one.revision) as { bytes: number }[];

    if (files.length !== one.count) {
      const found = filesOf(config.vaultRoot, one);

      if (! found) {
        out.skipped++;

        continue;
      }

      record.planVaultFiles(db, found);

      files = found;
    }

    const load = out.venues.get(venue) ?? { partitions: 0, files: 0, bytes: 0 };

    load.partitions++;
    load.files += files.length;
    load.bytes += files.reduce((sum, file) => sum + file.bytes, 0);

    out.venues.set(venue, load);
  }

  for (const venue of venues) if (! out.venues.has(venue)) out.venues.set(venue, { partitions: 0, files: 0, bytes: 0 });

  return { ...out, venues: new Map([...out.venues].sort(byKey)) };
};

/** The files still to reach cold storage, of the venues asked for. */
export const pendingOf = (db: DatabaseSync, venues: readonly string[]): StoredFile[] =>
  record.vaultFilesPending(db).filter(file =>
    venues.length === 0 || venues.includes(locate(file.partition).levels['venue'] ?? ''));

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_plan  = plan;
