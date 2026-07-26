import { describe, it, expect } from 'vitest';

import {
  createAccumulator, applyMessage, rebuildCaches, isReferenceSymbol,
} from '../../../src/distillers/instrument/accumulator';
import { synthesizeEvent }                          from '../../../src/distillers/instrument/synthesizer';
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

describe('isReferenceSymbol', () => {
  it('flags only leading-dot symbols', () => {
    expect(isReferenceSymbol('.BXBT')).toBe(true);
    expect(isReferenceSymbol('.BVOL24H')).toBe(true);
    expect(isReferenceSymbol('XBTUSD')).toBe(false);
    expect(isReferenceSymbol(undefined)).toBe(false);
  });
});

describe('reference symbols are not fan-out targets', () => {
  /** A contract and a reference series both reference the same base index. */
  const acc = seed([
    { symbol: 'XBTUSD',   referenceSymbol: '.BXBT', lastPrice: 9500, fairBasis: 5, tickSize: 0.5 },
    { symbol: '.EVOL7D',  referenceSymbol: '.BXBT' },
  ]);

  it('keeps reference symbols out of refMap fan-out targets, but in knownSymbols', () => {
    expect(acc.refMap.get('.BXBT')).toEqual(['XBTUSD']);
    expect(acc.knownSymbols.has('.EVOL7D')).toBe(true);
    expect(acc.knownSymbols.has('XBTUSD')).toBe(true);
  });

  it('fans an index tick out to contracts — not to other reference series', () => {
    // `.BXBT` is not a known symbol here, so it gets no self-emission; `.EVOL7D`
    // references `.BXBT` but is a reference series, so it is not a fan-out target.
    const out = synthesizeEvent('tick', tick('.BXBT', 9600), acc);

    expect([...out.keys()]).toEqual(['XBTUSD']);
    expect(out.get('XBTUSD')).toMatchObject({ indicativeSettlePrice: 9600 });
  });
});

describe('the index symbol gets its own reference delta when it is known', () => {
  const acc = seed([
    { symbol: 'XBTUSD', referenceSymbol: '.BXBT', lastPrice: 9500, fairBasis: 5 },
    { symbol: '.BXBT',  referenceSymbol: '.BXBT' },   // the index series itself, listed
  ]);

  it('emits the index value as the reference symbol’s own lastPrice/markPrice', () => {
    const out = synthesizeEvent('tick', tick('.BXBT', 9600), acc);

    expect(out.get('.BXBT')).toEqual({ lastPrice: 9600, markPrice: 9600 });
    expect(out.get('XBTUSD')).toMatchObject({ indicativeSettlePrice: 9600 });
  });
});
