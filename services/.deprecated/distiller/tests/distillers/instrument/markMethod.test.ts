import { describe, it, expect } from 'vitest';

import { createAccumulator, applyMessage, rebuildCaches } from '../../../src/distillers/instrument/accumulator';
import { synthesizeEvent, deriveFields, markFamily, isMarkFallback } from '../../../src/distillers/instrument/synthesizer';
import { INSTRUMENT_KEYS, INSTRUMENT_TYPES, INSTRUMENT_FILTER } from '../../../src/distillers/instrument/schema';
import type { InstrumentItem, InstrumentMsg, TickRow } from '../../../src/distillers/instrument/types';

/** Seed an accumulator from a one-shot partial, caches rebuilt. */
function seed(data: Partial<InstrumentItem>[]) {
  const acc = createAccumulator();
  const partial: InstrumentMsg = {
    _id: 0, action: 'partial', timestamp: '2020-01-01T00:00:00.000Z',
    keys: INSTRUMENT_KEYS, types: INSTRUMENT_TYPES, filter: INSTRUMENT_FILTER, data,
  };

  applyMessage(acc, partial);
  rebuildCaches(acc);

  return acc;
}

const tick = (symbol: string, price: number): TickRow =>
  ({ _id: 1, timestamp: '2020-01-01T00:30:00.000Z', symbol, price, tickDirection: 'PlusTick' });

describe('markFamily', () => {
  it('maps the LastPrice family to `last`, everything else to `fair`', () => {
    for (const m of ['LastPrice', 'LastPricePreLaunch', 'LastPriceAdjusted', 'LastPriceProtected']) {
      expect(markFamily(m)).toBe('last');
    }

    for (const m of ['FairPrice', 'FairPriceStox', 'IndicativeSettlePrice', '', undefined]) {
      expect(markFamily(m)).toBe('fair');
    }
  });
});

describe('isMarkFallback', () => {
  it('flags only methods not reproduced exactly', () => {
    for (const m of ['FairPrice', 'LastPrice', 'LastPricePreLaunch', '', undefined]) {
      expect(isMarkFallback(m)).toBe(false);
    }

    for (const m of ['LastPriceAdjusted', 'LastPriceProtected', 'FairPriceStox', 'IndicativeSettlePrice']) {
      expect(isMarkFallback(m)).toBe(true);
    }
  });
});

describe('markPrice by markMethod', () => {
  const acc = seed([
    { symbol: 'FAIRP', referenceSymbol: '.BXBT', markMethod: 'FairPrice', fairBasis: 5 },
    { symbol: 'LASTP', referenceSymbol: '.BXBT', markMethod: 'LastPrice' },
  ]);

  it('index fan-out marks Fair off the index (index + fairBasis) but leaves LastPrice untouched', () => {
    const out = synthesizeEvent('tick', tick('.BXBT', 9600), acc);

    // Fair: marked off the index.
    expect(out.get('FAIRP')).toMatchObject({ indicativeSettlePrice: 9600, markPrice: 9605 });

    // LastPrice: gets the index value, but NO markPrice from the fan-out.
    expect(out.get('LASTP')).toEqual({ indicativeSettlePrice: 9600 });
    expect(out.get('LASTP')!.markPrice).toBeUndefined();
  });

  it('the trade path marks LastPrice off its own lastPrice, and never touches Fair', () => {
    const lastFields: Partial<InstrumentItem> = { lastPrice: 9500 };
    deriveFields(acc, 'LASTP', lastFields);
    expect(lastFields.markPrice).toBe(9500);   // last-price-marked → markPrice = lastPrice

    const fairFields: Partial<InstrumentItem> = { lastPrice: 9500 };
    deriveFields(acc, 'FAIRP', fairFields);
    expect(fairFields.markPrice).toBeUndefined();   // fair-marked mark comes from the index, not trades
  });
});
