/**
 * What every `cold` command is told the same way.
 *
 * `commands/cold.ts` sets these once, from the options given at the `cold`
 * level, before a command runs. A command reads what it has a use for; one
 * that has none ignores it.
 */

let watching = false;

// ── Set by commands/cold.ts ───────────────────────────────────────────────────

export const setWatch = (value: boolean): void => { watching = value; };

// ── Read by the commands ──────────────────────────────────────────────────────

/** Whether to keep running once the work is done, and look again at intervals. */
export const isWatch = (): boolean => watching;
