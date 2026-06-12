import { describe, it, expect } from 'vitest';

import { merge } from '../../../src/distillers/instrument/merger';

describe('merge — per-symbol field combination', () => {
  it('keeps distinct symbols separate', () => {
    const out = merge([
      ['XBTUSD', { bidPrice: 100 }],
      ['ETHUSD', { bidPrice: 50 }],
    ]);

    expect(out.get('XBTUSD')).toEqual({ bidPrice: 100 });
    expect(out.get('ETHUSD')).toEqual({ bidPrice: 50 });
  });

  it('combines different fields of one symbol into a single delta', () => {
    const out = merge([
      ['XBTUSD', { bidPrice: 100 }],
      ['XBTUSD', { lastPrice: 99 }],
    ]);

    expect(out.get('XBTUSD')).toEqual({ bidPrice: 100, lastPrice: 99 });
  });

  it('last write wins when two contributions set the same field', () => {
    const out = merge([
      ['XBTUSD', { bidPrice: 100 }],
      ['XBTUSD', { bidPrice: 101 }],
    ]);

    expect(out.get('XBTUSD')).toEqual({ bidPrice: 101 });
  });

  it('returns an empty map for no contributions', () => {
    expect(merge([]).size).toBe(0);
  });

  it('does not mutate the input field objects', () => {
    const a = { bidPrice: 100 };
    const out = merge([['XBTUSD', a]]);

    out.get('XBTUSD')!.askPrice = 102;

    expect(a).toEqual({ bidPrice: 100 });
  });
});
