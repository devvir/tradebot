import { type RequestHandler } from 'express';
import { type ZodTypeAny } from 'zod';

// Derived from BitMEX swagger spec query parameter types
const NUMERIC_PARAMS = new Set([
  'asc', 'bookmarks', 'channelID', 'copied', 'count', 'depth',
  'max_aum', 'max_balance', 'max_copier', 'max_copier_pnl', 'max_mdd',
  'max_pnl', 'max_roi', 'min_aum', 'min_balance', 'min_copier',
  'min_copier_pnl', 'min_mdd', 'min_pnl', 'min_roi', 'period',
  'selectUserId', 'start', 'startId', 'targetAccountId',
]);

const BOOLEAN_PARAMS = new Set(['partial', 'reverse']);

/**
 * Route-level middleware factory. Coerces known numeric/boolean query params
 * from their string form, validates against the given Zod schema, and stores
 * the parsed result in res.locals.query. Forwards a ZodError to the error
 * handler on failure.
 */
export const validateQuery = (schema: ZodTypeAny): RequestHandler => (req, res, next) => {
  const result = schema.safeParse(coerceValues(req.query as Record<string, unknown>));

  if (! result.success)
    return next(result.error);

  res.locals.query = result.data;

  next();
};

// All HTTP query params arrive as strings. This coerces known numeric and
// boolean param names to their correct types before schema validation.
const coerceValues = (query: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(query)) {
    if (typeof value !== 'string') {
      out[key] = value;
    } else if (NUMERIC_PARAMS.has(key)) {
      out[key] = Number(value);
    } else if (BOOLEAN_PARAMS.has(key)) {
      out[key] = value === 'true';
    } else {
      out[key] = value;
    }
  }

  return out;
};
