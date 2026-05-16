import { readFileSync } from 'node:fs';
import { join }         from 'node:path';

import type { BitmexFieldType } from '@devvir/bitmex-database';

import type { InstrumentItem } from '../../types';

/* ------------------------------------------------------------------ */
/*  Seed file parsing                                                  */
/* ------------------------------------------------------------------ */

interface SeedLine {
  action: 'partial' | 'update' | 'insert' | 'delete';
  date:   string;
  data:   Partial<InstrumentItem>[];
}

const LINES: SeedLine[] = readFileSync(
  join(__dirname, 'instrument-seeds.ndjson'),
  'utf-8',
).trim().split('\n').map(l => JSON.parse(l) as SeedLine);

/* ------------------------------------------------------------------ */
/*  Instrument partial metadata (from live BitMEX WS partial message) */
/* ------------------------------------------------------------------ */

export const INSTRUMENT_KEYS: string[] = ['symbol'];

export const INSTRUMENT_FILTER: Record<string, unknown> = {};

export const INSTRUMENT_TYPES: Record<string, BitmexFieldType> = {
  symbol:                         'symbol',
  rootSymbol:                     'symbol',
  instrumentID:                   'int',
  state:                          'symbol',
  typ:                            'symbol',
  listing:                        'timestamp',
  front:                          'timestamp',
  expiry:                         'timestamp',
  settle:                         'timestamp',
  listedSettle:                   'timestamp',
  relistInterval:                 'timespan',
  positionCurrency:               'symbol',
  underlying:                     'symbol',
  quoteCurrency:                  'symbol',
  underlyingSymbol:               'symbol',
  reference:                      'symbol',
  referenceSymbol:                'symbol',
  calcInterval:                   'timespan',
  publishInterval:                'timespan',
  publishTime:                    'timespan',
  maxOrderQty:                    'long',
  minPrice:                       'float',
  maxPrice:                       'float',
  lotSize:                        'long',
  tickSize:                       'float',
  multiplier:                     'long',
  settlCurrency:                  'symbol',
  underlyingToPositionMultiplier: 'long',
  underlyingToSettleMultiplier:   'long',
  quoteToSettleMultiplier:        'long',
  isQuanto:                       'boolean',
  isInverse:                      'boolean',
  initMargin:                     'float',
  maintMargin:                    'float',
  riskLimit:                      'long',
  riskStep:                       'long',
  limit:                          'float',
  taxed:                          'boolean',
  deleverage:                     'boolean',
  makerFee:                       'float',
  takerFee:                       'float',
  settlementFee:                  'float',
  fundingBaseSymbol:              'symbol',
  fundingQuoteSymbol:             'symbol',
  fundingPremiumSymbol:           'symbol',
  fundingTimestamp:               'timestamp',
  fundingInterval:                'timespan',
  fundingRate:                    'float',
  indicativeFundingRate:          'float',
  rebalanceTimestamp:             'timestamp',
  rebalanceInterval:              'timespan',
  launchingTimestamp:             'timestamp',
  prevClosePrice:                 'float',
  limitDownPrice:                 'float',
  limitUpPrice:                   'float',
  prevTotalVolume:                'long',
  totalVolume:                    'long',
  volume:                         'long',
  volume24h:                      'long',
  prevTotalTurnover:              'long',
  totalTurnover:                  'long',
  turnover:                       'long',
  turnover24h:                    'long',
  homeNotional24h:                'float',
  foreignNotional24h:             'float',
  prevPrice24h:                   'float',
  vwap:                           'float',
  highPrice:                      'float',
  lowPrice:                       'float',
  lastPrice:                      'float',
  lastPriceProtected:             'float',
  lastTickDirection:              'symbol',
  lastChangePcnt:                 'float',
  bidPrice:                       'float',
  midPrice:                       'float',
  askPrice:                       'float',
  impactBidPrice:                 'float',
  impactMidPrice:                 'float',
  impactAskPrice:                 'float',
  hasLiquidity:                   'boolean',
  openInterest:                   'long',
  openValue:                      'long',
  fairMethod:                     'symbol',
  fairBasisRate:                  'float',
  fairBasis:                      'float',
  fairPrice:                      'float',
  markMethod:                     'symbol',
  markPrice:                      'float',
  referencePrice:                 'float',
  indicativeSettlePrice:          'float',
  settledPriceAdjustmentRate:     'float',
  settledPrice:                   'float',
  instantPnl:                     'boolean',
  minTick:                        'float',
  fundingBaseRate:                'float',
  fundingQuoteRate:               'float',
  farLegSymbol:                   'symbol',
  nearLegSymbol:                  'symbol',
  timestamp:                      'timestamp',
};

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Returns the accumulated Tardis seed state for all instruments active as of
 * (and including) the given YYYY-MM-DD date. Used to reset the accumulator on
 * Tardis anchor dates, and to seed it on first-ever run.
 */
export function getSeedState(upToDate: string): Map<string, Partial<InstrumentItem>> {
  const cached = SEED_STATE_CACHE.get(upToDate);

  if (cached) return cached;

  const state = buildSeedState(upToDate);

  SEED_STATE_CACHE.set(upToDate, state);

  return state;
}

/**
 * Returns true if there is a Tardis monthly anchor for the given YYYY-MM-DD date.
 */
export function hasSeedForDate(date: string): boolean {
  return LINES.some(l => l.date === date);
}

/**
 * Returns the semi-static Tardis fields for `symbol`, taken from the earliest
 * Tardis snapshot on or after `fromDate` that includes the symbol.
 *
 * Used to enrich `insert` messages for symbols first seen in vault data but
 * without a prior Tardis record — notably the pre-Tardis-coverage period
 * (Dec 2016 → April 2019) and new symbols listed mid-month thereafter.
 *
 * Returns `null` when no Tardis snapshot from `fromDate` onwards contains the
 * symbol — typically meaning it was delisted before any Tardis coverage,
 * so no reliable enrichment data is available.
 */
export function getFirstSeedForSymbol(
  symbol:   string,
  fromDate: string,
): Partial<InstrumentItem> | null {
  const startIdx = firstSeedDateIdxFrom(fromDate);

  if (startIdx < 0) return null;

  for (let i = startIdx; i < SEED_DATES.length; i++) {
    const state = getSeedState(SEED_DATES[i]!);
    const item  = state.get(symbol);

    if (item) return item;
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

/** Sorted unique Tardis snapshot dates (ascending), for forward lookups. */
const SEED_DATES: string[] = Array.from(new Set(LINES.map(l => l.date))).sort();

/** Memoised accumulated state per date, shared across all callers. */
const SEED_STATE_CACHE = new Map<string, Map<string, Partial<InstrumentItem>>>();

/** Replay all Tardis lines up to `upToDate` into a single accumulated state. */
function buildSeedState(upToDate: string): Map<string, Partial<InstrumentItem>> {
  const state = new Map<string, Partial<InstrumentItem>>();

  for (const line of LINES) {
    if (line.date > upToDate) break;

    if (line.action === 'partial') {
      state.clear();

      for (const item of line.data) {
        if (item.symbol) state.set(item.symbol, { ...item });
      }
    } else if (line.action === 'insert') {
      for (const item of line.data) {
        if (item.symbol) state.set(item.symbol, { ...item });
      }
    } else if (line.action === 'update') {
      for (const item of line.data) {
        if (! item.symbol) continue;

        const existing = state.get(item.symbol);

        state.set(item.symbol, existing ? { ...existing, ...item } : { ...item });
      }
    } else {
      // delete
      for (const item of line.data) {
        if (item.symbol) state.delete(item.symbol);
      }
    }
  }

  return state;
}

/** Index of the first seed date >= `fromDate` (binary search), or -1 if none. */
function firstSeedDateIdxFrom(fromDate: string): number {
  let lo     = 0;
  let hi     = SEED_DATES.length - 1;
  let result = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d   = SEED_DATES[mid]!;

    if (d >= fromDate) {
      result = mid;
      hi     = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  return result;
}
