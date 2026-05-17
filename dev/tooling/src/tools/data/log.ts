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

// Two-tier logging:
//   - stdout (re-exported from the shared logger)
//   - command log (plain-text file, written only when --log is set)
//
// LOG_LEVEL=debug additionally opens `debug.log` alongside the command log.

// ── Stdout (re-exported from shared logger) ──────────────────────────────────

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

// ── Command log (plain-text, written when --log is set) ──────────────────────

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

