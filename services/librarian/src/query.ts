/**
 * Parsing for the `GET /:table` query params. Each parser returns the parsed
 * value, an `Error` to bubble up as 400, or `undefined` when the param is
 * absent and has no default.
 */

import type { Document, Filter } from 'mongodb';

const READ_LIMIT_DEFAULT = 10_000;

/** `limit` defaults to 10k, must be a positive finite integer. No upper cap — caller decides. */
export const parseLimit = (raw: unknown): number | Error => {
  if (raw === undefined) return READ_LIMIT_DEFAULT;

  const n = Number(raw);

  if (! Number.isFinite(n) || ! Number.isInteger(n) || n <= 0)
    return new Error('limit must be a positive integer');

  return n;
};

/** `from` is the lower `_id` cursor: a JS-safe number, matched as `_id: { $gte: from }`. */
export const parseFrom = (raw: unknown): number | undefined | Error => {
  if (raw === undefined) return undefined;

  const n = Number(raw);

  if (! Number.isFinite(n))
    return new Error('from must be a finite number');

  return n;
};

/**
 * `before` is the upper `_id` cursor, matched as `_id: { $lte: before }` — the
 * mirror of `from` for descending/backward reads. Combine with `from` for a
 * bounded `_id` range. A JS-safe number.
 */
export const parseBefore = (raw: unknown): number | undefined | Error => {
  if (raw === undefined) return undefined;

  const n = Number(raw);

  if (! Number.isFinite(n))
    return new Error('before must be a finite number');

  return n;
};

/**
 * `order` selects the `_id` sort direction — `asc` (default) or `desc`.
 * Descending powers reverse reads and the provider's binary-search probes
 * (`before=X&order=desc&limit=1` → the latest doc at-or-before `X`).
 */
export const parseOrder = (raw: unknown): 1 | -1 | Error => {
  if (raw === undefined) return 1;

  if (raw === 'asc'  || raw === '1')  return 1;
  if (raw === 'desc' || raw === '-1') return -1;

  return new Error("order must be 'asc' or 'desc'");
};

/** `filter` is an optional JSON object spread verbatim into the mongo query. */
export const parseFilter = (raw: unknown): Filter<Document> | undefined | Error => {
  if (raw === undefined) return undefined;

  if (typeof raw !== 'string')
    return new Error('filter must be a JSON string');

  try {
    const parsed = JSON.parse(raw);

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      return new Error('filter must be a JSON object');

    return parsed as Filter<Document>;
  } catch {
    return new Error('filter is not valid JSON');
  }
};
