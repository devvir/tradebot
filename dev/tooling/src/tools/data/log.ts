import fs from 'node:fs';
import path from 'node:path';
import {
  info    as _info,
  success as _success,
  warn    as _warn,
  error   as _error,
  section as _section,
  spacer  as _spacer,
  debug   as _debug,
  openDebugLog  as _openDebugLog,
  closeDebugLog as _closeDebugLog,
} from '../../shared/ui/logger';
import { logPath } from './options';

// ── Tier 1 — stdout (re-exported from shared logger) ─────────────────────────

export const info          = _info;
export const success       = _success;
export const warn          = _warn;
export const error         = _error;
export const section       = _section;
export const spacer        = _spacer;
export const debug         = _debug;
export const openDebugLog  = _openDebugLog;
export const closeDebugLog = _closeDebugLog;

/**
 * Open a debug log file alongside the command log when `LOG_LEVEL=debug` is
 * set AND `--log` was passed. No-op otherwise. The file is named `debug.log`
 * and lives in the same directory as the command log.
 */
export function setupDebugLog(): void {
  const logFile = logPath();

  if (! logFile)                            return;
  if (process.env.LOG_LEVEL !== 'debug')    return;

  const logDir = path.dirname(logFile);

  fs.mkdirSync(logDir, { recursive: true });
  _openDebugLog(path.join(logDir, 'debug.log'));
}

// ── Tier 2 — command log (plain-text, written when --log is set) ──────────────

/**
 * Append a plain-text line to the log file set by --log, prefixed with a
 * UTC timestamp. No-op when logPath() is null (--log was not passed).
 */
export function log(message: string): void {
  const filePath = logPath();

  if (! filePath) return;

  const ts = new Date().toISOString();

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `[${ts}] ${message}\n`);
}

/**
 * Append multiple lines to the log file set by --log. The first line is
 * prefixed with a UTC timestamp; subsequent lines are indented to align.
 * No-op when logPath() is null (--log was not passed).
 */
export function logLines(lines: string[]): void {
  const filePath = logPath();

  if (! filePath) return;

  const ts     = new Date().toISOString();
  const prefix = `[${ts}] `;
  const indent = ' '.repeat(prefix.length);

  const content = lines
    .map((line, i) => (i === 0 ? prefix + line : indent + line))
    .join('\n') + '\n';

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, content);
}

// ── Tier 3 — bucket log (per processed file/group) ───────────────────────────

/**
 * Write a plain-text log file for one processed unit (e.g. one prepared day).
 * Always written to `<fallbackDir>/<filename>` — next to the output files.
 * --log controls general command logs only and does not redirect bucket logs.
 *
 * @param filename    - Bare filename, e.g. `20260403.log`
 * @param fallbackDir - Directory to write the log into (always used)
 * @param lines       - Content lines (joined with newlines)
 */
export function writeBucketLog(
  filename:    string,
  fallbackDir: string,
  lines:       string[],
): string | null {
  if (logPath()) return null;

  const dir = fallbackDir;

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    _warn(`Cannot create log directory: ${dir}`);

    return null;
  }

  const filePath = path.join(dir, filename);

  try {
    fs.writeFileSync(filePath, lines.join('\n') + '\n');

    return filePath;
  } catch {
    _warn(`Failed to write log: ${filePath}`);

    return null;
  }
}

