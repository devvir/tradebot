import { describe, expect, it } from 'vitest';
import { tarSize } from '../../../src/tools/cold/tar';

/**
 * The point of this is checking a tar that is *only* in cold storage: its size
 * in Mega's listing against what its `member` rows imply, with no download. So
 * it has to be exact rather than close.
 *
 * Verified against five real tars — 744, 1,677, 9,883, 405,422 and 12 members —
 * every one predicted to the byte.
 */
describe('predicting a tar size from its member list', () => {
  it('accounts for headers, padding and the blocking factor', () => {
    // 512 header + 512 padded content + 1024 trailer = 2,048, padded up to the
    // 10,240 blocking factor.
    expect(tarSize([{ path: 'a', bytes: 100 }])).toBe(10_240);
  });

  /**
   * Enough members that the extra blocks cross a boundary — a single one pads
   * into the same 10,240 block either way, which is why the real tars proved
   * this and a one-member case could not.
   */
  it('adds a long-name header for a path past 100 bytes', () => {
    const many  = (name: string) => Array.from({ length: 20 }, () => ({ path: name, bytes: 1 }));
    const short = tarSize(many('a'.repeat(100)));
    const long  = tarSize(many('a'.repeat(101)));

    // 20 members × (512 long-name header + 512 padded name) = 20,480 more.
    expect(long - short).toBe(20_480);
  });

  /** A path is measured in bytes, not characters, or a CJK name under-counts. */
  it('measures a path in bytes rather than characters', () => {
    const wide = '好'.repeat(40);   // 40 characters, 120 bytes — past the limit.

    expect(Buffer.byteLength(wide)).toBeGreaterThan(100);
    expect(tarSize(Array.from({ length: 20 }, () => ({ path: wide, bytes: 1 }))))
      .toBeGreaterThan(tarSize(Array.from({ length: 20 }, () => ({ path: 'a', bytes: 1 }))));
  });

  it('grows in blocking-factor steps, never between them', () => {
    const sizes = [1, 50, 500, 5_000].map(n =>
      tarSize(Array.from({ length: n }, (_, i) => ({ path: `p${i}`, bytes: 1_000 }))));

    for (const size of sizes) expect(size % 10_240).toBe(0);
  });

  it('is empty-safe', () => {
    expect(tarSize([])).toBe(10_240);
  });
});
