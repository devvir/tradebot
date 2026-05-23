import { C } from '../../../shared/utils/colors';
import { fmtNum, fmtRate, fmtElapsed } from './format';

const TTY_REFRESH_MS    = 500;     // in-place progress refresh on a TTY
const NONTTY_REFRESH_MS = 10_000;  // newline progress when output is redirected
const CLEAR_LINE        = '\r\x1b[K';

// ── Exports ──────────────────────────────────────────────────────────────────

export const PROGRESS_TTY_REFRESH_MS    = TTY_REFRESH_MS;
export const PROGRESS_NONTTY_REFRESH_MS = NONTTY_REFRESH_MS;

/** Render a single progress line: count/total, %, rate, elapsed, ETA. */
export function renderProgress(written: number, expected: number, startMs: number, nowMs: number, isTty: boolean): void {
  const elapsedSec = (nowMs - startMs) / 1000;
  const rate       = elapsedSec > 0 ? written / elapsedSec : 0;
  const pct        = expected > 0 ? Math.min(100, (written / expected) * 100) : 0;
  const remaining  = Math.max(0, expected - written);
  const eta        = rate > 0 && remaining > 0 ? remaining / rate : 0;

  const parts = [
    `  ${fmtNum(written)}${expected > 0 ? ` / ${fmtNum(expected)} (${pct.toFixed(1)}%)` : ''}`,
    `${fmtRate(rate)}/s`,
    `elapsed ${fmtElapsed(elapsedSec)}`,
  ];

  if (eta > 0) parts.push(`ETA ${fmtElapsed(eta)}`);

  const line = parts.join('  ·  ');

  if (isTty) {
    process.stdout.write(`${CLEAR_LINE}${C.dim}${line}${C.reset}`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

/** Write a transient status line (in-place on TTY, newline otherwise). */
export function writeStatus(message: string): void {
  if (process.stdout.isTTY) {
    process.stdout.write(`${CLEAR_LINE}${C.dim}${message}${C.reset}`);
  } else {
    process.stdout.write(`${message}\n`);
  }
}

/** Clear the current transient status line on TTY; no-op otherwise. */
export function clearStatus(): void {
  if (process.stdout.isTTY) {
    process.stdout.write(CLEAR_LINE);
  }
}
