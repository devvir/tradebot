import * as clock from '../core/clock';
import type { RestParams } from '../core/types';

/**
 * Parse a BitMEX REST query into normalised params, with the clock applied as a
 * hard **ceiling**: no record after "now" is ever served. So
 * `endTime = min(endTime ?? clock, clock)`; a future-anchored query collapses to
 * "the last N that exist," exactly like live BitMEX.
 */

const DEFAULT_COUNT = 100;
const MAX_COUNT     = 500;

export const parseParams = (q: Record<string, unknown>): RestParams => {
  const now = clock.fetch();

  return {
    symbol:    typeof q.symbol === 'string' && q.symbol.length > 0 ? q.symbol : undefined,
    count:     clampCount(q.count),
    start:     nonNeg(q.start),
    reverse:   q.reverse === 'true' || q.reverse === true,
    startTime: parseTime(q.startTime),
    endTime:   capEnd(parseTime(q.endTime), now),
    columns:   parseColumns(q.columns),
    depth:     parseDepth(q.depth),
  };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** No data after the clock: `endTime = min(endTime ?? now, now)`. */
const capEnd = (endTime: number | undefined, now: number | null): number | undefined => {
  if (now === null) return endTime;

  return endTime !== undefined ? Math.min(endTime, now) : now;
};

const parseTime = (raw: unknown): number | undefined => {
  if (raw === undefined || raw === null || raw === '') return undefined;

  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;

  if (typeof raw === 'string') {
    const n = Number(raw);

    if (Number.isFinite(n)) return n;

    const ms = Date.parse(raw);

    if (Number.isFinite(ms)) return ms;
  }

  return undefined;
};

const clampCount = (raw: unknown): number => {
  const n = Number(raw);

  if (! Number.isFinite(n) || n <= 0) return DEFAULT_COUNT;

  return Math.min(Math.floor(n), MAX_COUNT);
};

const nonNeg = (raw: unknown): number => {
  const n = Number(raw);

  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

const parseColumns = (raw: unknown): string[] | undefined => {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;

  return raw.split(',').map(s => s.trim()).filter(Boolean);
};

/** orderBook/L2 `depth` — non-negative integer (0 = full); undefined when absent. */
const parseDepth = (raw: unknown): number | undefined => {
  if (raw === undefined || raw === null || raw === '') return undefined;

  const n = Number(raw);

  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
};
