import { warn } from '../../../shared/ui/logger';
import { isDateLike, parseDateRange } from './dates';
import type { DateRange, Pair, ParsedArgs } from '../types';

const ALL_KEYWORD = 'all';

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Split raw CLI args into date filters, collection names, and the `all` keyword.
 * Detection order: `all` → date-shaped → collection name.
 */
export function parseArgs(args: string[]): ParsedArgs {
  const dates: DateRange[] = [];
  const rawCollections: string[] = [];
  let useAll = false;

  for (const arg of args) {
    if (arg.toLowerCase() === ALL_KEYWORD) {
      useAll = true;
    } else if (isDateLike(arg)) {
      dates.push(parseDateRange(arg));
    } else {
      rawCollections.push(arg);
    }
  }

  return { dates, rawCollections, useAll };
}

/**
 * Resolve the requested collection list against what actually exists in the DB.
 * Warns on unknown names. With no specific collections but at least one date,
 * expands to every collection (date filter still applies).
 */
export function resolveCollections(
  raw:      string[],
  useAll:   boolean,
  dates:    DateRange[],
  allNames: string[],
): string[] {
  if (useAll) return allNames;

  if (raw.length === 0) {
    return dates.length > 0 ? allNames : [];
  }

  const known   = raw.filter(c => allNames.includes(c));
  const unknown = raw.filter(c => ! allNames.includes(c));

  if (unknown.length > 0) {
    warn(`Unknown collection${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  }

  return known;
}

/** Cartesian product of collections × dates. Empty dates → one pair per collection with `date: null`. */
export function buildPairs(collections: string[], dates: DateRange[]): Pair[] {
  if (dates.length === 0) {
    return collections.map(collection => ({ collection, date: null }));
  }

  const pairs: Pair[] = [];

  for (const collection of collections) {
    for (const date of dates) {
      pairs.push({ collection, date });
    }
  }

  return pairs;
}
