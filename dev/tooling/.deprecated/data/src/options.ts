/**
 * Shared command state for all `data` subcommands.
 *
 * `commands/data.ts` sets these once during argument resolution.
 * Subcommands read what they need — options they don't use are simply ignored.
 */

let _isDryRun    = false;
let _isYes       = false;
let _fromDay:    string | null = null;
let _logPath:    string | null = null;
let _concurrency = 1;

// ── Setters (called by commands/data.ts) ───────────────────────────────────

export function setDryRun(value: boolean): void        { _isDryRun = value; }
export function setYes(value: boolean): void           { _isYes = value; }
export function setFromDay(value: string | null): void { _fromDay = value; }
export function setLogPath(value: string | null): void { _logPath = value; }
export function setConcurrency(value: number): void    { _concurrency = value; }

// ── Getters (called by subcommands and shared utilities) ──────────────────────

export function isDryRun(): boolean      { return _isDryRun;    }
export function isYes(): boolean         { return _isYes;       }
export function fromDay(): string | null { return _fromDay;     }
export function logPath(): string | null { return _logPath;     }
export function concurrency(): number    { return _concurrency; }