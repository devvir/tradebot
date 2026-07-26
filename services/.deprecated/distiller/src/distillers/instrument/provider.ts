import type { Db }           from 'mongodb';
import { startOfDayMongoId } from '@tradebot/utils';

import type { Reader } from './reader';
import { recordGaps } from './record';
import { createRolling, addTrade, computeMinuteBlock } from './rolling';
import type {
  EventRow, EventSource, HourBuckets, InstrumentItem, RollingState, StreamItem, TradeRow,
} from './types';

/** A silence at least this long between real instrument docs is a gap to fill. */
const GAP_THRESHOLD_MS = 60_000;

/** BitMEX emits the 24h stats block every minute, 15 s past the minute. */
const CRON_PERIOD_MS = 60_000;
const CRON_OFFSET_MS = 15_000;

const HOUR_MS   = 3_600_000;
const WINDOW_MS = 86_400_000;

/** Lead-in replayed on bootstrap so eviction and the final cron are exact. */
const PRIME_LEAD_MS = WINDOW_MS + HOUR_MS;

interface Span { start: number; end: number; }

/**
 * Combines the seven source tables into one timestamp-ordered stream per hour,
 * synthesizing only where real instrument data is missing. Owns the rolling
 * 24h window — carried state, fed by every hour's trades.
 */
export class Provider {
  private reader: Reader | null = null;
  private readonly window = new Map<string, RollingState>();

  /** Point the Provider at the Reader for a new boundary epoch. */
  attach(reader: Reader): void {
    this.reader = reader;
  }

  /**
   * Rebuild the rolling 24h window on resume by streaming the ~25 h of trades
   * before `anchorMs` straight into the minute bins — never materialized as an
   * array. Emits nothing. The minute bins are order-insensitive within
   * data-prepare's disorder bound, so no sort is needed; each symbol's
   * `lastVwap` is then brought to its as-of-anchor value by running the last
   * pre-anchor cron, which is what a live walk would have left it at.
   */
  async primeWindow(db: Db, anchorMs: number): Promise<void> {
    const fromMs = anchorMs - PRIME_LEAD_MS;
    const loId   = startOfDayMongoId(isoDate(fromMs));
    const hiId   = startOfDayMongoId(addDay(isoDate(anchorMs)));

    const cursor = db.collection<TradeRow>('trade')
      .find({ _id: { $gte: loId, $lt: hiId } })
      .sort({ _id: 1 });

    for await (const t of cursor) {
      const ms = toMs(t.timestamp);

      if (ms >= fromMs && ms < anchorMs) this.applyTrade(t, ms);
    }

    const lastCron = firstCron(anchorMs) - CRON_PERIOD_MS;

    for (const w of this.window.values()) computeMinuteBlock(w, lastCron);
  }

  /**
   * The next hour's timestamp-ordered stream, ready for the Walker — or `null`
   * when the Reader has drained. The Reader picks the hour: the oldest buffered.
   */
  async getHourlyData(): Promise<{ hour: string; items: StreamItem[] } | null> {
    if (! this.reader) throw new Error('instrument: provider has no reader attached');

    const served = await this.reader.pop();

    if (! served) return null;

    const { hour, buckets } = served;
    const hourStart = Date.parse(`${hour}:00:00.000Z`);
    const hourEnd   = hourStart + HOUR_MS;

    sortByTime(buckets);

    const spans = gapSpans(hourStart, hourEnd, buckets.instrument);
    const inGap = (ms: number): boolean => spans.some(s => ms > s.start && ms < s.end);

    recordGaps(hour.slice(0, 10), spans.length, spans.reduce((a, s) => a + (s.end - s.start), 0));

    // Feed the window with every trade; collect rolling items only inside gaps.
    const rolling = this.feedWindow(buckets.trade, hourStart, hourEnd, inGap);
    const items:  StreamItem[] = [];

    for (const doc of buckets.instrument) {
      items.push({ kind: 'real', ms: toMs(doc.timestamp), doc });
    }

    // The index value: compositeIndex normally; the `tick` fallback for an hour
    // where compositeIndex has no data at all (a BitMEX compositeIndex outage).
    if (buckets.compositeIndex.length > 0) {
      pushEvents(items, 'compositeIndex', buckets.compositeIndex, inGap);
    } else {
      pushEvents(items, 'tick', buckets.tick, inGap);
    }

    pushEvents(items, 'quote',      buckets.quote,      inGap);
    pushEvents(items, 'funding',    buckets.funding,    inGap);
    pushEvents(items, 'settlement', buckets.settlement, inGap);

    for (const item of rolling) items.push(item);

    items.sort(compareItems);

    return { hour, items };
  }

  /* ---------------------------------------------------------------- */

  /**
   * Replay trades and minute-crons across `[fromMs, toMs)` into the window.
   * The crons run every minute — gap or not — so eviction and `lastVwap` stay
   * faithful; `collectIf` decides which ticks become `rolling` stream items.
   */
  private feedWindow(
    trades:     TradeRow[],
    fromMs:     number,
    toMs2:      number,
    collectIf?: (ms: number) => boolean,
  ): StreamItem[] {
    const out: StreamItem[] = [];

    let ti     = 0;
    let cronMs = firstCron(fromMs);

    for (;;) {
      const tradeMs = ti < trades.length ? toMs(trades[ti]!.timestamp) : Infinity;

      if (tradeMs >= toMs2 && cronMs >= toMs2) break;

      if (tradeMs < toMs2 && tradeMs <= cronMs) {
        const t     = trades[ti++]!;
        const delta = this.applyTrade(t, tradeMs);

        if (delta && collectIf?.(tradeMs))
          out.push({ kind: 'rolling', ms: tradeMs, symbol: t.symbol!, fields: delta });

      } else {
        const ms = cronMs;

        cronMs += CRON_PERIOD_MS;

        if (ms >= toMs2) continue;

        const collect = collectIf?.(ms) ?? false;

        for (const [sym, w] of this.window) {
          const block = computeMinuteBlock(w, ms);

          if (collect) out.push({ kind: 'rolling', ms, symbol: sym, fields: block });
        }
      }
    }

    return out;
  }

  /**
   * Fold one trade into its symbol's rolling state, creating the state on first
   * sight. Returns the trade-driven delta, or `null` for an unusable row.
   */
  private applyTrade(t: TradeRow, ms: number): Partial<InstrumentItem> | null {
    const sym = t.symbol;

    if (! sym || t.size === undefined || t.price === undefined) return null;

    let w = this.window.get(sym);

    if (! w) {
      w = createRolling();
      this.window.set(sym, w);
    }

    return addTrade(
      w, ms, t.size, t.price,
      t.grossValue ?? 0, t.homeNotional ?? 0, t.foreignNotional ?? 0, t.tickDirection ?? '',
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

/** Stream-merge order: same ms breaks by source, then by the source's own key. */
const PRIORITY: Record<string, number> = {
  real: 0, compositeIndex: 1, tick: 1, quote: 2, rolling: 3, funding: 4, settlement: 5,
};

/**
 * The gap spans inside an hour — silences over `GAP_THRESHOLD_MS`.
 *
 * The Reader buckets every row by its own hour key, so every doc here already lands
 * inside `[hourStart, hourEnd)`; the in-hour check below is a cheap defensive
 * assertion of that invariant (it never fires in practice). It was load-bearing under
 * the old reference-fold, which placed foreign-timestamp rows into a bucket — that
 * fold is gone.
 */
function gapSpans(hourStart: number, hourEnd: number, realDocs: { timestamp: string }[]): Span[] {
  const spans: Span[] = [];

  let prev = hourStart;

  for (const doc of realDocs) {
    const ms = toMs(doc.timestamp);

    if (ms < hourStart || ms >= hourEnd) continue;   // defensive; can't fire (see above)

    if (ms - prev > GAP_THRESHOLD_MS) spans.push({ start: prev, end: ms });

    prev = ms;
  }

  if (hourEnd - prev > GAP_THRESHOLD_MS) spans.push({ start: prev, end: hourEnd });

  return spans;
}

/** Append `event` items for every proxy row that falls inside a gap. */
function pushEvents(
  items:  StreamItem[],
  source: EventSource,
  rows:   EventRow[],
  inGap:  (ms: number) => boolean,
): void {
  for (const row of rows) {
    const ms = toMs(row.timestamp);

    if (inGap(ms)) items.push({ kind: 'event', ms, source, row });
  }
}

function priorityOf(item: StreamItem): number {
  return PRIORITY[item.kind === 'event' ? item.source : item.kind]!;
}

function compareItems(a: StreamItem, b: StreamItem): number {
  if (a.ms !== b.ms) return a.ms - b.ms;

  const pa = priorityOf(a);
  const pb = priorityOf(b);

  if (pa !== pb) return pa - pb;

  if (a.kind === 'real'    && b.kind === 'real')    return a.doc._id - b.doc._id;
  if (a.kind === 'event'   && b.kind === 'event')   return a.row._id - b.row._id;
  if (a.kind === 'rolling' && b.kind === 'rolling') return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;

  return 0;
}

function sortByTime(buckets: HourBuckets): void {
  buckets.instrument.sort(byTime);
  buckets.compositeIndex.sort(byTime);
  buckets.tick.sort(byTime);
  buckets.quote.sort(byTime);
  buckets.trade.sort(byTime);
  buckets.funding.sort(byTime);
  buckets.settlement.sort(byTime);
}

/**
 * Chronological comparator with `_id` tie-break. BitMEX timestamps are
 * fixed-width ISO-8601 UTC strings, so lexicographic order is chronological —
 * compared directly to keep the hot sort free of per-comparison allocations.
 */
function byTime(a: { timestamp: string; _id: number }, b: { timestamp: string; _id: number }): number {
  return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a._id - b._id;
}

/** First `:15`-past-the-minute cron mark at or after `ms`. */
function firstCron(ms: number): number {
  return Math.ceil((ms - CRON_OFFSET_MS) / CRON_PERIOD_MS) * CRON_PERIOD_MS + CRON_OFFSET_MS;
}

/** Truncate a BitMEX timestamp string to millisecond precision. */
function toMs(ts: string): number {
  return new Date(`${ts.slice(0, 23)}Z`).getTime();
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/* ── Test-only exports ──────────────────────────────────────────────────────── */

export const _test_gapSpans = gapSpans;

function addDay(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);

  d.setUTCDate(d.getUTCDate() + 1);

  return d.toISOString().slice(0, 10);
}
