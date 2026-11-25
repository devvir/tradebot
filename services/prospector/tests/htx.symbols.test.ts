import { describe, expect, it } from 'vitest';
import { dashed } from '../src/adapters/htx/symbols';

/** The 27 currencies `data/` quotes a spot pair in, as `docs/venues/HTX.md` lists them. */
const QUOTED_IN = [
  'USDT', 'BTC', 'ETH', 'KRW', 'HT', 'HUSD', 'USDC', 'USDD', 'JPY',
  'THB', 'IDR', 'EOS', 'TUSD', 'HPT', 'ARS', 'BRL', 'EUR', 'EUROC', 'USD', 'RUB', 'TRY', 'UAH',
  'USD1', 'TRX', 'UST', 'GBP', 'KGST',
];

describe('htx spot pairs, dashed', () => {
  it.each(QUOTED_IN)('splits a pair quoted in %s at its quote', (quote) => {
    expect(dashed('spot', `ABC${quote}`)).toBe(`ABC-${quote}`);
  });
});
