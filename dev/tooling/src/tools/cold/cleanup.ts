import { info } from '../../shared/ui/logger';

/**
 * What has to be given back before the process goes, however it goes.
 *
 * A run holds two things a later run would trip over: the lock file, and an open
 * SQLite handle. `try/finally` covers a normal return and a thrown error, but
 * not a signal — `process.exit` inside a handler skips every pending `finally`,
 * so anything relying on one is simply not run.
 *
 * So both are registered here instead, and the signal path and the ordinary path
 * end up in the same place.
 *
 * **Last registered, first released.** Registration order is the order things
 * were acquired — lock, then database — so unwinding in reverse hands them back
 * the way a stack would.
 */
export const onExit = (task: () => void): void => {
  tasks.push(task);

  install();
};

/** Run every registered task now, whether or not the process is ending. */
export const release = (): void => {
  while (tasks.length > 0) {
    try {
      tasks.pop()!();
    } catch {
      // Cleanup runs on the way out and has nobody left to report to. A handle
      // that will not close cannot be allowed to stop the lock being released.
    }
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

const tasks: (() => void)[] = [];

let installed = false;

const install = (): void => {
  if (installed) return;

  installed = true;

  process.once('exit', release);

  /**
   * The signal handler says the last word, because it gets there first.
   *
   * A Ctrl-C at a prompt also rejects the prompt with `ExitPromptError`, but
   * this runs before that rejection is delivered — so a caller catching it never
   * gets the chance to print anything, and the process would otherwise end
   * without a word.
   *
   * 128 + the signal number, which is what a shell reports for an interrupted
   * process and what a script checking `$?` expects.
   */
  const stop = (code: number) => (): void => {
    release();
    process.stdout.write('\n');
    info('Cancelled — nothing was left half-done; re-run to pick up where this stopped');
    process.exit(code);
  };

  process.once('SIGINT',  stop(130));
  process.once('SIGTERM', stop(143));
};
