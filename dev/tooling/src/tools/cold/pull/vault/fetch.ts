import fs from 'node:fs';
import path from 'node:path';
import { POLL_MS } from '../../config';
import { meter } from '../../shared/meter';
import * as record from '../../shared/record';
import { remoteOf } from '../../shared/vault/layout';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig } from '../../types';
import type { Fetching } from '../types';
import type { StoredFile } from '../../shared/types';

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

  const show = (): void => {
    if (! process.stdout.isTTY) return;

    const done = wanted.length - pending.length - failed;

    process.stdout.write(`\r\x1b[K  ${meter((done / wanted.length) * 100)} ${done}/${wanted.length} files back`);
  };

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

  if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');

  return failed;
};

/** Times a file is asked for before it is given up on for this run. */
const ATTEMPTS = 3;

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_fetch    = fetch;
