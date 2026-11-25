import fs from 'node:fs';
import { confirmVault } from '../confirm';
import { ledgersOf, recordOf, save } from '../../shared/backup';
import path from 'node:path';
import { GB, POLL_MS, WATCH_MS } from '../../config';
import { onExit } from '../../cleanup';
import { isWatch } from '../../options';
import { PushProgress } from '../progress';
import * as record from '../../shared/record';
import { labelOf, remoteOf } from '../../shared/vault/layout';
import { noteBackedUp, stockedIn } from '../../shared/vault/ledger';
import { fmtBytes } from '../../../../shared/utils/format';
import { spacer, success } from '../../../../shared/ui/logger';
import { pendingOf, plan } from './plan';
import { trusted } from '../../shared/vault/trusted';
import { landed } from '../../shared/mega';
import type { Listed } from '../../shared/types';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig } from '../../types';
import type { Remote } from '../../shared/types';
import type { StoredFile } from '../../shared/types';

/**
 * Move every pending file as far as it will go, round after round, until each
 * is stored — and, watching, look at the ledger again at intervals for what has
 * been stocked since.
 */
export const work = async (db: DatabaseSync, config: ColdConfig, venues: readonly string[], remote: Remote): Promise<void> => {
  /** The partitions still to be stored: those with a file to send, and those a run before this one left a step short. */
  const partitions = (): number =>
    new Set([...pendingOf(db, venues), ...unfinishedOf(db, config)].map(one => `${one.partition}|${one.revision}`)).size;

  const done     = record.vaultStored(db).size;
  const progress = new PushProgress(done + partitions(), done);

  onExit(() => progress.stop());
  progress.start();

  let scanAt  = Date.now() + WATCH_MS;
  let waiting = false;

  /** Files that cannot be sent and are kept as the record has them: not asked about again until the ledger is. */
  const kept = new Set<string>();

  /** From when what was stored has not had its second look — see `confirm.ts`. */
  let unconfirmed = new Date().toISOString();

  const confirm = async (): Promise<void> => {
    const from = unconfirmed;

    unconfirmed = new Date().toISOString();

    await confirmVault(db, config, from, remote, line => progress.log(line));
  };

  for (;;) {
    await remote.dropDuplicateUploads?.([config.vaultRoot]);

    if (isWatch() && Date.now() >= scanAt) {
      const before = partitions();

      // Watching, a vault that reports a problem is looked at again at the next scan: it does not fail the run.
      if (trusted(config, { watching: true }).ok) plan(db, config, venues);

      kept.clear();

      const found = partitions() - before;

      if (found > 0) progress.log(`Found ${found} new partition${found === 1 ? '' : 's'} ready to push`);

      progress.resize(record.vaultStored(db).size + partitions(), record.vaultStored(db).size);

      scanAt = Date.now() + WATCH_MS;
    }

    const pending    = pendingOf(db, venues).filter(file => ! kept.has(keyOf(file)));
    const unfinished = unfinishedOf(db, config);

    // A partition left a step short has nothing pending, and still has a round coming to it.
    if (pending.length === 0 && unfinished.length === 0) {
      // Everything found has been sent: what was stored is looked at once more, and what that undoes is sent again.
      if (! waiting) {
        await confirm();

        if (pendingOf(db, venues).some(file => ! kept.has(keyOf(file)))) continue;
      }

      if (! isWatch()) break;

      if (! waiting) progress.log('Watch mode - Waiting for new partitions to push');

      // Everything found has been sent: what that changed is kept too, before the wait.
      if (! waiting) await save(config, [recordOf(config), ...ledgersOf(config)]);

      waiting = true;

      await sleep(Math.max(1_000, Math.min(POLL_MS, scanAt - Date.now())));

      continue;
    }

    waiting = false;

    if (! await round(db, config, pending, remote, line => progress.log(line), (name, bytes) => progress.stored(name, bytes), kept, unfinished))
      await sleep(POLL_MS);
  }

  progress.stop();

  spacer();
  success('Pushed all partitions that were ready. Bye!');
};

// ── Internals ─────────────────────────────────────────────────────────────────

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
 * **A file no longer in the vault is forgotten with its revision** — unless
 * cold storage has held any file of that revision: then Mega may have the only
 * copy, and the record is the only thing that says so. It is said, left as the
 * record has it, and put in `kept`, so the rounds that follow pass it by.
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
  kept:    Set<string> = new Set(),

  /** The partitions a run before this one left a step short, as `unfinishedOf` gives them. */
  unfinished: readonly { partition: string; revision: string }[] = unfinishedOf(db, config),
): Promise<boolean> => {
  const queued = await remote.queuedPaths();

  // A queue whose size is not known has no room: nothing more is handed over until it is seen.
  const waiting = await remote.queue();

  let room  = waiting === null ? 0 : config.queueTargetGb * GB - waiting.remaining;
  let moved = false;

  /** What Mega holds below each venue of the vault, asked once a round. */
  const held = new Map<string, Awaited<ReturnType<Remote['listing']>>>();

  const inMega = async (file: StoredFile): Promise<Listed | null> => {
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

      // Stored where Mega lists the file that is on disk: its size and its own modification time — see `landed`.
      if (landed(local, there)) {
        record.moveVaultFile(db, file, 'stored', there!.handle);

        moved = true;

        continue;
      }

      // Handed over and gone from the queue without arriving: it is handed over again.
      record.moveVaultFile(db, file, 'planned');

      moved = true;
    }

    if (room <= 0) continue;

    if (! fs.existsSync(local)) {
      if (record.vaultFilesOf(db, file.partition, file.revision).some(heldOnce)) {
        say(`${file.path} is no longer in the vault, and cold storage has held its partition — it is left as the record has it`);

        kept.add(keyOf(file));

        continue;
      }

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

  /**
   * **And the partitions a run before this one left a step short**: every file
   * stored, and the run stopped before the partition was written down as whole.
   * None of their files is pending, so nothing above would ever come back to
   * them. Only at the revision the ledger has now — an older one is not a
   * partition to finish, but one to be replaced.
   */
  for (const key of new Set([...pending, ...unfinished].map(file => `${file.partition}|${file.revision}`))) {
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

/** The partitions of the revision the ledger has now whose files are all stored, and that are not written down as whole. */
const unfinishedOf = (db: DatabaseSync, config: ColdConfig): { partition: string; revision: string }[] => {
  const current = new Map((stockedIn(config.vaultRoot) ?? []).map(one => [one.partition, one.revision]));

  return record.vaultUnfinished(db).filter(one => current.get(one.partition) === one.revision);
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
  const files = record.vaultFilesOfPartition(db, partition);
  const old   = files.filter(file => file.revision !== keep);
  const kept  = new Set(files.filter(file => file.revision === keep).map(remoteOf));

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

/** Whether a vault file is, or has been, in cold storage as far as the record can tell. */
const heldOnce = (file: StoredFile): boolean => file.state === 'stored' || file.handle !== null || file.evictedAt !== null;

/** One vault file, as one string. */
const keyOf = (file: StoredFile): string => [file.partition, file.revision, file.instrument, file.side].join('|');

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_round = round;
