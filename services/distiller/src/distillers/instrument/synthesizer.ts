import { isReferenceSymbol } from './accumulator';
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
/*  Mark-method families                                               */
/* ------------------------------------------------------------------ */

/**
 * `markMethod` families (see `docs/BitMEX/FAIR_PRICE_MARKING.md`). Two families
 * drive where `markPrice` comes from in a gap:
 *
 * - **fair** — marked off the index (`markPrice = index + fairBasis`). `FairPrice`,
 *   and the fallback for index-marked methods we don't reproduce exactly
 *   (`IndicativeSettlePrice`, `FairPriceStox`) and for an unknown method.
 * - **last** — marked off the instrument's own last trade (`markPrice = lastPrice`).
 *   `LastPrice`/`LastPricePreLaunch` (exact), and the fallback for `LastPriceAdjusted`
 *   (needs a Yield Index we don't collect) and `LastPriceProtected` (its
 *   maintenance-margin band + ratchet are not reproduced — best-effort `lastPrice`).
 */
const LAST_PRICE_METHODS = new Set(['LastPrice', 'LastPricePreLaunch', 'LastPriceAdjusted', 'LastPriceProtected']);

/** Methods reproduced exactly by their own formula — anything else is a fallback. */
const EXACT_METHODS = new Set(['FairPrice', 'LastPrice', 'LastPricePreLaunch']);

/** The marking family for `markMethod` — `last` for the LastPrice family, else `fair`. */
export function markFamily(markMethod: string | undefined): 'fair' | 'last' {
  return markMethod !== undefined && LAST_PRICE_METHODS.has(markMethod) ? 'last' : 'fair';
}

/**
 * Whether `markMethod` is handled by a same-family fallback rather than reproduced
 * exactly — so the caller can record it (auditable, never silently approximated).
 * An absent method defaults to `fair` (the dominant behaviour) and is not flagged.
 */
export function isMarkFallback(markMethod: string | undefined): boolean {
  return markMethod !== undefined && markMethod !== '' && ! EXACT_METHODS.has(markMethod);
}

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

  // Last-price-marked instruments mark off their own last trade — the index fan-out
  // leaves their `markPrice` alone, so set it here from `lastPrice`. (Exact for
  // `LastPrice`/`LastPricePreLaunch`; best-effort fallback for the rest of the
  // family — see `docs/BitMEX/FAIR_PRICE_MARKING.md`.)
  if (fields.lastPrice !== undefined && markFamily(entry.markMethod) === 'last') {
    setMarkAndLimits(fields, fields.lastPrice);
  }

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
 * Per-symbol fields driven by an index value:
 *
 * - The **index symbol itself** (when it is a known reference series) gets its own
 *   value — `lastPrice` and `markPrice` both equal the index. These reference
 *   deltas are throttled downstream (the Walker's `Conflator`); here the
 *   transform stays pure.
 * - **Every trading instrument referencing the index** gets the fan-out: the index
 *   is `indicativeSettlePrice`; `markPrice` is the Fair Price (index + the symbol's
 *   last-known `fairBasis`, carried from the accumulator); limit bands ride on it.
 */
function indexUpdate(
  indexSymbol: string,
  index:       number,
  acc:         Accumulator,
): Map<string, Partial<InstrumentItem>> {
  const result = new Map<string, Partial<InstrumentItem>>();

  if (isReferenceSymbol(indexSymbol) && acc.knownSymbols.has(indexSymbol) && ! acc.settled.has(indexSymbol)) {
    result.set(indexSymbol, { lastPrice: index, markPrice: index });
  }

  for (const sym of acc.refMap.get(indexSymbol) ?? []) {
    if (acc.settled.has(sym)) continue;

    const entry  = acc.symCache.get(sym);
    const fields: Partial<InstrumentItem> = { indicativeSettlePrice: index };

    // Fair/index-marked symbols mark off the index. Last-price-marked symbols mark
    // off their own trades, so their `markPrice` comes from the trade/rolling path
    // (`deriveFields`) and is left untouched by the index fan-out.
    if (markFamily(entry?.markMethod) === 'fair') {
      setMarkAndLimits(fields, index + (entry?.fairBasis ?? 0));
    }

    result.set(sym, fields);
  }

  return result;
}

/** Set `markPrice` and the limit bands that ride on it (×1.10 / ×0.90) — the single
 *  place those band factors are defined, used by both the fair and last paths. */
function setMarkAndLimits(fields: Partial<InstrumentItem>, mark: number): void {
  fields.markPrice     = mark;
  fields.limitUpPrice  = mark * 1.10;
  fields.limitDownPrice = mark * 0.90;
}

/** Round `value` to the nearest multiple of `tick`, division-based to avoid drift. */
function roundToTick(value: number, tick: number): number {
  return Math.round(value / tick) * tick;
}
