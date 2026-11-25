import { describe, it, expect } from 'vitest';
import { fmtPrice, priceDecimals, quoteCurrency } from '../../src/utils/format';

describe('quoteCurrency', () => {
  it('reads the quote currency off the end of the symbol', () => {
    expect(quoteCurrency('XBTUSD')).toBe('USD');
    expect(quoteCurrency('ETHUSDT')).toBe('USDT');
    expect(quoteCurrency('ETHXBT')).toBe('XBT');
    expect(quoteCurrency('XBTEUR')).toBe('EUR');
  });
});

describe('fmtPrice', () => {
  it('prints exactly the requested decimals with thousands separators', () => {
    expect(fmtPrice(0.5123, 4)).toBe('0.5123');
    expect(fmtPrice(68_940, 1)).toBe('68,940.0');
    expect(fmtPrice(68_940.25, 0)).toBe('68,940');
  });
});

describe('priceDecimals', () => {
  it('is the most fraction digits any value needs', () => {
    expect(priceDecimals([0.5123])).toBe(4);
    expect(priceDecimals([68_940, 68_940.5])).toBe(1);
    expect(priceDecimals([68_940, 68_941])).toBe(0);
    expect(priceDecimals([1.25, 0.001])).toBe(3);
  });

  it('ignores floating-point noise', () => {
    expect(priceDecimals([0.1 + 0.2])).toBe(1);
    expect(priceDecimals([68_941.1 + 0.2])).toBe(1);
  });

  it('keeps very small prices significant, up to eight decimals', () => {
    expect(priceDecimals([1e-7])).toBe(7);
    expect(priceDecimals([1e-10])).toBe(8);
  });

  it('is 0 for no values, zero, or only non-finite values', () => {
    expect(priceDecimals([])).toBe(0);
    expect(priceDecimals([0])).toBe(0);
    expect(priceDecimals([NaN, Infinity])).toBe(0);
    expect(priceDecimals([NaN, 1.25])).toBe(2);
  });
});
