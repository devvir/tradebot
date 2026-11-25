import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { onExit } from './cleanup';
import { isYes } from './options';
import { confirm } from '../../shared/ui/prompts';
import { info, warn } from '../../shared/ui/logger';

/**
 * One run of a command per origin at a time, on this host.
 *
 * **Keyed by both**: a file `cold.<origin>.<command>.lock` in cold's directory,
 * where the origin is whatever the command names in an origin's place. A run
 * holding it keeps out another run of the same command over the same origin,
 * and nothing else: another command, or the same one over another origin, takes
 * a lock of its own. Which commands may run beside which is theirs to say.
 *
 * **Taken only where there is none.** The file is created exclusively, so of two
 * runs starting at once only one has it. It names the process that took it, when,
 * in which boot of the machine, and a token only that run knows. It is given back
 * by the function `acquire` returns, and by `cleanup.ts` on the way out; either
 * way it is removed only while the token in it is still that run's.
 *
 * **A lock whose holder is gone is cleared; one still held is asked about.**
 * Where the process that took it is still there, the risk of overriding it is
 * the operator's to take, and they are standing right there. With `--yes`
 * nobody is, and the run stops.
 */
export const acquire = async (
  coldRoot: string,
  origin:   string,
  command:  string,
): Promise<() => void> => {
  const file  = path.join(coldRoot, `cold.${origin}.${command}.lock`);
  const token = randomUUID();
  const boot  = bootId();
  const mine  = `pid ${process.pid} since ${new Date().toISOString()}${boot ? ` boot ${boot}` : ''} token ${token}\n`;

  fs.mkdirSync(coldRoot, { recursive: true });

  // Created only where there is none, so two runs starting at once cannot both have it.
  if (! take(file, mine)) {
    const held = readLock(file);

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
     * So the pid is recorded in the file precisely so this can be checked, and
     * the boot it was taken in: after a restart, the same pid is somebody else.
     */
    if (! held && ! fs.existsSync(file)) {
      // Given back between the two: nothing to clear.
    } else if (held && ! holds(held)) {
      info(`Clearing the ${origin} ${command} lock left by ${held.who} — that process is gone`);
    } else {
      warn(`A cold ${command} ${origin} run is already holding the lock: ${held?.who ?? 'unreadable'}`);

      // Not a question `--yes` answers: with nobody to ask, a lock that is held stops the run.
      if (isYes() || ! await confirm('Remove it and continue anyway?', false))
        throw new Error('Locked — another cold run is in progress');
    }

    fs.rmSync(file, { force: true });

    // Another run that took it in the meantime has it.
    if (! take(file, mine)) throw new Error('Locked — another cold run is in progress');
  }

  let released = false;

  const give = (): void => {
    if (released) return;

    released = true;

    // Only while it is still this run's: one that was taken over is the other run's to give back.
    if (readLock(file)?.token === token) fs.rmSync(file, { force: true });
  };

  // Registered rather than wired to signals here: a run holds more than the
  // lock, and everything it holds has to come back by the same route. See
  // `cleanup.ts`.
  onExit(give);

  return give;
};

/** Whether a lock is lying in cold's directory whose holder is gone: a run that stopped without tidying up. */
export const orphaned = (coldRoot: string): boolean => orphans(coldRoot).length > 0;

/** The locks in cold's directory whose holder is gone, by file name. */
export const orphans = (coldRoot: string): string[] => holders(coldRoot).filter(one => ! holds(one)).map(one => one.name);

/** Whether another cold command is running: a lock whose holder is there. */
export const busy = (coldRoot: string): boolean => holders(coldRoot).some(one => one.pid !== process.pid && holds(one));

// ── Internals ─────────────────────────────────────────────────────────────────

/** What a lock file says: who took it, in which boot, and the token only that run knows. */
interface Lock {
  who:   string;
  pid:   number;
  boot:  string | null;
  token: string | null;
}

/** Create the lock file, unless there is one already. */
const take = (file: string, content: string): boolean => {
  try {
    fs.writeFileSync(file, content, { flag: 'wx' });

    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;

    throw err;
  }
};

/** A lock file's content, or null where there is none or it names no pid. */
const readLock = (file: string): Lock | null => {
  let held: string;

  try {
    held = fs.readFileSync(file, 'utf8').trim();
  } catch {
    // Given back between being looked for and being read.
    return null;
  }

  const pid = /pid (\d+)/.exec(held)?.[1];

  if (! pid) return null;

  return {
    who:   held.replace(/ (boot|token) \S+/g, ''),
    pid:   Number(pid),
    boot:  / boot (\S+)/.exec(held)?.[1] ?? null,
    token: / token (\S+)/.exec(held)?.[1] ?? null,
  };
};

/** Who holds each lock in cold's directory. */
const holders = (coldRoot: string): (Lock & { name: string })[] => {
  const locks = fs.existsSync(coldRoot) ? fs.readdirSync(coldRoot).filter(name => /^cold\..+\.lock$/.test(name)) : [];

  return locks.flatMap((name) => {
    const held = readLock(path.join(coldRoot, name));

    return held ? [{ ...held, name }] : [];
  });
};

/** Whether a lock's holder is still there: taken in this boot, by a process that exists. */
const holds = (held: Lock): boolean => {
  const boot = bootId();

  if (held.boot && boot && held.boot !== boot) return false;

  return alive(held.pid);
};

/** This boot of the machine, where the system says (Linux); null elsewhere. */
const bootId = (): string | null => {
  try {
    return fs.readFileSync(BOOT_ID, 'utf8').trim() || null;
  } catch {
    return null;
  }
};

const BOOT_ID = '/proc/sys/kernel/random/boot_id';

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
