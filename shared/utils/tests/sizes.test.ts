import { describe, expect, it } from 'vitest';
import { sizeOf } from '../src/sizes';

describe('readable sizes', () => {
  it('scales to the unit that keeps the number meaningful', () => {
    expect(sizeOf(0)).toBe('0 B');
    expect(sizeOf(912)).toBe('912 B');
    expect(sizeOf(1024)).toBe('1 KB');
    expect(sizeOf(18.1 * 1024 * 1024)).toBe('18.1 MB');
    expect(sizeOf(2.4 * 1024 ** 3)).toBe('2.4 GB');
    expect(sizeOf(3 * 1024 ** 4)).toBe('3 TB');
  });

  /**
   * The case that prompted this: a thin symbol's file rounded to `0 mb` and
   * said nothing at all about what was being read.
   */
  it('never flattens a small input to zero', () => {
    expect(sizeOf(4096)).not.toMatch(/^0 /);
  });
});
