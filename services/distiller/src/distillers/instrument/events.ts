import type { Db } from 'mongodb';
import { BitmexTable }                        from '@devvir/bitmex-database';
import type { BitmexMessage, TableTypeMap }   from '@devvir/bitmex-database';
import { logger }                             from '@devvir/service-kit';

import type { InstrumentItem, InstrumentMsg, CompositeIndexRow } from '../../types';
import type {
  InstrumentRunState,
  InstrumentSource,
  InstrumentSymCacheEntry,
  InstrumentTaggedEvent,
} from '../types';

import { getFirstSeedForSymbol } from './seeds';
import { createRolling, addTrade, computeMinuteBlock } from './rolling';
import { makeId, toMs }            from './ids';

type QuoteDoc      = TableTypeMap[BitmexTable.Quote]      & { _id: number };
type TradeDoc      = TableTypeMap[BitmexTable.Trade]      & { _id: number };
type FundingDoc    = TableTypeMap[BitmexTable.Funding]    & { _id: number };
type SettlementDoc = TableTypeMap[BitmexTable.Settlement] & { _id: number };

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Fetch all vault events for a single UTC day across all five sources, tag
 * each with its source, and return the combined list sorted by
 * `(ms, source priority, _id)`.
 */
export async function fetchDayEvents(
  db:       Db,
  dayStart: string,
  dayEnd:   string,
): Promise<InstrumentTaggedEvent[]> {
  const tsFilter = { timestamp: { $gte: dayStart, $lt: dayEnd } };

  const [ciDocs, quoteDocs, tradeDocs, fundingDocs, settleDocs] = await Promise.all([
    db.collection<CompositeIndexRow>('compositeIndex')
      .find({ ...tsFilter, reference: 'BMI', weight: null })
      .toArray(),
    db.collection<QuoteDoc>('quote')
      .find(tsFilter)
      .toArray(),
    db.collection<TradeDoc>('trade')
      .find(tsFilter)
      .toArray(),
    db.collection<FundingDoc>('funding')
      .find(tsFilter)
      .toArray(),
    db.collection<SettlementDoc>('settlement')
      .find(tsFilter)
      .toArray(),
  ]);

  const events: InstrumentTaggedEvent[] = [
    ...ciDocs     .map(row => ({ source: 'compositeIndex' as const, ms: toMs(row.timestamp), _id: row._id, row })),
    ...quoteDocs  .map(row => ({ source: 'quote'          as const, ms: toMs(row.timestamp), _id: row._id, row })),
    ...tradeDocs  .map(row => ({ source: 'trade'          as const, ms: toMs(row.timestamp), _id: row._id, row })),
    ...fundingDocs.map(row => ({ source: 'funding'        as const, ms: toMs(row.timestamp), _id: row._id, row })),
    ...settleDocs .map(row => ({ source: 'settlement'     as const, ms: toMs(row.timestamp), _id: row._id, row })),
  ];

  return events.sort(compareEvents);
}

/**
 * Stream generated insert/update documents for a single day, in write order.
 * Mutates `state` — applies to the in-memory accumulator, updates rolling
 * state, grows `knownSymbols`, flags symbols that cannot be enriched from
 * Tardis into `deadSymbols`.
 *
 * Real events are merged per millisecond: all same-ms events contribute to a
 * single per-symbol document. Derived fields (`lastPriceProtected`, `midPrice`)
 * are computed after the merge using the latest per-symbol cache.
 *
 * A symbol seen for the first time triggers an `insert` enriched with the
 * earliest Tardis snapshot fields on or after the current day. A symbol
 * already in the accumulator triggers a plain `update`. Dead symbols (no
 * Tardis record anywhere from the current day forward) are skipped silently
 * after a single warning.
 *
 * Interleaved with the real events, a synthetic minute-cron tick fires at
 * `HH:MM:15.000` of every UTC minute and emits one `update` per tracked
 * symbol carrying the 24h stats block, matching real BitMEX cadence. The
 * next expected cron ms carries across days via `state.lastCronMs`.
 *
 * `msgIndexStart` is the first in-day msgIndex to use (1 when the partial
 * occupies msgIndex 0). Returns the next free msgIndex so the caller can
 * detect whether any docs were produced.
 */
export function* processDayEvents(
  state:         InstrumentRunState,
  currentDay:    string,
  events:        InstrumentTaggedEvent[],
  msgIndexStart: number = 1,
): Generator<InstrumentMsg, number, void> {
  const dayStartMs = Date.parse(`${currentDay}T00:00:00.000Z`);
  const dayEndMs   = dayStartMs + 86_400_000;

  let msgIndex   = msgIndexStart;
  let ei         = 0;
  let nextCronMs = state.lastCronMs !== undefined
    ? state.lastCronMs + CRON_PERIOD_MS
    : dayStartMs + CRON_OFFSET_MS;

  if (nextCronMs < dayStartMs + CRON_OFFSET_MS)
    nextCronMs = dayStartMs + CRON_OFFSET_MS;

  while (ei < events.length || nextCronMs < dayEndMs) {
    const eventMs = ei < events.length ? events[ei]!.ms : Infinity;

    while (nextCronMs < dayEndMs && nextCronMs <= eventMs) {
      yield* emitCronTick(state, nextCronMs, () => makeId(currentDay, msgIndex++));
      state.lastCronMs = nextCronMs;
      nextCronMs      += CRON_PERIOD_MS;
    }

    if (ei >= events.length) break;

    const ms    = eventMs;
    const batch: InstrumentTaggedEvent[] = [];

    while (ei < events.length && events[ei]!.ms === ms) {
      batch.push(events[ei]!);
      ei++;
    }

    const bySymbol = mergeBatchBySymbol(batch, state);

    for (const [sym, fields] of bySymbol) {
      if (state.deadSymbols.has(sym)) continue;

      applySymCache(state, sym, fields);

      const isNew  = ! state.knownSymbols.has(sym);
      const merged = isNew ? enrichForInsert(sym, fields, currentDay, state) : fields;

      if (! merged) continue;  // dead symbol

      const action: 'insert' | 'update' = isNew ? 'insert' : 'update';

      if (isNew) state.knownSymbols.add(sym);

      applyToAccumulator(state, action, sym, merged);

      const tsString = new Date(ms).toISOString();

      yield {
        _id:    makeId(currentDay, msgIndex++),
        action,
        data:   [{ ...merged, symbol: sym, timestamp: tsString }],
      };
    }
  }

  return msgIndex;
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

/** BitMEX emits the 24h stats block every minute at :15 past the minute. */
const CRON_PERIOD_MS = 60_000;
const CRON_OFFSET_MS = 15_000;

const SOURCE_PRIORITY: Record<InstrumentSource, number> = {
  compositeIndex: 0,
  quote:          1,
  trade:          2,
  funding:        3,
  settlement:     4,
};

/**
 * Emit one `update` per tracked symbol carrying the 24h stats block at
 * the given minute-cron tick. Dead/settled symbols and symbols not yet
 * inserted into the accumulator are skipped.
 */
function* emitCronTick(
  state:  InstrumentRunState,
  ms:     number,
  nextId: () => number,
): Generator<InstrumentMsg, void, void> {
  const tsString = new Date(ms).toISOString();

  for (const [sym, rolling] of state.rolling) {
    if (state.settled.has(sym))        continue;
    if (state.deadSymbols.has(sym))    continue;
    if (! state.knownSymbols.has(sym)) continue;

    const block = computeMinuteBlock(rolling, ms);

    applyToAccumulator(state, 'update', sym, block);

    yield {
      _id:    nextId(),
      action: 'update',
      data:   [{ ...block, symbol: sym, timestamp: tsString }],
    };
  }
}

function compareEvents(a: InstrumentTaggedEvent, b: InstrumentTaggedEvent): number {
  if (a.ms !== b.ms) return a.ms - b.ms;

  const pa = SOURCE_PRIORITY[a.source];
  const pb = SOURCE_PRIORITY[b.source];

  if (pa !== pb) return pa - pb;

  return a._id - b._id;
}

/** Merge all events at the same ms into per-symbol field updates. */
function mergeBatchBySymbol(
  batch: InstrumentTaggedEvent[],
  state: InstrumentRunState,
): Map<string, Partial<InstrumentItem>> {
  const bySymbol = new Map<string, Partial<InstrumentItem>>();

  for (const event of batch) {
    const updates = computeEventUpdates(event, state);

    for (const [sym, fields] of updates) {
      const existing = bySymbol.get(sym);

      bySymbol.set(sym, existing ? { ...existing, ...fields } : { ...fields });
    }
  }

  return bySymbol;
}

/** Compute the per-symbol field updates produced by a single tagged event. */
function computeEventUpdates(
  event: InstrumentTaggedEvent,
  state: InstrumentRunState,
): Map<string, Partial<InstrumentItem>> {
  const result = new Map<string, Partial<InstrumentItem>>();

  if (event.source === 'compositeIndex') {
    const markPrice = parseFloat(event.row.lastPrice);

    if (isNaN(markPrice)) return result;

    const symbols = state.refMap.get(event.row.symbol) ?? [];

    for (const sym of symbols) {
      if (state.settled.has(sym)) continue;

      result.set(sym, {
        markPrice,
        limitUpPrice:   markPrice * 1.10,
        limitDownPrice: markPrice * 0.90,
      });
    }

    return result;
  }

  if (event.source === 'quote') {
    const { symbol } = event.row;

    if (! symbol || state.settled.has(symbol)) return result;

    const fields: Partial<InstrumentItem> = {};

    if (event.row.bidPrice !== undefined) fields.bidPrice = event.row.bidPrice;
    if (event.row.askPrice !== undefined) fields.askPrice = event.row.askPrice;

    if (Object.keys(fields).length > 0) result.set(symbol, fields);

    return result;
  }

  if (event.source === 'trade') {
    const { symbol, size, price } = event.row;

    if (! symbol || state.settled.has(symbol))      return result;
    if (size === undefined || price === undefined) return result;

    let rolling = state.rolling.get(symbol);

    if (! rolling) {
      rolling = createRolling();
      state.rolling.set(symbol, rolling);
    }

    const fields = addTrade(
      rolling,
      event.ms,
      size,
      price,
      event.row.grossValue      ?? 0,
      event.row.homeNotional    ?? 0,
      event.row.foreignNotional ?? 0,
      event.row.tickDirection   ?? '',
    );

    result.set(symbol, fields);

    return result;
  }

  if (event.source === 'funding') {
    const { symbol } = event.row;

    if (! symbol || state.settled.has(symbol)) return result;

    const fields: Partial<InstrumentItem> = { fundingTimestamp: event.row.timestamp };

    if (event.row.fundingRate     !== undefined) fields.fundingRate     = event.row.fundingRate;
    if (event.row.fundingInterval !== undefined) fields.fundingInterval = event.row.fundingInterval;

    result.set(symbol, fields);

    return result;
  }

  // settlement
  const { symbol } = event.row;

  if (! symbol) return result;

  state.settled.add(symbol);

  const fields: Partial<InstrumentItem> = { state: 'Settled' };

  if (event.row.settledPrice !== undefined) fields.settledPrice = event.row.settledPrice;

  result.set(symbol, fields);

  return result;
}

/**
 * Update the symbol cache with any fresh price fields, and recompute derived
 * fields (`lastPriceProtected`, `midPrice`) in-place on `fields` whenever the
 * triggering inputs are now known.
 */
function applySymCache(
  state:  InstrumentRunState,
  sym:    string,
  fields: Partial<InstrumentItem>,
): void {
  const entry: InstrumentSymCacheEntry = state.symCache.get(sym) ?? {};

  if (fields.lastPrice !== undefined) entry.lastPrice = fields.lastPrice;
  if (fields.markPrice !== undefined) entry.markPrice = fields.markPrice;
  if (fields.bidPrice  !== undefined) entry.bidPrice  = fields.bidPrice;
  if (fields.askPrice  !== undefined) entry.askPrice  = fields.askPrice;
  if (fields.tickSize  !== undefined) entry.tickSize  = fields.tickSize;

  state.symCache.set(sym, entry);

  if (fields.markPrice !== undefined || fields.lastPrice !== undefined) {
    const mp = entry.markPrice;
    const lp = entry.lastPrice;

    if (mp !== undefined && lp !== undefined) {
      fields.lastPriceProtected = Math.min(Math.max(lp, mp * 0.9995), mp * 1.0005);
    }
  }

  if (fields.bidPrice !== undefined || fields.askPrice !== undefined) {
    const bid = entry.bidPrice;
    const ask = entry.askPrice;

    if (bid !== undefined && ask !== undefined) {
      const raw = (bid + ask) / 2;

      fields.midPrice = entry.tickSize !== undefined
        ? roundToTick(raw, entry.tickSize / 2)
        : raw;
    }
  }
}

/**
 * Build the insert payload for a newly-seen symbol: overlay vault fields on
 * top of the semi-static Tardis fields from the earliest future snapshot.
 * Returns `null` (and flags the symbol as dead) when no Tardis record exists
 * from the current day forward.
 */
function enrichForInsert(
  sym:        string,
  fields:     Partial<InstrumentItem>,
  currentDay: string,
  state:      InstrumentRunState,
): Partial<InstrumentItem> | null {
  const tardisFields = getFirstSeedForSymbol(sym, currentDay);

  if (! tardisFields) {
    state.deadSymbols.add(sym);
    logger.warn(
      { symbol: sym, day: currentDay },
      'instrument: no Tardis data for new symbol — skipping future events for this symbol',
    );

    return null;
  }

  // Vault fields override Tardis where they overlap — vault is current, Tardis is anchor.
  return { ...tardisFields, ...fields };
}

/**
 * Round `value` to the nearest multiple of `tick`.
 * Uses division-based rounding to avoid float drift accumulation.
 */
function roundToTick(value: number, tick: number): number {
  return Math.round(value / tick) * tick;
}

/** Apply the insert/update message to the in-memory accumulator table. */
function applyToAccumulator(
  state:  InstrumentRunState,
  action: 'insert' | 'update',
  sym:    string,
  fields: Partial<InstrumentItem>,
): void {
  const data = [{ ...fields, symbol: sym }];

  const msg: BitmexMessage<InstrumentItem> = action === 'insert'
    ? { table: BitmexTable.Instrument, action: 'insert', data: data as InstrumentItem[] }
    : { table: BitmexTable.Instrument, action: 'update', data };

  state.table.apply(msg);
}
