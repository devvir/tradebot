/**
 * Throughput metrics for the farmer pipeline.
 *
 * Two counters with two rates each (lifetime + rolling 60-minute):
 *   - `read`  — items entered the pipeline
 *   - `write` — items finished (successful insertMany)
 *
 * Plus a "paused" accumulator for the reader-side queue so the read rate
 * can be reported as an *active* rate (excluding time spent at the high
 * watermark). Comparing the two rates surfaces where the bottleneck is:
 * read >> write + high pausedPct → downstream limiter; read ≈ write,
 * low pausedPct → equilibrium.
 *
 * Errors written to `farmer.<table>` and dropped empty partials are *not*
 * counted in `recordWrite` — that counter reflects only what landed in
 * `tradebot.<table>`.
 */

import { logger } from '@devvir/service-kit';

const HOUR_MINUTES = 60;

const readBuckets  = new Array<number>(HOUR_MINUTES).fill(0);
const writeBuckets = new Array<number>(HOUR_MINUTES).fill(0);

let startTime     = Date.now();
let totalRead     = 0;
let totalWritten  = 0;
let currentMinute = minuteOf(startTime);

let pausedTotalMs   = 0;
let pauseStartMs:   number | null = null;
let pauseCount      = 0;

let readerQueueProbe: () => number = () => -1;

let advanceTimer:   NodeJS.Timeout | null = null;

// ── Public API ────────────────────────────────────────────────────────────────

export const recordRead = (count: number = 1): void => {
  readBuckets[currentMinute % HOUR_MINUTES] += count;
  totalRead                                 += count;
};

export const recordWrite = (count: number): void => {
  writeBuckets[currentMinute % HOUR_MINUTES] += count;
  totalWritten                               += count;
};

/** Start the once-a-minute bucket rotation. Idempotent — safe to call again. */
export const startMetricsAdvance = (): void => {
  if (advanceTimer) clearInterval(advanceTimer);

  advanceTimer = setInterval(advance, 60_000);
  advanceTimer.unref();
};

export const stopMetricsAdvance = (): void => {
  if (! advanceTimer) return;

  clearInterval(advanceTimer);
  advanceTimer = null;
};

export const recordReadPause = (): void => {
  if (pauseStartMs !== null) return;

  pauseStartMs = Date.now();
  pauseCount++;

  logger.debug({ pauseCount, queueSize: readerQueueProbe() }, 'Reader paused');
};

export const recordReadResume = (): void => {
  if (pauseStartMs === null) return;

  const durationMs = Date.now() - pauseStartMs;

  pausedTotalMs += durationMs;
  pauseStartMs   = null;

  logger.debug({ pauseCount, durationMs, queueSize: readerQueueProbe() }, 'Reader resumed');
};

/** Wire up a probe so `readerQueueSize` can be reported without coupling metrics to buffer construction. */
export const setReaderQueueProbe = (probe: () => number): void => {
  readerQueueProbe = probe;
};

export const logMetrics = (): void => {
  try {
    const now = Date.now();

    const uptimeMs       = now - startTime;
    const currentPaused  = pauseStartMs !== null ? now - pauseStartMs : 0;
    const totalPaused    = pausedTotalMs + currentPaused;
    const activeMs       = Math.max(0, uptimeMs - totalPaused);

    const windowMs       = Math.min(uptimeMs, HOUR_MINUTES * 60_000);
    const hourlyReads    = sum(readBuckets);
    const hourlyWrites   = sum(writeBuckets);

    logger.info({
      totalRead,
      totalWritten,
      readRateActive:  rate(totalRead,    activeMs),
      writeRate:       rate(totalWritten, uptimeMs),
      hourlyReadRate:  rate(hourlyReads,  windowMs),
      hourlyWriteRate: rate(hourlyWrites, windowMs),
      pausedPct:       uptimeMs > 0 ? round1((totalPaused / uptimeMs) * 100) : 0,
      pauseCount,
      readerQueueSize: readerQueueProbe(),
      uptimeMin:       Math.round(uptimeMs / 60_000),
    }, 'Farmer metrics');
  } catch (err) {
    logger.warn({ err }, 'logMetrics failed (ignored)');
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Rotate the rolling-window pointer one minute forward and zero the bucket
 * that's about to start collecting fresh data. Driven by the periodic timer
 * in `startMetricsAdvance` — never invoked from the hot path.
 */
const advance = (): void => {
  currentMinute++;

  readBuckets[currentMinute  % HOUR_MINUTES] = 0;
  writeBuckets[currentMinute % HOUR_MINUTES] = 0;
};

const sum = (arr: number[]): number => arr.reduce((a, b) => a + b, 0);

const rate = (count: number, ms: number): number =>
  ms > 0 ? round1(count / (ms / 1_000)) : 0;

const round1 = (n: number): number => Math.round(n * 10) / 10;

function minuteOf(ms: number): number {
  return Math.floor(ms / 60_000);
}

// ── Test-only exports ─────────────────────────────────────────────────────────

export const _test_HOUR_MINUTES = HOUR_MINUTES;

export const _test_reset = (): void => {
  startTime     = Date.now();
  currentMinute = minuteOf(startTime);
  totalRead     = 0;
  totalWritten  = 0;
  pausedTotalMs = 0;
  pauseStartMs  = null;
  pauseCount    = 0;

  readBuckets.fill(0);
  writeBuckets.fill(0);

  startMetricsAdvance();
};
