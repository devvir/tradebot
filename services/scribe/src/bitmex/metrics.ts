import { logger } from '@devvir/service-kit';

const ONE_HOUR_MS = 60 * 60 * 1_000;

const startTime         = Date.now();
const recentFetchTimes: number[] = [];

let   totalFetches      = 0;
let   lastRemaining: number | null = null;

/**
 * Record a successful fetch and the rate-limit budget reported by BitMEX.
 * Wrapped in try/catch so a metrics bug can never disrupt the fetch path.
 */
export const recordFetch = (remaining: number | null): void => {
  try {
    const now = Date.now();

    totalFetches++;
    lastRemaining = remaining;
    recentFetchTimes.push(now);

    const cutoff = now - ONE_HOUR_MS;

    while (recentFetchTimes.length > 0 && recentFetchTimes[0]! < cutoff)
      recentFetchTimes.shift();
  } catch (err) {
    logger.warn({ err }, 'recordFetch failed (ignored)');
  }
};

/** Log lifetime and 1-hour moving averages of fetches per minute. */
export const logMetrics = (): void => {
  try {
    const now       = Date.now();
    const uptimeMin = (now - startTime) / 60_000;

    const lifetimePerMin = uptimeMin > 0
      ? totalFetches / uptimeMin
      : 0;

    const windowMin     = Math.min(uptimeMin, 60);
    const hourlyPerMin  = windowMin > 0
      ? recentFetchTimes.length / windowMin
      : 0;

    logger.info({
      totalFetches,
      lifetimePerMin: round1(lifetimePerMin),
      hourlyPerMin:   round1(hourlyPerMin),
      lastRemaining,
      uptimeMin:      Math.round(uptimeMin),
    }, 'Fetch metrics');
  } catch (err) {
    logger.warn({ err }, 'logMetrics failed (ignored)');
  }
};

// ── Private ───────────────────────────────────────────────────────────────────

const round1 = (n: number): number => Math.round(n * 10) / 10;
