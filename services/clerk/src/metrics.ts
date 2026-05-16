import { logger } from '@devvir/service-kit';

const HOUR_MS       = 60 * 60 * 1_000;
const HOUR_MINUTES  = 60;

const startTime     = Date.now();
const minuteBuckets = new Array<number>(HOUR_MINUTES).fill(0);

let totalPublished = 0;
let currentMinute  = minuteOf(startTime);

/**
 * Record a successful publish (counted as one message, or `count` if a caller
 * wants to batch). Wrapped in try/catch so a metrics bug can never disrupt
 * the publish path.
 */
export const recordPublish = (count: number = 1): void => {
  try {
    advanceTo(minuteOf(Date.now()));

    minuteBuckets[currentMinute % HOUR_MINUTES] += count;
    totalPublished                              += count;
  } catch (err) {
    logger.warn({ err }, 'recordPublish failed (ignored)');
  }
};

/** Log lifetime and 1-hour rolling averages of messages per second. */
export const logMetrics = (): void => {
  try {
    const now = Date.now();

    advanceTo(minuteOf(now));

    const uptimeMs       = now - startTime;
    const lifetimePerSec = uptimeMs > 0 ? totalPublished / (uptimeMs / 1_000) : 0;

    const hourCount    = minuteBuckets.reduce((a, b) => a + b, 0);
    const windowMs     = Math.min(uptimeMs, HOUR_MS);
    const hourlyPerSec = windowMs > 0 ? hourCount / (windowMs / 1_000) : 0;

    logger.info({
      totalPublished,
      lifetimePerSec: round1(lifetimePerSec),
      hourlyPerSec:   round1(hourlyPerSec),
      uptimeMin:      Math.round(uptimeMs / 60_000),
    }, 'Clerk metrics');
  } catch (err) {
    logger.warn({ err }, 'logMetrics failed (ignored)');
  }
};

// ── Private ───────────────────────────────────────────────────────────────────

/**
 * Advance the rolling window to `targetMinute`, zeroing every bucket the
 * minute hand crosses on its way. Buckets older than an hour age out by
 * being overwritten on the next wrap-around.
 */
const advanceTo = (targetMinute: number): void => {
  while (currentMinute < targetMinute) {
    currentMinute++;

    minuteBuckets[currentMinute % HOUR_MINUTES] = 0;
  }
};

function minuteOf(ms: number): number {
  return Math.floor(ms / 60_000);
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
