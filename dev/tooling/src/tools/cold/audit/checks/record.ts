import fs from 'node:fs';
import path from 'node:path';
import { orphans } from '../../lock';
import * as record from '../../shared/record';
import { labelOf } from '../../shared/vault/layout';
import { backedUpIn, noteBackedUp, stockedIn } from '../../shared/vault/ledger';
import { are, count, found } from '../finding';
import type { Check, Finding, Looking } from '../types';

/**
 * The record against itself and against the files beside it: what it says in
 * two places has to be the same thing twice, and what it leaves lying about
 * has to belong to something.
 */
export const withinItself: Check = async looking => [
  ...locks(looking),
  ...(looking.origin === 'vault' ? [...partitions(looking), ...backedUp(looking)] : []),
];

// ── Internals ─────────────────────────────────────────────────────────────────

/** Locks whose holder is gone. */
const locks = ({ config }: Looking): Finding[] => {
  const left = orphans(config.coldRoot);

  return found(`${count(left.length, 'lock')} ${are(left)} held by a run that is gone`, left, [
    { label: 'Remove them', apply: () => { for (const name of left) fs.rmSync(path.join(config.coldRoot, name), { force: true }); } },
  ]);
};

/** Vault partitions written down as whole in cold storage whose files do not add up to that. */
const partitions = ({ db }: Looking): Finding[] => {
  const stored = new Map<string, number>();

  for (const file of record.vaultFiles(db))
    if (file.state === 'stored') stored.set(`${file.partition}|${file.revision}`, (stored.get(`${file.partition}|${file.revision}`) ?? 0) + 1);

  const short = record.vaultPartitions(db).filter(one => (stored.get(`${one.partition}|${one.revision}`) ?? 0) !== one.files);

  return found(`${count(short.length, 'vault partition')} written down as whole in cold storage ${short.length === 1 ? 'does' : 'do'} not have every file stored`,
    short.map(one => `${labelOf(one.partition)} at ${one.revision}`), [{
      label: 'Write them down as not whole, so the next push completes them',
      apply: () => { for (const one of short) record.dropVaultPartition(db, one.partition, one.revision); },
    }]);
};

/** Partitions cold storage holds at the revision the ledger has now, that the vault has not been told about. */
const backedUp = ({ db, config }: Looking): Finding[] => {
  const told    = backedUpIn(config.vaultRoot);
  const stored  = record.vaultStored(db);
  const untold  = (stockedIn(config.vaultRoot) ?? [])
    .filter(one => stored.get(one.partition)?.has(one.revision) && ! told.get(one.partition)?.has(one.revision));

  return found(`${count(untold.length, 'vault partition')} in cold storage ${are(untold)} not in the vault's list of what has a copy`,
    untold.map(one => labelOf(one.partition)), [{
      label: 'Add them to it',
      apply: () => { for (const one of untold) noteBackedUp(config.vaultRoot, one.partition, one.revision); },
    }], 'Until they are, whoever stocks the vault takes a missing file of them for a loss.');
};
