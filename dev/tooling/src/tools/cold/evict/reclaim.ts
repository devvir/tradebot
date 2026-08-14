import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fmtBytes } from '../../../shared/utils/format';
import { error, info, spacer, success } from '../../../shared/ui/logger';
import type { EvictGroup } from '../types';

const execFileAsync = promisify(execFile);

/**
 * Move the files to the host's trash, then remove the directories they leave.
 *
 * **Shared by both trees**, because deleting is the one part of eviction that
 * does not depend on what was decided or how. Archives judge a venue-month as a
 * whole and the vault judges a partition at a time, and by the time either gets
 * here the answer is the same shape: a set of paths that are provably in Mega.
 *
 * **The trash, not `unlink`.** Every check upstream has to be right for a
 * deletion to be safe, and the one thing none of them covers is a bug in the
 * checks themselves. `gio trash` costs nothing and turns that class of mistake
 * from permanent into a restore — which matters more for the collectors coming
 * later than it does here: an archive file can be fetched from the venue again,
 * a websocket capture never can.
 *
 * It lands on the **same filesystem**, which is what makes it viable at this
 * size: `/storage/.Trash-1000/` for a file under `/storage`, so it is a rename
 * rather than a 2.8 TB copy into `$HOME`. `gio` picks that per-volume trash
 * itself, and writes the `.trashinfo` record holding the original path and the
 * date — which is what makes a restore possible and what reaching into
 * `.Trash-1000` by hand would break.
 *
 * **It frees no space until the trash is emptied**, and that is the deliberate
 * shape rather than an oversight. A command whose purpose is reclaiming disk
 * that does not reclaim any looks wrong until you see the second step for what
 * it is: a chance to look at what was taken before it goes. Emptying is a file
 * manager's job, not this command's — the trash holds other people's things too.
 *
 * **A failed trash is never retried as a delete.** If `gio` is missing or the
 * volume refuses, that is a reason to stop, not to fall back to the
 * irreversible version of the same operation.
 *
 * File by file over the recorded set, never a directory at a time: anything that
 * arrived since packing is not in that set and must survive. The directories
 * then go with `rmdir`, which **fails on one that is not empty** — so a file
 * written between the walk and now keeps its parent, and the next run reports
 * the difference rather than a forced delete destroying it.
 */
export const reclaim = async (
  root:   string,
  groups: EvictGroup[],
  purge:  boolean,
): Promise<void> => {
  let moved  = 0;
  let freed  = 0;
  let failed = 0;

  const touched = new Set<string>();

  for (const group of groups) {
    const absolute: string[] = [];

    for (const file of group.files) {
      const full = path.join(root, file);

      try {
        freed += fs.statSync(full).size;
      } catch {
        continue;                       // Gone since the walk; nothing to take.
      }

      absolute.push(full);

      for (let dir = path.dirname(full); dir.startsWith(root); dir = path.dirname(dir))
        touched.add(dir);
    }

    try {
      if (purge) for (const full of absolute) fs.rmSync(full);
      else await trash(absolute);

      moved += absolute.length;

      info(`${group.label} — ${absolute.length.toLocaleString()} files ${purge ? 'deleted' : 'moved to trash'}`);
    } catch (err) {
      error(`${group.label}: ${(err as Error).message}`);

      failed++;
    }
  }

  // Deepest first, so a directory whose children have just gone is empty by the
  // time it is tried.
  let pruned = 0;

  for (const dir of [...touched].sort((a, b) => b.length - a.length)) {
    try {
      fs.rmdirSync(dir);
      pruned++;
    } catch {
      // Not empty, which is the answer: something else is in there.
    }
  }

  spacer();
  success(`${moved.toLocaleString()} files ${purge ? 'deleted' : 'moved to trash'} · `
    + `${pruned} empty director${pruned === 1 ? 'y' : 'ies'} removed`
    + (failed > 0 ? ` · ${failed} group${failed === 1 ? '' : 's'} failed` : ''));

  if (purge && moved > 0) info(`${fmtBytes(freed)} reclaimed`);

  if (! purge && moved > 0)
    info(`${fmtBytes(freed)} is reclaimed once the trash is emptied — nothing is freed until then`);
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Hand a batch of paths to the host's trash.
 *
 * Chunked because the argument vector is finite and a month can hold hundreds
 * of thousands of files, and batched because a process per file would dominate
 * the run — a whole batch costs about as long as one spawn.
 */
const trash = async (paths: string[]): Promise<void> => {
  for (let at = 0; at < paths.length; at += BATCH) {
    const batch = paths.slice(at, at + BATCH);

    try {
      await execFileAsync('gio', ['trash', ...batch], { timeout: 300_000 });
    } catch (err) {
      const detail = (err as { stderr?: string }).stderr?.toString().trim();

      throw new Error(`gio trash failed: ${detail || (err as Error).message}`);
    }
  }
};

/** Paths per `gio trash` call. Far under any argument limit, far over one spawn. */
const BATCH = 500;
