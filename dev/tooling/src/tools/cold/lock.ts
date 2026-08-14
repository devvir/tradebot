import fs from 'node:fs';
import path from 'node:path';
import { onExit } from './cleanup';
import { confirm } from '../../shared/ui/prompts';
import { info, warn } from '../../shared/ui/logger';

/**
 * One run of a command per origin at a time.
 *
 * **Keyed by both, because neither alone is the thing at risk.** Two pushes over
 * one origin would plan the same unpacked files twice and pack them into two sets
 * of tars, both of which would upload; two evicts would walk and prompt over the
 * same tree. Neither collision crosses origins — each stages into its own
 * directory, recovers only from that directory, and diffs only its own rows.
 *
 * **A push and an evict do not collide, so they do not share a lock.** The files
 * are disjoint by construction: evict deletes only what an *uploaded* part
 * records and blocks any month holding a part Mega does not have yet, while push
 * plans only what is not already packed at the same size and mtime — so an
 * evicted file is never a candidate, it is simply not there. Push already treats
 * the tree as something that moves underneath it, skipping a directory it cannot
 * read and a file it cannot stat, and evict never writes to the database at all.
 * Sharing a lock bought none of that and cost the availability: a push that runs
 * for days would lock eviction out for days, exactly when a filling tree most
 * needs reclaiming.
 *
 * The upload queue *is* shared, and is meant to be. Pacing reads it globally on
 * purpose, so a second origin's transfers are backlog in front of ours in
 * exactly the way an upload started by hand would be — which is the honest
 * answer, since there is one link either way.
 *
 * The lock is a file rather than anything cleverer because the thing being
 * protected is a directory of tars on one host.
 *
 * **A stale lock is offered rather than enforced.** A crashed run leaves one
 * behind, and refusing to start until someone finds the file is worse than
 * asking — the risk of overriding it is the operator's to take, and they are
 * standing right there.
 */
export const acquire = async (
  coldRoot: string,
  origin:   string,
  command:  string,
): Promise<() => void> => {
  const file = path.join(coldRoot, `cold.${origin}.${command}.lock`);

  fs.mkdirSync(coldRoot, { recursive: true });

  if (fs.existsSync(file)) {
    const held  = fs.readFileSync(file, 'utf8').trim();
    const owner = /pid (\d+)/.exec(held)?.[1];

    /**
     * **A lock whose holder is gone is not a question.**
     *
     * Cleanup gives the lock back on the way out, but only for exits it gets to
     * see — a `SIGKILL`, a lost terminal, a machine going down, or simply a bug
     * in the handler leaves the file behind with nobody behind it. Asking a
     * person to confirm what the process table already answers is how a stale
     * lock becomes a habit of saying yes, which is the opposite of what a lock
     * is for.
     *
     * So the pid is recorded in the file precisely so this can be checked.
     * Signal 0 delivers nothing and only reports whether the process exists.
     */
    if (owner && ! alive(Number(owner))) {
      info(`Clearing a lock left by ${held} — that process is gone`);

      fs.rmSync(file, { force: true });
    } else {
      warn(`A cold ${command} ${origin} run is already holding the lock: ${held}`);

      if (! await confirm('Remove it and continue anyway?', false))
        throw new Error('Locked — another cold run is in progress');

      fs.rmSync(file, { force: true });
    }
  }

  fs.writeFileSync(file, `pid ${process.pid} since ${new Date().toISOString()}\n`);

  let released = false;

  const give = (): void => {
    if (released) return;

    released = true;
    fs.rmSync(file, { force: true });
  };

  // Registered rather than wired to signals here: a run holds more than the
  // lock, and everything it holds has to come back by the same route. See
  // `cleanup.ts`.
  onExit(give);

  return give;
};

/** Whether a process exists. Signal 0 delivers nothing and only asks. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (err) {
    // EPERM means it exists and belongs to somebody else, which still counts.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};
