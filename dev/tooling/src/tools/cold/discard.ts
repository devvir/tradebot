import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

/**
 * Taking things off the local disk, for every command that does.
 *
 * **To the host's trash unless told otherwise.** Every check a command makes
 * before removing something has to be right for the removal to be safe, and
 * the one thing none of them covers is a mistake in the checks. The trash is on
 * the same volume, so it is a rename; it frees no space until it is emptied,
 * which is the chance to look at what was taken. A trash that fails is never
 * retried as a delete.
 */

/** Take these files and directories off the disk: to the trash, or outright where `purge` says so. */
export const discard = async (paths: readonly string[], purge: boolean): Promise<void> => {
  if (! purge) return trash(paths);

  let breathed = Date.now();

  for (const one of paths) {
    fs.rmSync(one, { recursive: true, force: true });

    // Hundreds of thousands of them: the thread is handed back so that a Ctrl-C is heard.
    if (Date.now() - breathed >= BREATH_MS) {
      await new Promise(resolve => setImmediate(resolve));

      breathed = Date.now();
    }
  }
};

/**
 * Hand files and directories to the host's trash.
 *
 * Through `gio`, never by moving files into a `.Trash-*` directory by hand: it
 * picks the trash of the volume the file is on, so the move is a rename, and
 * writes the record holding where each file came from — which is what makes
 * putting one back possible.
 *
 * Chunked because the argument vector is finite and a partition can hold
 * hundreds of thousands of files, and batched because a process per file would
 * be most of the run.
 */
const trash = async (paths: readonly string[]): Promise<void> => {
  for (let at = 0; at < paths.length; at += BATCH) {
    try {
      await execFileAsync('gio', ['trash', ...paths.slice(at, at + BATCH)], { timeout: 300_000 });
    } catch (err) {
      const detail = (err as { stderr?: string }).stderr?.toString().trim();

      throw new Error(`gio trash failed: ${detail || (err as Error).message}`);
    }
  }
};

/** Paths per `gio trash` call. Far under any argument limit, far over one spawn. */
const BATCH = 500;

const execFileAsync = promisify(execFile);

/** How long removal may hold the thread before handing it back. */
const BREATH_MS = 20;
