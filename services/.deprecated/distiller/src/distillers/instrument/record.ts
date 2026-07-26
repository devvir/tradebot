/**
 * Throughput and coverage tracking for the instrument distiller.
 *
 * A self-contained measurement module: the distilling actors call `recordDoc`,
 * `recordGaps`, and `recordSymbols` as work happens, and this module owns its
 * own lifecycle — a five-minute metrics tick and a daily summary flushed when
 * the walked day rolls over. It never touches the distilling logic; a bug here
 * can only drop a metric, never a document, so every entry point is wrapped.
 *
 * The tick is suppressed while idle: once the distiller catches up to the
 * boundary and stops writing, the totals stop moving, so it logs one final
 * snapshot and then stays quiet until work resumes.
 *
 * Three counters drive everything:
 *   - `real`    — processed documents (real BitMEX data rewritten into the stream)
 *   - `synth`   — synthetic documents (gap fill plus the one hourly seal)
 *   - `dropped` — real rows discarded as out-of-order (read, never written): late
 *                 deltas whose hour was already sealed. Silent data loss unless
 *                 counted, so this is a first-line-of-defense signal.
 *
 * The synthetic share (`synthPct`) measures how much of the stream was
 * reconstructed; `lossPct` measures how much real data the out-of-order guard
 * shed; `docsPerSec` and the rolling 60-minute rates measure speed. A day that
 * suddenly shifts any of them is the signal to investigate. The hourly seal
 * counts as one synthetic document per hour — negligible against the millions a
 * day carries, and not worth special-casing.
 */

import { logger } from '@devvir/service-kit';

const HOUR_MINUTES = 60;
const TICK_MS      = 300_000;

/** A day shedding more than this many out-of-order real rows earns its own WARN. */
const DROP_WARN_THRESHOLD = 1_000;

const realBuckets  = new Array<number>(HOUR_MINUTES).fill(0);
const synthBuckets = new Array<number>(HOUR_MINUTES).fill(0);

let startTime     = Date.now();
let currentMinute = minuteOf(startTime);
let totalReal     = 0;
let totalSynth    = 0;
let totalDropped  = 0;

let day:        string | null = null;
let dayStartMs  = 0;
let dayReal     = 0;
let daySynth    = 0;
let dayDropped  = 0;
let dayGapCount = 0;
let dayGapMs    = 0;
let daySymbols  = 0;
let dayMarkFallback = new Set<string>();

let advanceTimer:     NodeJS.Timeout | null = null;
let tickTimer:        NodeJS.Timeout | null = null;
let lastEmittedTotal = -1;

// ── Public API ────────────────────────────────────────────────────────────────

/** Count one written document — `isReal` picks the real or synthetic counter. */
export const recordDoc = (isReal: boolean, date: string): void => {
  try {
    rollover(date);

    if (isReal) {
      realBuckets[currentMinute % HOUR_MINUTES]++;
      totalReal++;
      dayReal++;
    } else {
      synthBuckets[currentMinute % HOUR_MINUTES]++;
      totalSynth++;
      daySynth++;
    }
  } catch (err) {
    logger.warn({ err }, 'recordDoc failed (ignored)');
  }
};

/**
 * Count one real row discarded as out-of-order (read but never written). `date`
 * is the day being distilled (the served frontier's date), so the drop is
 * attributed to the day whose processing shed it — keeping rollover monotonic.
 */
export const recordDropped = (date: string): void => {
  try {
    rollover(date);

    totalDropped++;
    dayDropped++;
  } catch (err) {
    logger.warn({ err }, 'recordDropped failed (ignored)');
  }
};

/** Add one hour's gap span tally to the running day. */
export const recordGaps = (date: string, count: number, totalMs: number): void => {
  try {
    rollover(date);

    dayGapCount += count;
    dayGapMs    += totalMs;
  } catch (err) {
    logger.warn({ err }, 'recordGaps failed (ignored)');
  }
};

/**
 * Note that a `markMethod` not reproduced exactly was **active** during the day —
 * its `markPrice` is a same-family fallback, not its true formula (see
 * `docs/BitMEX/FAIR_PRICE_MARKING.md`). The per-day Set collects the distinct such
 * methods, so the daily summary reads "these approximated methods appeared today" —
 * an audit signal, *not* a count of approximate values emitted (it may fire for a
 * fallback symbol in a batch where no `markPrice` was produced, e.g. a quote-only
 * update; the dedup makes that immaterial to the summary).
 */
export const recordMarkFallback = (date: string, method: string): void => {
  try {
    rollover(date);

    dayMarkFallback.add(method);
  } catch (err) {
    logger.warn({ err }, 'recordMarkFallback failed (ignored)');
  }
};

/** Note the active-symbol count as of the latest sealed hour of the day. */
export const recordSymbols = (date: string, count: number): void => {
  try {
    rollover(date);

    daySymbols = count;
  } catch (err) {
    logger.warn({ err }, 'recordSymbols failed (ignored)');
  }
};

/** Start the minute-bucket rotation and the metrics tick. Idempotent. */
export const startRecording = (): void => {
  if (advanceTimer) clearInterval(advanceTimer);
  if (tickTimer)    clearInterval(tickTimer);

  advanceTimer = setInterval(advance,    60_000);
  tickTimer    = setInterval(logMetrics, TICK_MS);

  advanceTimer.unref();
  tickTimer.unref();
};

/** Stop the timers and flush the day in progress. */
export const stopRecording = (): void => {
  if (advanceTimer) clearInterval(advanceTimer);
  if (tickTimer)    clearInterval(tickTimer);

  advanceTimer = null;
  tickTimer    = null;

  if (day !== null) flushDay();

  day = null;
};

/** Log lifetime and rolling-60-minute throughput. */
export const logMetrics = (): void => {
  try {
    const total = totalReal + totalSynth + totalDropped;

    // Idle suppression: nothing processed since the last tick — stay quiet.
    if (total === lastEmittedTotal) return;

    lastEmittedTotal = total;

    const now      = Date.now();
    const uptimeMs  = now - startTime;
    const windowMs  = Math.min(uptimeMs, HOUR_MINUTES * 60_000);

    logger.info({
      day,                                                         // day currently being distilled
      lifetimeReal:     totalReal,
      lifetimeSynth:    totalSynth,
      lifetimeDropped:  totalDropped,
      real60mRate:      rate(sum(realBuckets),  windowMs),
      synth60mRate:     rate(sum(synthBuckets), windowMs),
      lifetimeSynthPct: pct(totalSynth, totalReal + totalSynth),
      symbols:          daySymbols,
      uptimeMin:        Math.round(uptimeMs / 60_000),
    }, 'Instrument progress');
  } catch (err) {
    logger.warn({ err }, 'logMetrics failed (ignored)');
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Switch the tracked day when a tracking call carries a new date. Flushes the
 * finished day's summary, then resets the per-day counters and announces the new
 * one. Called from every entry point, so whichever fires first for an hour rolls
 * the day over cleanly.
 */
function rollover(date: string): void {
  if (day === date) return;

  if (day !== null) flushDay();

  day         = date;
  dayStartMs  = Date.now();
  dayReal     = 0;
  daySynth    = 0;
  dayDropped  = 0;
  dayGapCount = 0;
  dayGapMs    = 0;
  daySymbols  = 0;
  dayMarkFallback = new Set();

  logger.info(`Distilling ${date} instrument`);
}

/** Emit the finished day's summary line. */
function flushDay(): void {
  const elapsedMs = Date.now() - dayStartMs;
  const docs      = dayReal + daySynth;

  logger.info({
    day,
    real:       dayReal,
    synth:      daySynth,
    dropped:    dayDropped,
    synthPct:   pct(daySynth,   docs),
    lossPct:    pct(dayDropped, dayReal + dayDropped),
    gapMin:     round1(dayGapMs / 60_000),
    symbols:    daySymbols,
    docsPerSec: rate(docs, elapsedMs),
    elapsedSec: round1(elapsedMs / 1_000),
    markFallback: dayMarkFallback.size > 0 ? [...dayMarkFallback].sort() : undefined,
  }, 'Day distilled');

  // A normal day sheds a handful of out-of-order rows; a flood means the source
  // is badly disordered for that day and the kept stream warrants a closer look.
  if (dayDropped > DROP_WARN_THRESHOLD) {
    logger.warn({
      day,
      dropped: dayDropped,
      lossPct: pct(dayDropped, dayReal + dayDropped),
    }, 'Instrument distiller: high out-of-order real-row loss');
  }
}

/**
 * Rotate the rolling-window pointer one minute forward and zero the bucket
 * about to collect fresh data. Driven by the timer — never the hot path.
 */
const advance = (): void => {
  currentMinute++;

  realBuckets[currentMinute  % HOUR_MINUTES] = 0;
  synthBuckets[currentMinute % HOUR_MINUTES] = 0;
};

const sum = (arr: number[]): number => arr.reduce((a, b) => a + b, 0);

const rate = (count: number, ms: number): number =>
  ms > 0 ? round1(count / (ms / 1_000)) : 0;

const pct = (part: number, whole: number): number =>
  whole > 0 ? round1((part / whole) * 100) : 0;

const round1 = (n: number): number => Math.round(n * 10) / 10;

function minuteOf(ms: number): number {
  return Math.floor(ms / 60_000);
}

// ── Test-only exports ─────────────────────────────────────────────────────────

export const _test_reset = (): void => {
  startTime        = Date.now();
  currentMinute    = minuteOf(startTime);
  totalReal        = 0;
  totalSynth       = 0;
  totalDropped     = 0;
  lastEmittedTotal = -1;

  day         = null;
  dayStartMs  = 0;
  dayReal     = 0;
  daySynth    = 0;
  dayDropped  = 0;
  dayGapCount = 0;
  dayGapMs    = 0;
  daySymbols  = 0;
  dayMarkFallback = new Set();

  realBuckets.fill(0);
  synthBuckets.fill(0);
};

export const _test_state = () => ({
  totalReal, totalSynth, totalDropped,
  day, dayReal, daySynth, dayDropped, dayGapCount, dayGapMs, daySymbols,
  markFallback: [...dayMarkFallback],
});

export const _test_advance = advance;
