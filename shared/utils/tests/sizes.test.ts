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

  /** A non-zero size is written in a unit small enough that it does not print as zero. */
  it('never flattens a small input to zero', () => {
    expect(sizeOf(4096)).not.toMatch(/^0 /);
  });

  /** The unit follows the rounded number, so no size prints as `1024` of a unit. */
  it('moves to the next unit when rounding reaches 1024', () => {
    expect(sizeOf(1024 * 1024 - 1)).toBe('1 MB');
    expect(sizeOf(1023.96 * 1024)).toBe('1 MB');
    expect(sizeOf(1024 ** 3 - 1)).toBe('1 GB');
  });

  it('stays in the unit while the rounded number is below 1024', () => {
    expect(sizeOf(1023)).toBe('1023 B');
    expect(sizeOf(1023.9 * 1024)).toBe('1023.9 KB');
  });
});
