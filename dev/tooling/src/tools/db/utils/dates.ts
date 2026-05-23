import { startOfDayMongoId } from '@tradebot/utils';
import type { DateRange } from '../types';

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Validate that a value looks like a partial ISO date (with or without dashes).
 * Accepts YYYY, YYYYMM, YYYYMMDD, YYYY-MM, and YYYY-MM-DD.
 */
export function isDateLike(value: string): boolean {
  const clean = value.replace(/-/g, '');

  if (! /^\d+$/.test(clean)) return false;
  if (clean.length !== 4 && clean.length !== 6 && clean.length !== 8) return false;

  if (clean.length >= 6) {
    const month = parseInt(clean.slice(4, 6), 10);

    if (month < 1 || month > 12) return false;
  }

  if (clean.length === 8) {
    const day = parseInt(clean.slice(6, 8), 10);

    if (day < 1 || day > 31) return false;
  }

  return true;
}

/** Normalise a partial ISO date string to YYYYMMDD, defaulting month/day to 01. */
export function normaliseDate(input: string): string {
  const clean = input.replace(/-/g, '');
  const year  = clean.slice(0, 4);
  const month = clean.slice(4, 6) || '01';
  const day   = clean.slice(6, 8) || '01';

  return year + month + day;
}

/**
 * Parse a date arg (YYYY, YYYYMM, YYYYMMDD; dashes optional) into a `_id` range:
 *   - YYYY     → entire calendar year
 *   - YYYYMM   → entire calendar month
 *   - YYYYMMDD → single calendar day
 *
 * Boundaries use the vault `_id` encoding (see `@tradebot/utils/startOfDayMongoId`),
 * so the resulting range is `{ _id: { $gte: startId, $lt: endId } }`.
 */
export function parseDateRange(input: string): DateRange {
  if (! isDateLike(input)) {
    throw new Error(`Invalid date: ${input}`);
  }

  const clean = input.replace(/-/g, '');

  const startYmd = padYmd(clean);
  const endYmd   = nextBoundary(clean);

  return {
    label:   formatLabel(clean),
    key:     clean,
    startId: startOfDayMongoId(startYmd),
    endId:   startOfDayMongoId(endYmd),
  };
}

// ── Internals ────────────────────────────────────────────────────────────────

function padYmd(clean: string): string {
  if (clean.length === 4) return clean + '0101';
  if (clean.length === 6) return clean + '01';

  return clean;
}

function nextBoundary(clean: string): string {
  if (clean.length === 4) {
    const y = parseInt(clean, 10);

    return `${y + 1}0101`;
  }

  if (clean.length === 6) {
    const y = parseInt(clean.slice(0, 4), 10);
    const m = parseInt(clean.slice(4, 6), 10);

    return m === 12
      ? `${y + 1}0101`
      : `${y}${pad2(m + 1)}01`;
  }

  const y = parseInt(clean.slice(0, 4), 10);
  const m = parseInt(clean.slice(4, 6), 10);
  const d = parseInt(clean.slice(6, 8), 10);
  const next = new Date(Date.UTC(y, m - 1, d + 1));

  return `${next.getUTCFullYear()}${pad2(next.getUTCMonth() + 1)}${pad2(next.getUTCDate())}`;
}

function formatLabel(clean: string): string {
  if (clean.length === 4) return clean;
  if (clean.length === 6) return `${clean.slice(0, 4)}-${clean.slice(4, 6)}`;

  return `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
