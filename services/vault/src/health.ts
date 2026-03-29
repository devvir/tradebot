import { logger } from '@devvir/service-kit';
import { appendFileSync, existsSync, unlinkSync } from 'fs';
import path from 'path';

// ── Thresholds ─────────────────────────────────────────────────────────────────
//
// Vault goes unhealthy when FAILURE_THRESHOLD write failures (after all per-item
// retries are exhausted) occur within FAILURE_WINDOW_MS. A single transient error
// that clears on retry never contributes to the count.

const FAILURE_THRESHOLD  = 5;
const FAILURE_WINDOW_MS  = 60_000;
const RECOVERY_INTERVAL_MS = 5_000;

// ── State ──────────────────────────────────────────────────────────────────────

let healthy       = true;
let failureReason: string | null = null;
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

const recentFailures: number[] = []; // timestamps of exhausted-retry failures

export const isHealthy        = (): boolean       => healthy;
export const getFailureReason = (): string | null => failureReason;

// ── Called when one item exhausts all retries ─────────────────────────────────

export const recordFailure = (reason: string): void => {
  const now    = Date.now();
  const cutoff = now - FAILURE_WINDOW_MS;

  // Evict failures outside the window.
  while (recentFailures.length > 0 && recentFailures[0]! < cutoff) {
    recentFailures.shift();
  }

  recentFailures.push(now);

  logger.warn({ reason, recentFailures: recentFailures.length, threshold: FAILURE_THRESHOLD }, 'Write item dropped after retries');

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

export const setHealthy = (): void => {
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

const CANARY_PATH = path.join('/data/vault', '.health-canary');

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
