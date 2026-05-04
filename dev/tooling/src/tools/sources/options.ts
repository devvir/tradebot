/**
 * Shared command state for all `sources` subcommands.
 *
 * `commands/sources.ts` sets these once during argument resolution.
 * Subcommands read what they need — options they don't use are simply ignored.
 */

let _isDryRun = false;
let _fromDay: string | null = null;
let _logPath: string | null = null;

// ── Setters (called by commands/sources.ts) ───────────────────────────────────

export function setDryRun(value: boolean): void        { _isDryRun = value; }
export function setFromDay(value: string | null): void { _fromDay = value; }
export function setLogPath(value: string | null): void { _logPath = value; }

// ── Getters (called by subcommands and shared utilities) ──────────────────────

export function isDryRun(): boolean      { return _isDryRun; }
export function fromDay(): string | null { return _fromDay;  }
export function logPath(): string | null { return _logPath;  }