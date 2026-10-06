import { confirm } from '../../shared/ui/prompts';

/**
 * What every `cold` command is told the same way.
 *
 * `commands/cold.ts` sets these once, from the options given at the `cold`
 * level, before a command runs. A command reads what it has a use for; one
 * that has none ignores it.
 */

let watching = false;
let yes      = false;

// ── Set by commands/cold.ts ───────────────────────────────────────────────────

export const setWatch = (value: boolean): void => { watching = value; };
export const setYes   = (value: boolean): void => { yes = value; };

// ── Read by the commands ──────────────────────────────────────────────────────

/** Whether to keep running once the work is done, and look again at intervals. */
export const isWatch = (): boolean => watching;

/** Whether every question a command would ask has been answered yes beforehand. */
export const isYes = (): boolean => yes;

/**
 * Ask before doing something, unless the answer was given on the command line.
 *
 * **`--yes` answers what a command asks about its own work** — go ahead, remove
 * these, bring those back — so that a run from a script or a crontab has nobody
 * to wait for. It does not answer for anything else: a lock another run is
 * holding is still a reason to stop.
 */
export const agreed = async (message: string, fallback: boolean): Promise<boolean> =>
  yes ? true : confirm(message, fallback);
