import { describe, expect, it } from 'vitest';
import { bytes } from '../web/views/Table';

/** How a size is written: in the largest unit it fills, to two or three figures. */

const KB = 1024;
const PB = KB ** 5;

describe('bytes', () => {
  it('writes what is under a kilobyte in bytes', () => {
    expect(bytes(0)).toBe('0 B');
    expect(bytes(1023)).toBe('1023 B');
  });

  it('moves up a unit at 1024, with a decimal while under ten', () => {
    expect(bytes(KB)).toBe('1.0 KB');
    expect(bytes(1.5 * KB)).toBe('1.5 KB');
    expect(bytes(10 * KB)).toBe('10 KB');
    expect(bytes(KB * KB - 1)).toBe('1024 KB');
    expect(bytes(KB * KB)).toBe('1.0 MB');
  });

  it('stops at petabytes, however large', () => {
    expect(bytes(PB)).toBe('1.0 PB');
    expect(bytes(PB * KB)).toBe('1024 PB');
  });
});
