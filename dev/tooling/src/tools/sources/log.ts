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

// ── Tier 2 — command log (plain-text, written when --log is set) ──────────────

/**
 * Append a plain-text line to the log file set by --log.
 * No-op when logPath() is null (--log was not passed).
 */
export function log(message: string): void {
  const filePath = logPath();

  if (! filePath) return;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, message + '\n');
}

// ── Tier 3 — bucket log (per processed file/group) ───────────────────────────

/**
 * Write a plain-text log file for one processed unit (e.g. one prepared day).
 * Written to `<logPath>/<filename>` when --log was passed,
 * otherwise to `<fallbackDir>/<filename>`.
 *
 * @param filename    - Bare filename, e.g. `20260403.log`
 * @param fallbackDir - Directory to use when --log was not passed
 * @param lines       - Content lines (joined with newlines)
 */
export function writeBucketLog(
  filename:    string,
  fallbackDir: string,
  lines:       string[],
): string | null {
  const dir = (logPath() ? path.dirname(logPath()!) : null) ?? fallbackDir;

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

