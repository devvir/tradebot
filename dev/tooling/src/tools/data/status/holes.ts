import { TableOrigin, tableOrigin } from '../scan/tables';
import { TableState } from '../scan/types';
import { dashed, nextDay } from '../ranges';

/**
 * Structural holes in vault data — gaps that exist because of how data is
 * sourced, not because anything went wrong. The range walker treats these
 * days as if they were present, so they don't fragment otherwise-clean ranges
 * into one row per real day.
 *
 * `SyncHoleRule`: pure date predicate, no external data.
 * `AsyncHoleRule`: fetches external data to determine which days are absent.
 *   Returns `null` on fetch failure — `computeHoles` adds `failCaption` in
 *   that case and skips filling so the raw missing rows remain visible.
 *
 * holes.ts owns both silencing and acknowledgement — a filled gap is never
 * quietly hidden.
 */

export interface HoleResult {
  filled: Set<string>;    // YYYYMMDD days the range walker should skip
  notes:  string[];       // captions for all rules that fired (or failed)
}

interface SyncHoleRule {
  kind:      'sync';
  caption:   string;
  appliesTo: (table: string, origin: TableOrigin | null) => boolean;
  isFilled:  (day: string, state: TableState) => boolean;
}

interface AsyncHoleRule {
  kind:        'async';
  caption:     string;
  failCaption: string;
  appliesTo:   (table: string, origin: TableOrigin | null) => boolean;
  /** Returns the set of filled days, or `null` if the fetch failed. */
  buildFilled: (fromDay: string, toDay: string) => Promise<Set<string> | null>;
}

type HoleRule = SyncHoleRule | AsyncHoleRule;

/**
 * Day before WS bucketing went live. Pre-this, the only WS data we have
 * comes from Tardis's free monthly archive, which only exposes the first
 * day of each month — every other day in those months is a permanent gap.
 */
const WS_BUCKETING_START = '20260308';

/** First date the settlement API is used as the source of truth for hole filling. */
const SETTLEMENT_API_START = '20260101';

const RULES: HoleRule[] = [
  {
    kind:      'sync',
    caption:   `WS tables: only day 01 of each month exists before ${dashed(WS_BUCKETING_START)} (from Tardis).`,
    appliesTo: (_table, origin) => origin === 'ws',
    isFilled:  (day, _state) => day < WS_BUCKETING_START && day.slice(6, 8) !== '01',
  },
  {
    kind:        'async',
    caption:     'Settlement: sparse table — settlements only happen a few times per month; missing dates have no data by design.',
    failCaption: 'Failed to fetch settlement dates from BitMEX; the displayed data on missing buckets may be inaccurate.',
    appliesTo:   (table) => table === 'settlement',
    buildFilled: (fromDay, toDay) => fetchSettlementFills(fromDay, toDay),
  },
];

// ── Public ────────────────────────────────────────────────────────────────────

/**
 * Computes all structurally filled days and the associated display notes for
 * `table` over `[fromDay, toDay]`. Async rules are awaited in parallel.
 *
 * The returned `notes` array includes:
 *   - captions for every rule that produced at least one filled day
 *   - fail captions for async rules whose fetch failed
 */
export async function computeHoles(
  table:   string,
  state:   TableState,
  fromDay: string,
  toDay:   string,
): Promise<HoleResult> {
  const origin = tableOrigin(table);
  const applicable = RULES.filter(r => r.appliesTo(table, origin));

  if (applicable.length === 0 || fromDay > toDay) {
    return { filled: new Set(), notes: [] };
  }

  const filled = new Set<string>();
  const notes: string[] = [];

  const syncRules  = applicable.filter((r): r is SyncHoleRule  => r.kind === 'sync');
  const asyncRules = applicable.filter((r): r is AsyncHoleRule => r.kind === 'async');

  for (let d = fromDay; d <= toDay; d = nextDay(d)) {
    for (const rule of syncRules) {
      if (rule.isFilled(d, state)) {
        filled.add(d);
        break;
      }
    }
  }

  for (const rule of syncRules) {
    if (hasFilledDayInSpan(rule, state, fromDay, toDay)) notes.push(rule.caption);
  }

  const asyncResults = await Promise.all(
    asyncRules.map(r => r.buildFilled(fromDay, toDay).then(res => ({ rule: r, res }))),
  );

  for (const { rule, res } of asyncResults) {
    if (res === null) {
      notes.push(rule.failCaption);
      continue;
    }

    for (const d of res) filled.add(d);
    if (res.size > 0) notes.push(rule.caption);
  }

  return { filled, notes };
}

// ── Settlement API ────────────────────────────────────────────────────────────

/**
 * Fetches known settlement dates from the BitMEX public API and returns the
 * set of days in `[fromDay, toDay] ∩ [SETTLEMENT_API_START, ∞)` that are
 * NOT settlement dates — those are structural holes (no settlement happened).
 *
 * Returns `null` on fetch failure after all retries.
 */
async function fetchSettlementFills(fromDay: string, toDay: string): Promise<Set<string> | null> {
  const effectiveFrom = fromDay < SETTLEMENT_API_START ? SETTLEMENT_API_START : fromDay;

  if (effectiveFrom > toDay) return new Set();

  const startTime = dashed(effectiveFrom);
  const url = `https://www.bitmex.com/api/v1/settlement?startTime=${startTime}&count=500`;
  const raw = await fetchWithRetries(url, 5, 1000);

  if (raw === null) return null;

  const settlementDays = new Set<string>();

  for (const record of raw as Array<{ timestamp: string }>) {
    if (typeof record.timestamp === 'string') {
      settlementDays.add(record.timestamp.slice(0, 10).replace(/-/g, ''));
    }
  }

  const filled = new Set<string>();

  for (let d = effectiveFrom; d <= toDay; d = nextDay(d)) {
    if (! settlementDays.has(d)) filled.add(d);
  }

  return filled;
}

async function fetchWithRetries(url: string, retries: number, delayMs: number): Promise<unknown[] | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(delayMs);

    try {
      const res = await fetch(url);

      if (res.ok) return await res.json() as unknown[];
    } catch {
      // retry
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hasFilledDayInSpan(rule: SyncHoleRule, state: TableState, fromDay: string, toDay: string): boolean {
  for (let d = fromDay; d <= toDay; d = nextDay(d)) {
    if (rule.isFilled(d, state)) return true;
  }

  return false;
}
