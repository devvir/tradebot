import inquirer from 'inquirer';
import { confirm } from '../../shared/ui/prompts';

export const setWatch = (value: boolean): void => { watching = value; };

export const setYes   = (value: boolean): void => { yes = value; };

/** Whether to keep running once the work is done, and look again at intervals. */
export const isWatch = (): boolean => watching;

/** Whether every question a command would ask has been answered beforehand, each with its own default. */
export const isYes = (): boolean => yes;

/**
 * Ask before doing something, unless the answer was given on the command line.
 *
 * **`--yes` gives every question its own default** — what pressing return
 * would answer — so that a run from a script or a crontab has nobody to wait
 * for. That is yes wherever a command asks whether to do what it was run to do,
 * and no where doing it would change nothing. It does not answer for anything
 * else: a lock another run is holding is still a reason to stop.
 */
export const agreed = async (message: string, fallback: boolean): Promise<boolean> =>
  yes ? fallback : confirm(message, fallback);

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * What every `cold` command is told the same way.
 *
 * `commands/cold.ts` sets these once, from the options given at the `cold`
 * level, before a command runs. A command reads what it has a use for; one
 * that has none ignores it.
 */

let watching = false;

let yes      = false;

/**
 * Ask which of several things to do, unless the answer was given on the command
 * line: then it is the one that would be chosen by pressing return.
 */
export const picked = async <T>(message: string, choices: readonly { name: string; value: T }[], fallback: T): Promise<T> => {
  if (yes) return fallback;

  const { answer } = await inquirer.prompt<{ answer: T }>([{ type: 'list', name: 'answer', message, choices: [...choices], default: fallback }]);

  return answer;
};
