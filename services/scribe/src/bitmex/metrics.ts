import { logger } from '@devvir/service-kit';
import { budgets } from './identities';

const ONE_HOUR_MS = 60 * 60 * 1_000;

const startTime          = Date.now();
const recentFetchTimes:  number[] = [];
const recent429Times:    number[] = [];

let   totalFetches      = 0;
let   totalLatencyMs    = 0;
let   total429          = 0;

/**
 * Record one budget-consuming fetch — i.e. a 2xx response, including a look-ahead
 * page that's later discarded (it still spent a token). 429s don't consume budget
 * (they're rejected for being over the limit) and other errors are ambiguous, so
 * neither is counted: the rate here measures how hard we're actually drawing on
 * the limit. Wrapped in try/catch so a metrics bug can never disrupt the fetch path.
 */
export const recordFetch = (latencyMs = 0): void => {
  try {
    const now = Date.now();

    totalFetches++;
    totalLatencyMs += latencyMs;
    recentFetchTimes.push(now);
    pruneHour(recentFetchTimes, now);
  } catch (err) {
    logger.warn({ err }, 'recordFetch failed (ignored)');
  }
};

/**
 * Record an HTTP 429. Kept out of the fetch rate (no budget was spent) and tracked
 * on its own so a rising rate-limit count surfaces in the metrics before it turns
 * into a ban risk.
 */
export const record429 = (): void => {
  try {
    const now = Date.now();

    total429++;
    recent429Times.push(now);
    pruneHour(recent429Times, now);
  } catch (err) {
    logger.warn({ err }, 'record429 failed (ignored)');
  }
};

/** Log lifetime and 1-hour moving averages of fetches per minute. */
export const logMetrics = (): void => {
  try {
    const now       = Date.now();
    const uptimeMin = (now - startTime) / 60_000;

    pruneHour(recentFetchTimes, now);
    pruneHour(recent429Times, now);

    const lifetimePerMin = uptimeMin > 0
      ? totalFetches / uptimeMin
      : 0;

    const windowMin     = Math.min(uptimeMin, 60);
    const hourlyPerMin  = windowMin > 0
      ? recentFetchTimes.length / windowMin
      : 0;

    const metrics: Record<string, unknown> = {
      totalFetches,
      lifetimePerMin: round1(lifetimePerMin),
      hourlyPerMin:   round1(hourlyPerMin),
      avgFetchMs:     totalFetches > 0 ? Math.round(totalLatencyMs / totalFetches) : 0,
      budgets:        budgets(),
      uptimeMin:      Math.round(uptimeMin),
    };

    // Surface 429s only once they've actually happened — the field appearing is itself the alert.
    if (total429 > 0) {
      metrics.http429       = total429;
      metrics.http429Hourly = recent429Times.length;
    }

    logger.info(metrics, 'Fetch metrics');
  } catch (err) {
    logger.warn({ err }, 'logMetrics failed (ignored)');
  }
};

// ── Private ───────────────────────────────────────────────────────────────────

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Drop timestamps older than the rolling one-hour window. */
const pruneHour = (times: number[], now: number): void => {
  const cutoff = now - ONE_HOUR_MS;

  while (times.length > 0 && times[0]! < cutoff) times.shift();
};
