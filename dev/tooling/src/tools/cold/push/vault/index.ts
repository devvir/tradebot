import { loadConfig } from '../../config';
import { onExit } from '../../cleanup';
import { acquire } from '../../lock';
import * as mega from '../../shared/mega';
import { agreed, isWatch } from '../../options';
import * as record from '../../shared/record';
import { fmtBytes } from '../../../../shared/utils/format';
import { error, info, spacer, success, warn } from '../../../../shared/ui/logger';
import { trusted } from '../../shared/vault/trusted';
import { pendingOf, plan } from './plan';
import { work } from './work';
import type { PushOptions, VaultPlan } from '../types';

/**
 * Store the vault: every partition its ledger holds that cold storage does not
 * have at that revision.
 *
 * **The vault is stored as it is.** A partition is already what a tar would be
 * made to be — one compressed file for a small month, a file per instrument for
 * a large one — so its files are sent as they are, each to a path that says
 * what it is (see `remoteOf`). Nothing is packed, and what is brought back
 * later is exactly the files that are wanted, down to one instrument of one
 * month.
 *
 * **A partition stored is written into the vault's `backedup.csv`.** That is
 * what tells whoever stocks the vault that a safe copy exists, and that
 * whatever of the partition is on disk from then on is no loss.
 *
 * **A partition is what is stored; a file is what is sent.** A partition is in
 * cold storage once every file of it is, at the size it has on disk, and not
 * before — the record says so, and it is what everything else asks.
 *
 * **A partition stocked again is stored again, every file of it.** A file's
 * path says nothing of its revision, so which files changed is not known and is
 * not asked: all of them are handed to Mega, which takes one it already holds
 * unchanged without sending it again. Once every one is confirmed, what the
 * replaced revision had that this one has not — an instrument the month no
 * longer holds — is removed from Mega, and the old revision from the record.
 *
 * **Sent no faster than the link takes them.** Files are handed to Mega's own
 * queue, which sends them one at a time and outlives this command; no more is
 * handed over than `COLD_QUEUE_TARGET_GB` waiting, and an upload is confirmed
 * from Mega's listing, never from an exit code.
 *
 * **Nothing is stored while the vault reports a loss.** The ledger is what says
 * what there is to store, and `ERROR.log` says it was found wrong.
 */
export const runPushVault = async (options: PushOptions): Promise<void> => {
  const config  = loadConfig('vault');
  const release = await acquire(config.coldRoot, 'vault', 'push');

  try {
    if (! await mega.available()) {
      error('mega-cmd is not available — is the session logged in?');

      return;
    }

    if (! trusted(config)) return;

    const db = record.open(config.dbPath);

    onExit(() => record.close(db));

    try {
      info('Reading the vault\'s ledger for what is not in cold storage');

      const planned = plan(db, config, options.venues);

      for (const [venue, load] of planned.venues) info(`  ${venue.padEnd(8)} ${loadOf(load)}`);

      if (planned.skipped > 0)
        warn(`${planned.skipped} partition${planned.skipped === 1 ? ' is' : 's are'} not in the vault as the ledger says — left out`);

      const pending = pendingOf(db, options.venues);

      if (pending.length === 0 && ! isWatch()) {
        success('There is currently nothing to push');

        return;
      }

      if (pending.length > 0) {
        spacer();
        info(loadOf(totalOf(planned)));
        spacer();

        if (! await agreed('Go ahead?', true)) return;
      }

      await work(db, config, options.venues, mega);
    } finally {
      record.close(db);
    }
  } finally {
    release();
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

const totalOf = (planned: VaultPlan): { partitions: number; files: number; bytes: number } =>
  [...planned.venues.values()].reduce(
    (sum, one) => ({ partitions: sum.partitions + one.partitions, files: sum.files + one.files, bytes: sum.bytes + one.bytes }),
    { partitions: 0, files: 0, bytes: 0 });

const loadOf = (load: { partitions: number; files: number; bytes: number }): string =>
  load.partitions === 0
    ? 'nothing new'
    : `${load.partitions.toLocaleString('en-US')} new partition${load.partitions === 1 ? '' : 's'} ready to push `
      + `(${load.files.toLocaleString('en-US')} file${load.files === 1 ? '' : 's'} · ${fmtBytes(load.bytes)})`;
