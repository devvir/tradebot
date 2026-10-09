import fs from 'node:fs';
import path from 'node:path';
import { POLL_MS } from '../../config';
import { transferName } from '../mega';
import { Progress } from '../progress';
import { follow } from '../progress-mega';
import * as record from '../record';
import { remoteOf } from './layout';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig } from '../../types';
import type { Fetching } from '../types';
import type { StoredFile } from '../types';

/**
 * Ask Mega for every file and wait until each is back. Returns how many never
 * came.
 *
 * All of them are asked for at once: Mega keeps its own queue, which outlives
 * this command, so a run stopped here leaves them coming and the next run finds
 * them arrived. A file Mega drops without delivering is asked for again, up to
 * `ATTEMPTS` times.
 */
export const fetch = async (
  db:      DatabaseSync,
  config:  ColdConfig,
  wanted:  readonly StoredFile[],
  remote:  Fetching,
  pollMs = POLL_MS,
): Promise<number> => {
  const local   = (file: StoredFile): string => path.join(config.vaultRoot, file.path);
  const arrived = (file: StoredFile): boolean => {
    try {
      return fs.statSync(local(file)).size === file.bytes;
    } catch {
      return false;
    }
  };

  const tries   = new Map<StoredFile, number>();
  let   pending = [...wanted];
  let   failed  = 0;

  // Two lines: every file together, counted as each is found back, and the one on its way.
  const progress = new Progress();
  const paths    = new Set(wanted.map(local));

  const show = (): void =>
    progress.set(ALL, { label: 'vault files back', done: wanted.length - pending.length - failed, total: wanted.length, unit: 'count', of: 'files' });

  if (remote.transfers)
    follow(progress, { id: ONE, queue: 'downloads', mine: to => paths.has(to), label: coming => transferName(coming.path), mark: '↓', rank: 1, read: remote.transfers });

  for (;;) {
    const coming = await remote.downloadingPaths();
    const still: StoredFile[] = [];
    const back:  StoredFile[] = [];

    for (const file of pending) {
      if (coming.has(local(file))) {
        still.push(file);

        continue;
      }

      if (arrived(file)) {
        back.push(file);

        continue;
      }

      const asked = tries.get(file) ?? 0;

      if (asked >= ATTEMPTS) {
        failed++;

        continue;
      }

      fs.mkdirSync(path.dirname(local(file)), { recursive: true });

      // Whatever is there is not the file: a download cut short, or something else's.
      fs.rmSync(local(file), { force: true });

      await remote.queueDownload(`${config.megaRoot}/${remoteOf(file)}`, path.dirname(local(file)));

      tries.set(file, asked + 1);
      still.push(file);
    }

    record.noteVaultMoves(db, back, 'restored');

    pending = still;

    show();

    if (pending.length === 0) break;

    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  progress.stop();

  return failed;
};

/** The block's two lines: every file together, and the one on its way. */
const ALL = 'all';
const ONE = 'one';

/** Times a file is asked for before it is given up on for this run. */
const ATTEMPTS = 3;

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_fetch    = fetch;
