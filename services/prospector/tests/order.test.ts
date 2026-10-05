import { describe, expect, it } from 'vitest';
import { _test_byteOrder as byteOrder } from '../src/catalog/queries';

/**
 * Paths are ordered here the way the database orders them — by their UTF-8
 * bytes — or a stretch of a listing is judged against the wrong rows.
 */
describe('the order of two paths', () => {
  const bytes = (a: string, b: string): number => Math.sign(Buffer.compare(Buffer.from(a), Buffer.from(b)));

  const PATHS = [
    '', 'a', 'a/', 'a/b', 'a0', 'ab', 'A', 'p/000001.zip', 'p/000010.zip', 'p0',
    'spot/BTC_USDT', 'spot/btc_usdt', 'é', 'z', '牛来USDT', '龙虾USDT', '龙',
    '￿', 'x', '퟿x', '𠀀', '😀', '😀a', 'a😀', 'a￿', 'a𠀀', '\u{10ffff}',
  ];

  it('is the order of their bytes, for every pair', () => {
    for (const a of PATHS)
      for (const b of PATHS)
        expect([a, b, byteOrder(a, b)]).toEqual([a, b, bytes(a, b)]);
  });

  /** The one place UTF-16 units and bytes disagree. */
  it('puts a character past the plane above the top of the plane', () => {
    expect(byteOrder('😀', '￿')).toBe(1);
    expect('😀' < '￿').toBe(true);
  });

  it('sorts as the database would', () => {
    expect([...PATHS].sort(byteOrder)).toEqual([...PATHS].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  });
});
