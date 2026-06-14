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

/**
 * Known data-start dates per table. Days strictly before these dates are
 * structural pre-history — the yearly Mega tars cover the full year but no
 * actual data exists for those early days, so the range walker must not
 * treat them as missing.
 */
const TABLE_START: Record<string, string> = {
  // All WS tables — first Tardis date available
  announcement:        '20190401',
  chat:                '20190401',
  connected:           '20190401',
  instrument:          '20190401',
  liquidation:         '20190401',
  orderBookL2:         '20190401',
  publicNotifications: '20190401',

  // REST tables
  compositeIndex: '20161201',
  funding:        '20160507',
  insurance:      '20160228',
  quote:          '20141122',
  tick:           '20141106',
  trade:          '20141122',

  // Secondary liquidity pool — first data mid-April 2026
  'quote.secondary': '20260414',
  'trade.secondary': '20260416',
};

const PRE_HISTORY_RULES: SyncHoleRule[] = Object.entries(TABLE_START).map(([table, start]) => ({
  kind:      'sync',
  caption:   '',    // no footer note — pre-history is not a gap
  appliesTo: (t: string) => t === table,
  isFilled:  (day: string) => day < start,
}));

const CHAT_CONNECTED_MISSING_DAYS = new Set([
  '20260316', '20260317', '20260318', '20260325', '20260326',
]);

const COMPOSITEINDEX_MISSING_DAYS = new Set([
  '20190106', '20190107', '20230313', '20230314', '20230315',
]);

// trade.secondary: the Secondary pool was barely active in its first days, with
// no trades at all on these dates. quote.secondary has no such gaps.
const TRADE_SECONDARY_MISSING_DAYS = new Set([
  '20260417', '20260419', '20260420', '20260421',
]);

const RULES: HoleRule[] = [
  {
    kind:      'sync',
    caption:   `WS tables: only first day of each month exists before ${dashed(WS_BUCKETING_START)} (from Tardis).`,
    appliesTo: (_table, origin) => origin === 'ws',
    isFilled:  (day, _state) => day < WS_BUCKETING_START && day.slice(6, 8) !== '01',
  },
  {
    kind:      'sync',
    caption:   'Chat and Connected: full days missed in March 2026 (days: 16, 17, 18, 25, and 26).',
    appliesTo: (table) => table === 'chat' || table === 'connected',
    isFilled:  (day) => CHAT_CONNECTED_MISSING_DAYS.has(day),
  },
  {
    kind:      'sync',
    caption:   'CompositeIndex: BitMEX published no data for 2019-01-06/07, and 2023-03-13/15.',
    appliesTo: (table) => table === 'compositeIndex',
    isFilled:  (day) => COMPOSITEINDEX_MISSING_DAYS.has(day),
  },
  ...PRE_HISTORY_RULES,
  {
    kind:        'async',
    caption:     'Settlement: sparse table — just a few buckets per month; missing dates by design.',
    failCaption: 'Failed to fetch settlement dates from BitMEX; the displayed data may be inaccurate.',
    appliesTo:   (table) => table === 'settlement',
    buildFilled: (fromDay, toDay) => fetchSettlementFills(fromDay, toDay),
  },
  {
    kind:      'sync',
    caption:   'trade.secondary: Secondary pool barely active at launch — no trades on 2026-04-17/19/20/21.',
    appliesTo: (table) => table === 'trade.secondary',
    isFilled:  (day) => TRADE_SECONDARY_MISSING_DAYS.has(day),
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
    if (rule.caption && hasFilledDayInSpan(rule, state, fromDay, toDay)) notes.push(rule.caption);
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

const SETTLEMENT_PAGE_SIZE = 500;

/**
 * Fetches every known settlement date from the BitMEX public API and returns
 * the set of days in `[fromDay, toDay]` that are NOT settlement dates —
 * those are structural holes (no settlement happened, by design).
 *
 * Pagination walks `start=0, 500, 1000, …` until a page returns fewer than
 * `SETTLEMENT_PAGE_SIZE` rows. All ~3k of BitMEX's historic settlements fit
 * in a handful of pages, so the cost is trivial and we cover the entire
 * history rather than a single recent window.
 *
 * Returns `null` if any page's fetch fails after all retries — partial
 * coverage would mis-mark real settlement days as missing in the un-fetched
 * range, which is worse than surfacing the failCaption and leaving the
 * raw missing rows visible.
 */
async function fetchSettlementFills(fromDay: string, toDay: string): Promise<Set<string> | null> {
  if (fromDay > toDay) return new Set();

  const settlementDays = await fetchAllSettlementDays();

  if (settlementDays === null) return null;

  const filled = new Set<string>();

  for (let d = fromDay; d <= toDay; d = nextDay(d)) {
    if (! settlementDays.has(d)) filled.add(d);
  }

  return filled;
}

async function fetchAllSettlementDays(): Promise<Set<string> | null> {
  const days = new Set<string>();

  for (let start = 0; ; start += SETTLEMENT_PAGE_SIZE) {
    const url  = `https://www.bitmex.com/api/v1/settlement?start=${start}&count=${SETTLEMENT_PAGE_SIZE}`;
    const page = await fetchWithRetries(url, 5, 1000);

    if (page === null) return null;

    for (const record of page as Array<{ timestamp: string }>) {
      if (typeof record.timestamp === 'string') {
        days.add(record.timestamp.slice(0, 10).replace(/-/g, ''));
      }
    }

    if (page.length < SETTLEMENT_PAGE_SIZE) break;
  }

  return days;
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
