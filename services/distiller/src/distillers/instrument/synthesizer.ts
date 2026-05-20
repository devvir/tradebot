import type {
  Accumulator,
  CompositeIndexRow,
  EventRow,
  EventSource,
  InstrumentItem,
  InstrumentSymCacheEntry,
  TickRow,
} from './types';

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Transform one raw proxy row into per-symbol instrument field updates, against
 * the current accumulator. A pure, deterministic function: same row and state
 * always yield the same result.
 *
 * `compositeIndex` and `tick` both carry the index value and fan out across
 * every instrument referencing the index; `quote` / `funding` / `settlement`
 * map to a single symbol. A row for an unknown or settled symbol yields nothing.
 */
export function synthesizeEvent(
  source: EventSource,
  row:    EventRow,
  acc:    Accumulator,
): Map<string, Partial<InstrumentItem>> {
  const result = new Map<string, Partial<InstrumentItem>>();

  if (source === 'compositeIndex') {
    const ci = row as CompositeIndexRow;

    // Only the BMI aggregate is the index value. Constituent rows carry an
    // exchange name in `reference`; `reference` alone is the discriminator.
    if (ci.reference !== 'BMI') return result;

    const index = parseFloat(ci.lastPrice);

    return isNaN(index) ? result : indexUpdate(ci.symbol, index, acc);
  }

  if (source === 'tick') {
    const t = row as TickRow;

    // A referential index tick — the index value, used for an hour where
    // compositeIndex has no data (the Provider picks one source or the other).
    return typeof t.price === 'number' && ! isNaN(t.price)
      ? indexUpdate(t.symbol, t.price, acc)
      : result;
  }

  if (source === 'quote') {
    const q = row as { symbol?: string; bidPrice?: number; askPrice?: number };

    if (! q.symbol || acc.settled.has(q.symbol)) return result;

    const fields: Partial<InstrumentItem> = {};

    if (q.bidPrice !== undefined) fields.bidPrice = q.bidPrice;
    if (q.askPrice !== undefined) fields.askPrice = q.askPrice;

    if (Object.keys(fields).length > 0) result.set(q.symbol, fields);

    return result;
  }

  if (source === 'funding') {
    const f = row as { symbol?: string; timestamp: string; fundingRate?: number; fundingInterval?: string };

    if (! f.symbol || acc.settled.has(f.symbol)) return result;

    const fields: Partial<InstrumentItem> = { fundingTimestamp: f.timestamp };

    if (f.fundingRate     !== undefined) fields.fundingRate     = f.fundingRate;
    if (f.fundingInterval !== undefined) fields.fundingInterval = f.fundingInterval;

    result.set(f.symbol, fields);

    return result;
  }

  // settlement
  const s = row as { symbol?: string; settledPrice?: number };

  if (! s.symbol) return result;

  acc.settled.add(s.symbol);

  const fields: Partial<InstrumentItem> = { state: 'Settled' };

  if (s.settledPrice !== undefined) fields.settledPrice = s.settledPrice;

  result.set(s.symbol, fields);

  return result;
}

/**
 * Update the symbol cache with any fresh price fields, and fill the cross-source
 * derived fields (`lastPriceProtected`, `midPrice`) in place on `fields`
 * whenever the triggering inputs are now known. Mutates `acc.symCache`.
 */
export function deriveFields(
  acc:    Accumulator,
  sym:    string,
  fields: Partial<InstrumentItem>,
): void {
  const entry: InstrumentSymCacheEntry = acc.symCache.get(sym) ?? {};

  if (fields.lastPrice !== undefined) entry.lastPrice = fields.lastPrice;
  if (fields.markPrice !== undefined) entry.markPrice = fields.markPrice;
  if (fields.bidPrice  !== undefined) entry.bidPrice  = fields.bidPrice;
  if (fields.askPrice  !== undefined) entry.askPrice  = fields.askPrice;
  if (fields.tickSize  !== undefined) entry.tickSize  = fields.tickSize;

  acc.symCache.set(sym, entry);

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

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

/**
 * Per-symbol fields for every instrument referencing `indexSymbol`, from the
 * index value. The index value is `indicativeSettlePrice`; `markPrice` is the
 * Fair Price — the index plus the symbol's last-known `fairBasis`, carried from
 * the accumulator (near-constant within a gap). Limit bands ride on `markPrice`.
 */
function indexUpdate(
  indexSymbol: string,
  index:       number,
  acc:         Accumulator,
): Map<string, Partial<InstrumentItem>> {
  const result = new Map<string, Partial<InstrumentItem>>();

  for (const sym of acc.refMap.get(indexSymbol) ?? []) {
    if (acc.settled.has(sym)) continue;

    const markPrice = index + (acc.symCache.get(sym)?.fairBasis ?? 0);

    result.set(sym, {
      indicativeSettlePrice: index,
      markPrice,
      limitUpPrice:          markPrice * 1.10,
      limitDownPrice:        markPrice * 0.90,
    });
  }

  return result;
}

/** Round `value` to the nearest multiple of `tick`, division-based to avoid drift. */
function roundToTick(value: number, tick: number): number {
  return Math.round(value / tick) * tick;
}
