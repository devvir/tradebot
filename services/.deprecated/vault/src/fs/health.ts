// Write-path health singleton.
//
// Two distinct concerns, kept separate so one offending file does not block
// every other write:
//
//   - Storage health (global). When write failures pile up across all writes
//     within FAILURE_WINDOW_MS, storage is unhealthy until a canary write
//     succeeds. This is the "the disk is broken" signal.
//
//   - Per-path backpressure (local). When a single file's inflight write
//     count crosses the writer threshold, that one file's path is added to a
//     throttled set; every other path is unaffected.
//
// `recordFailure()` counts one write failure that lost data and `isHealthy()`
// reports the resulting storage verdict. `setBackpressure(path, busy, count)`
// sets or clears one path's throttle and `isThrottled(table, filename)`
// reports it.

import path from 'path';
import { openSync, writeSync, fsyncSync, closeSync, unlinkSync } from 'fs';
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

/** True while this specific file is throttled. */
export const isThrottled = (table: string, filename: string): boolean => {
  return throttledPaths.has(`${table}/${filename}`);
};

/**
 * Throttles `path` (a `table/filename`) when its inflight write count crosses
 * the busy threshold (busy=true) and clears it once the count drains back
 * below the resume threshold (busy=false). Throttle is per-path: every other
 * file is unaffected. Setting a path to the state it is already in is a no-op.
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

/** Records one write failure that lost data: a batch that could not be written. */
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
// Transitions back to healthy as soon as the probe succeeds. The canary is a
// block of real bytes fsynced to disk, so a full disk fails the probe: an
// empty write allocates nothing and would succeed even then.

const CANARY_BYTES = 4096;

const canaryPath = (): string => path.join(DATA_DIR, '.health-canary');

const scheduleRecovery = (): void => {
  if (recoveryTimer) return;

  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    tryRecover();
  }, RECOVERY_INTERVAL_MS);
};

const tryRecover = (): void => {
  const canary = canaryPath();

  try {
    writeCanary(canary);
    unlinkSync(canary);

    setHealthy();
  } catch (err) {
    logger.warn({ err }, 'Recovery probe failed — retrying');

    try { unlinkSync(canary); } catch { /* best effort: the canary may not exist */ }

    scheduleRecovery();
  }
};

const writeCanary = (canary: string): void => {
  const fd = openSync(canary, 'w');

  try {
    const written = writeSync(fd, Buffer.alloc(CANARY_BYTES));

    if (written < CANARY_BYTES) throw new Error(`Canary write was short: ${written} of ${CANARY_BYTES} bytes`);

    fsyncSync(fd);
  } finally {
    closeSync(fd);
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
