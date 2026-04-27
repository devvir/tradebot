// Write-path health singleton.
//
// Decouples write failures (deep in the async writer) from the HTTP route that
// must reject new data. `fs/writer.ts` calls `recordFailure()` after a batch
// exhausts all retries; `server/routes.ts` calls `isHealthy()` before
// accepting `POST /rows` and returns 503 when unhealthy.

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

let healthy       = true;
let failureReason: string | null = null;
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

const recentFailures: number[] = [];

export const isHealthy        = (): boolean       => healthy;
export const getFailureReason = (): string | null => failureReason;

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
  healthy       = true;
  failureReason = null;
  recentFailures.length = 0;

  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
};
