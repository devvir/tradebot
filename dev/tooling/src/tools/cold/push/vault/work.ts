import fs from 'node:fs';
import path from 'node:path';
import { GB, POLL_MS, WATCH_MS } from '../../config';
import { onExit } from '../../cleanup';
import { isWatch } from '../../options';
import { Progress } from '../../shared/progress';
import * as record from '../../shared/record';
import { labelOf, remoteOf } from '../../shared/vault/layout';
import { noteBackedUp } from '../../shared/vault/ledger';
import { fmtBytes } from '../../../../shared/utils/format';
import { spacer, success } from '../../../../shared/ui/logger';
import { pendingOf, plan } from './plan';
import { trusted } from '../../shared/vault/trusted';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig } from '../../types';
import type { Remote } from '../types';
import type { StoredFile } from '../../shared/types';

/**
 * Move every pending file as far as it will go, round after round, until each
 * is stored — and, watching, look at the ledger again at intervals for what has
 * been stocked since.
 */
export const work = async (db: DatabaseSync, config: ColdConfig, venues: readonly string[], remote: Remote): Promise<void> => {
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

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_round = round;
