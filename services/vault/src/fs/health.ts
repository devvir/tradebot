// Write-path health singleton.
//
// Two distinct concerns, kept separate so one offending file does not block
// every other write:
//
//   - Storage health (global). When write failures pile up across all writes
//     within FAILURE_WINDOW_MS, vault returns 503 to ALL clients until a
//     canary write succeeds. This is the "the disk is broken" signal.
//
//   - Per-path backpressure (local). When a single file's inflight write
//     count crosses the writer threshold, that one file's path is added to a
//     throttled set. Routes return 429 only for requests targeting a
//     throttled file; every other path is unaffected.
//
// `fs/writer.ts` calls `recordFailure()` after a batch exhausts all retries,
// and `setBackpressure(path, busy, count)` as a per-handle inflight count
// crosses the busy/resume thresholds. `server/routes.ts` calls `isHealthy()`
// for the 503 check and `isThrottled(table, filename)` for the 429 check.

import path from 'path';
import { appendFileSync, existsSync, unlinkSync } from 'fs';
import { logger } from '@devvir/service-kit';
import { DATA_DIR } from './paths';

// ── Thresholds ────────────────────────────────────────────────────────────────
//
// Vault goes unhealthy when FAILURE_THRESHOLD write failures (after all
// per-batch retries are exhausted) occur within FAILURE_WINDOW_MS. A single
// transient error that clears on retry never contributes to the count.

const FAILURE_THRESHOLD    = 5;
const FAILURE_WINDOW_MS    = 60_000;
const RECOVERY_INTERVAL_MS = 5_000;

// ── State ─────────────────────────────────────────────────────────────────────

let healthy            = true;
let failureReason: string | null = null;
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

const throttledPaths = new Set<string>();

const recentFailures: number[] = [];

export const isHealthy        = (): boolean       => healthy;
export const getFailureReason = (): string | null => failureReason;

/** True when this specific file is currently shedding load (returns 429). */
export const isThrottled = (table: string, filename: string): boolean => {
  return throttledPaths.has(`${table}/${filename}`);
};

/**
 * Called from the writer when a single file's inflight write count crosses
 * the busy threshold (busy=true) or drains back below the resume threshold
 * (busy=false). Throttle is per-path: only requests for that exact
 * `table/filename` are rejected with 429; other files keep flowing.
 */
export const setBackpressure = (path: string, busy: boolean, count: number = 0): void => {
  if (busy) {
    if (throttledPaths.has(path)) return;

    throttledPaths.add(path);

    logger.warn({ path, inflightCount: count }, 'Vault path throttled — returning 429 to write clients');
  } else {
    if (! throttledPaths.has(path)) return;

    throttledPaths.delete(path);

    logger.info({ path }, 'Vault path throttle cleared — resuming normal operation');
  }
};

/** Called from the writer when one batch exhausts all retries. */
export const recordFailure = (reason: string): void => {
  const now    = Date.now();
  const cutoff = now - FAILURE_WINDOW_MS;

  while (recentFailures.length > 0 && recentFailures[0]! < cutoff) {
    recentFailures.shift();
  }

  recentFailures.push(now);

  logger.warn({ reason, recentFailures: recentFailures.length, threshold: FAILURE_THRESHOLD }, 'Write batch dropped after retries');

  if (recentFailures.length >= FAILURE_THRESHOLD) {
    setUnhealthy(`${recentFailures.length} write failures in the last minute — last: ${reason}`);
  }
};

// ── Transitions ───────────────────────────────────────────────────────────────

const setUnhealthy = (reason: string): void => {
  if (! healthy) return;

  healthy       = false;
  failureReason = reason;

  logger.error({ reason }, 'Vault storage unhealthy — returning 503 to insert clients');

  scheduleRecovery();
};

const setHealthy = (): void => {
  if (healthy) return;

  healthy       = true;
  failureReason = null;
  recentFailures.length = 0;

  logger.info('Vault storage recovered — resuming normal operation');
};

// ── Recovery probe ────────────────────────────────────────────────────────────
//
// While unhealthy, attempt a canary write every RECOVERY_INTERVAL_MS.
// Transitions back to healthy as soon as the probe succeeds.

const CANARY_PATH = path.join(DATA_DIR, '.health-canary');

const scheduleRecovery = (): void => {
  if (recoveryTimer) return;

  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    tryRecover();
  }, RECOVERY_INTERVAL_MS);
};

const tryRecover = (): void => {
  try {
    appendFileSync(CANARY_PATH, '');

    if (existsSync(CANARY_PATH)) unlinkSync(CANARY_PATH);

    setHealthy();
  } catch (err) {
    logger.warn({ err }, 'Recovery probe failed — retrying');

    scheduleRecovery();
  }
};

// ── Test helpers ──────────────────────────────────────────────────────────────

export const _test_reset = (): void => {
  healthy            = true;
  failureReason      = null;
  throttledPaths.clear();
  recentFailures.length = 0;

  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
};
