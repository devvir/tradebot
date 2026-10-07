import fs from 'node:fs';
import path from 'node:path';
import { GB, POLL_MS, WATCH_MS, loadConfig } from './config';
import { onExit } from './cleanup';
import { acquire } from './lock';
import * as mega from './mega';
import { agreed, isWatch } from './options';
import { Progress } from './progress';
import * as record from './record';
import { ERRORS, LEDGER, backedUpIn, errorsIn, filesOf, labelOf, locate, noteBackedUp, remoteOf, stockedIn } from './vault';
import { fmtBytes } from '../../shared/utils/format';
import { error, info, spacer, success, warn } from '../../shared/ui/logger';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig, PushOptions, Remote, StoredFile, VaultPlan } from './types';
import { byKey } from './order';

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
        success('Everything the vault holds is in cold storage — nothing to push');

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

/** Whether the vault's own account can be gone by; says why where it cannot. */
export const trusted = (config: ColdConfig): boolean => {
  const lost = errorsIn(config.vaultRoot);

  if (lost.length > 0) {
    error(`The vault reports ${lost.length} problem${lost.length === 1 ? '' : 's'} in ${path.join(config.vaultRoot, ERRORS)} — `
      + 'nothing of the vault is moved until that is understood and the file is gone');

    process.exitCode = 1;

    return false;
  }

  if (! stockedIn(config.vaultRoot)) {
    error(`No ${LEDGER} in ${config.vaultRoot} — the vault's ledger is what says what the vault holds. Is DATA_VAULT_DIR right?`);

    process.exitCode = 1;

    return false;
  }

  return true;
};

// ── Internals ─────────────────────────────────────────────────────────────────


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
const plan = (db: DatabaseSync, config: ColdConfig, venues: readonly string[]): VaultPlan => {
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
const pendingOf = (db: DatabaseSync, venues: readonly string[]): StoredFile[] =>
  record.vaultFilesPending(db).filter(file =>
    venues.length === 0 || venues.includes(locate(file.partition).levels['venue'] ?? ''));

/**
 * Move every pending file as far as it will go, round after round, until each
 * is stored — and, watching, look at the ledger again at intervals for what has
 * been stocked since.
 */
const work = async (db: DatabaseSync, config: ColdConfig, venues: readonly string[], remote: Remote): Promise<void> => {
  const partitions = (): number => new Set(pendingOf(db, venues).map(file => `${file.partition}|${file.revision}`)).size;

  const done     = record.vaultStored(db).size;
  const progress = new Progress(done + partitions(), done);

  onExit(() => progress.stop());
  progress.start();

  let scanAt  = Date.now() + WATCH_MS;
  let waiting = false;

  for (;;) {
    if (isWatch() && Date.now() >= scanAt) {
      const before = partitions();

      if (trusted(config)) plan(db, config, venues);

      const found = partitions() - before;

      if (found > 0) progress.log(`Found ${found} new partition${found === 1 ? '' : 's'} ready to push`);

      progress.resize(record.vaultStored(db).size + partitions(), record.vaultStored(db).size);

      scanAt = Date.now() + WATCH_MS;
    }

    const pending = pendingOf(db, venues);

    if (pending.length === 0) {
      if (! isWatch()) break;

      if (! waiting) progress.log('Watch mode - Waiting for new partitions to push');

      waiting = true;

      await sleep(Math.max(1_000, Math.min(POLL_MS, scanAt - Date.now())));

      continue;
    }

    waiting = false;

    if (! await round(db, config, pending, remote, line => progress.log(line), (name, bytes) => progress.stored(name, bytes)))
      await sleep(POLL_MS);
  }

  progress.stop();

  spacer();
  success('Pushed all partitions that were ready. Bye!');
};

/**
 * One round over the pending files. Says whether anything moved, so a round in
 * which nothing did is one to wait after.
 *
 * In order: what was handed over, has left Mega's queue and is there at the
 * right size is stored; what was handed over and is neither there nor in the
 * queue is handed over again; what was planned is handed over while the queue
 * has room. Then each partition all of whose files are stored is stored itself,
 * and what the revisions it replaces had beyond it is removed.
 *
 * **A file is only confirmed after it was handed over.** Every revision of a
 * file is stored at the same path, so what Mega holds there beforehand may be
 * the month this one replaces, at the same size.
 */
const round = async (
  db:      DatabaseSync,
  config:  ColdConfig,
  pending: readonly StoredFile[],
  remote:  Remote,
  say:     (line: string) => void,

  /** A partition was stored: its name and what it weighs, said with how far the run has got. */
  stored:  (name: string, bytes: number) => void = (name, bytes) => say(`Stored ${name} · ${fmtBytes(bytes)}`),
): Promise<boolean> => {
  const queued = await remote.queuedPaths();

  let room  = config.queueTargetGb * GB - (await remote.queue()).remaining;
  let moved = false;

  /** What Mega holds below each venue of the vault, asked once a round. */
  const held = new Map<string, Awaited<ReturnType<Remote['listing']>>>();

  const inMega = async (file: StoredFile): Promise<{ bytes: number; handle: string | null } | null> => {
    const [venue, ...rest] = remoteOf(file).split('/');

    if (! held.has(venue!)) held.set(venue!, await remote.listing(`${config.megaRoot}/${venue}`));

    return held.get(venue!)!.get(rest.join('/')) ?? null;
  };

  for (const file of pending) {
    const local = path.join(config.vaultRoot, file.path);

    if (queued.has(local)) {
      if (file.state !== 'queued') record.moveVaultFile(db, file, 'queued');

      continue;
    }

    if (file.state === 'queued') {
      const there = await inMega(file);

      if (there && there.bytes === file.bytes) {
        record.moveVaultFile(db, file, 'stored', there.handle);

        moved = true;

        continue;
      }

      // Handed over and gone from the queue without arriving: it is handed over again.
      record.moveVaultFile(db, file, 'planned');

      moved = true;
    }

    if (room <= 0) continue;

    if (! fs.existsSync(local)) {
      say(`${file.path} is no longer in the vault — its partition is left for the next look at the ledger`);

      record.dropVaultRevision(db, file.partition, file.revision);

      moved = true;

      continue;
    }

    await remote.queueUpload(local, `${config.megaRoot}/${path.dirname(remoteOf(file))}`);

    record.moveVaultFile(db, file, 'queued');

    room -= file.bytes;
    moved = true;
  }

  for (const key of new Set(pending.map(file => `${file.partition}|${file.revision}`))) {
    const [partition, revision] = key.split('|') as [string, string];
    const files = record.vaultFilesOf(db, partition, revision);

    if (files.length === 0 || files.some(file => file.state !== 'stored')) continue;

    record.storeVaultPartition(db, partition, revision);

    // Told to the vault: there is a safe copy of this revision now, whatever of it stays on disk.
    noteBackedUp(config.vaultRoot, partition, revision);

    stored(`${labelOf(partition)} · ${files.length} file${files.length === 1 ? '' : 's'}`,
      files.reduce((sum, file) => sum + file.bytes, 0));

    await retire(db, config, partition, revision, remote, say);
  }

  return moved;
};

/**
 * Forget the revisions a newly stored one replaces, and remove from cold
 * storage what they had that it has not.
 *
 * A file both have is one path, holding the new revision now, and is left
 * where it is. Only ever after the new revision is confirmed whole. A file that
 * will not be removed is said and left in the record, so the next partition
 * stored there tries again.
 */
const retire = async (
  db:        DatabaseSync,
  config:    ColdConfig,
  partition: string,
  keep:      string,
  remote:    Remote,
  say:       (line: string) => void,
): Promise<void> => {
  const old  = record.vaultFiles(db).filter(file => file.partition === partition && file.revision !== keep);
  const kept = new Set(record.vaultFilesOf(db, partition, keep).map(remoteOf));

  for (const revision of new Set(old.map(file => file.revision))) {
    let cleared = true;

    for (const file of old.filter(one => one.revision === revision && one.state !== 'planned')) {
      if (kept.has(remoteOf(file))) continue;

      try {
        await remote.remove(`${config.megaRoot}/${remoteOf(file)}`);
      } catch (err) {
        cleared = false;

        say(`Could not remove the replaced ${file.path} from cold storage: ${(err as Error).message}`);
      }
    }

    if (cleared) record.dropVaultRevision(db, partition, revision);
  }
};

const totalOf = (planned: VaultPlan): { partitions: number; files: number; bytes: number } =>
  [...planned.venues.values()].reduce(
    (sum, one) => ({ partitions: sum.partitions + one.partitions, files: sum.files + one.files, bytes: sum.bytes + one.bytes }),
    { partitions: 0, files: 0, bytes: 0 });

const loadOf = (load: { partitions: number; files: number; bytes: number }): string =>
  load.partitions === 0
    ? 'nothing new'
    : `${load.partitions.toLocaleString('en-US')} new partition${load.partitions === 1 ? '' : 's'} ready to push `
      + `(${load.files.toLocaleString('en-US')} file${load.files === 1 ? '' : 's'} · ${fmtBytes(load.bytes)})`;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_plan  = plan;
export const _test_round = round;
