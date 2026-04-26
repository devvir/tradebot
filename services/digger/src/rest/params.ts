import * as clock from '../clock';

/**
 * BitMEX-style REST query parameters, normalised. Mirrors the public BitMEX
 * API so clients can swap the base URL between live and replay without code
 * changes.
 *
 * "Now" in replay means whatever the clock says. When the request doesn't
 * pin both ends of a time range, the missing bound resolves against `clock`
 * just like a live BitMEX call would resolve against wall-clock time.
 */
export interface RestParams {
  symbol?:    string;
  count:      number;
  start:      number;
  reverse:    boolean;
  startTime?: number;
  endTime?:   number;
  columns?:   string[];
}

const DEFAULT_COUNT = 100;
const MAX_COUNT     = 500;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse and normalise a request's query string. Throws on malformed values so
 * the route handler can return 400 with a clean error.
 */
export const parseRestParams = (query: Record<string, unknown>): RestParams => {
  const reverse   = parseBool(query.reverse);
  const now       = clock.fetch() ?? Date.now();
  const startTime = parseTime(query.startTime);
  const endTime   = parseTime(query.endTime) ?? (reverse ? now : undefined);

  return {
    symbol:    parseString(query.symbol),
    count:     parseCount(query.count),
    start:     parseNonNegativeInt(query.start, 0),
    reverse,
    startTime,
    endTime,
    columns:   parseColumns(query.columns),
  };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const parseString = (raw: unknown): string | undefined =>
  typeof raw === 'string' && raw.length > 0 ? raw : undefined;

const parseBool = (raw: unknown): boolean =>
  raw === true || raw === 'true' || raw === '1';

const parseCount = (raw: unknown): number => {
  const n = parseNonNegativeInt(raw, DEFAULT_COUNT);

  return Math.min(n, MAX_COUNT);
};

const parseNonNegativeInt = (raw: unknown, fallback: number): number => {
  if (raw === undefined || raw === null || raw === '') return fallback;

  const n = Number(raw);

  if (! Number.isFinite(n) || n < 0) {
    throw httpError(400, `Invalid integer: ${raw}`);
  }

  return Math.floor(n);
};

const parseTime = (raw: unknown): number | undefined => {
  if (raw === undefined || raw === null || raw === '') return undefined;

  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;

  if (typeof raw === 'string') {
    const ms = Date.parse(raw);

    if (! Number.isFinite(ms)) throw httpError(400, `Invalid time: ${raw}`);

    return ms;
  }

  throw httpError(400, `Invalid time: ${raw}`);
};

const parseColumns = (raw: unknown): string[] | undefined => {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;

  return raw.split(',').map(s => s.trim()).filter(Boolean);
};

const httpError = (status: number, message: string): Error =>
  Object.assign(new Error(message), { httpStatus: status });
