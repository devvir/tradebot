import { describe, expect, it } from 'vitest';
import { matching } from '../web/views/Symbols';

/** The symbol filter: what a query keeps of a venue's instruments. */

const BASES = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA'];

/** 3,000 symbols, a sixth of them BTC pairs. */
const symbols = Array.from({ length: 3_000 }, (_, at) => `${BASES[at % BASES.length]}USDT-${at}`);

describe('matching', () => {
  it('keeps every symbol that contains the query, and only those', () => {
    const kept = matching(symbols, 'BTC');

    expect(kept).toHaveLength(500);
    expect(kept.every(one => one.includes('BTC'))).toBe(true);
  });

  it('ignores case and surrounding space', () => {
    expect(matching(symbols, '  btcusdt-0 ')).toEqual(['BTCUSDT-0']);
  });

  it('keeps everything where the query is blank', () => {
    expect(matching(symbols, '   ')).toBe(symbols);
  });

  it('keeps nothing where nothing matches', () => {
    expect(matching(symbols, 'NOPE')).toEqual([]);
  });
});
