import { BitmexTable, createTable } from '@devvir/bitmex-database';
import type { BitmexMessage }       from '@devvir/bitmex-database';

import type { Accumulator, InstrumentItem, InstrumentMsg, InstrumentSymCacheEntry } from './types';

/**
 * Create an empty accumulator. The table is unseeded — apply a `partial` (an
 * anchor, or the first real partial in the source stream) before reading it.
 */
export function createAccumulator(): Accumulator {
  return {
    table:        createTable(BitmexTable.Instrument),
    refMap:       new Map(),
    knownSymbols: new Set(),
    symCache:     new Map(),
    settled:      new Set(),
  };
}

/** Apply a stored instrument document — partial or delta — to the accumulator. */
export function applyMessage(acc: Accumulator, doc: InstrumentMsg): void {
  const message = doc.action === 'partial'
    ? { table: BitmexTable.Instrument, action: 'partial', keys: doc.keys, types: doc.types, filter: doc.filter, data: doc.data }
    : { table: BitmexTable.Instrument, action: doc.action, data: doc.data };

  acc.table.apply(message as unknown as BitmexMessage<InstrumentItem>);
}

/** Apply a synthetic single-symbol `update` to the accumulator. */
export function applyUpdate(acc: Accumulator, symbol: string, fields: Partial<InstrumentItem>): void {
  acc.table.apply({
    table:  BitmexTable.Instrument,
    action: 'update',
    data:   [{ ...fields, symbol }],
  });
}

/**
 * Snapshot every active instrument — the `data` of an unfiltered `partial`.
 */
export function snapshot(acc: Accumulator): Partial<InstrumentItem>[] {
  return acc.table.snapshot();
}

/**
 * Rebuild the table-derived caches — `refMap`, `knownSymbols`, `symCache`,
 * `settled` — from the current accumulator snapshot. Called at the start of an
 * hour so synthesis reads state current as of the hour boundary; `symCache`
 * then evolves through the hour as proxy events arrive.
 */
export function rebuildCaches(acc: Accumulator): void {
  const refMap       = new Map<string, string[]>();
  const knownSymbols = new Set<string>();
  const symCache     = new Map<string, InstrumentSymCacheEntry>();
  const settled      = new Set<string>();

  for (const item of acc.table.snapshot()) {
    const sym = item.symbol;

    if (! sym) continue;

    knownSymbols.add(sym);

    if (item.state === 'Settled') settled.add(sym);

    // A reference (`.`-prefixed) series is not a trading instrument, so it is never
    // a fan-out target: an index value maps to the *trading* symbols that reference
    // it, not to other index series. (The index symbol's own value is synthesized
    // separately and throttled — see the Synthesizer and `Conflator`.)
    if (item.referenceSymbol && ! isReferenceSymbol(sym)) {
      const peers = refMap.get(item.referenceSymbol);

      if (peers) {
        peers.push(sym);
      } else {
        refMap.set(item.referenceSymbol, [sym]);
      }
    }

    const entry: InstrumentSymCacheEntry = {};

    if (item.lastPrice  !== undefined) entry.lastPrice  = item.lastPrice;
    if (item.markPrice  !== undefined) entry.markPrice  = item.markPrice;
    if (item.bidPrice   !== undefined) entry.bidPrice   = item.bidPrice;
    if (item.askPrice   !== undefined) entry.askPrice   = item.askPrice;
    if (item.tickSize   !== undefined) entry.tickSize   = item.tickSize;
    if (item.fairBasis  !== undefined) entry.fairBasis  = item.fairBasis;
    if (item.markMethod !== undefined) entry.markMethod = item.markMethod;

    symCache.set(sym, entry);
  }

  acc.refMap       = refMap;
  acc.knownSymbols = knownSymbols;
  acc.symCache     = symCache;
  acc.settled      = settled;
}

/** Reference/index series (e.g. `.BXBT`, `.BVOL24H`) — carry a leading dot. */
export function isReferenceSymbol(symbol: string | undefined): boolean {
  return typeof symbol === 'string' && symbol.startsWith('.');
}
