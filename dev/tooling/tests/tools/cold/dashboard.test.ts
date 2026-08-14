import { describe, expect, it } from 'vitest';
import {
  _test_hold as hold,
  _test_merge as merge,
  _test_render as render,
} from '../../../src/tools/cold/audit';
import type { PartRow } from '../../../src/tools/cold/types';

/**
 * The dashboard cell: how far a venue goes, what it weighs, and how much of it
 * would survive this disk dying — three lines answering three questions in the
 * order they get asked.
 */
const part = (over: Partial<PartRow> = {}): PartRow => ({
  id: 1, origin: 'vault', venue: 'bybit', month: '202106', seq: 1,
  name: '202106.p01.tar', remote: 'bybit/2021/202106.p01.tar', local: 'bybit/202106.p01.tar',
  bytes: 100, files: 10, uploadedAt: null, handle: null, replan: 0,
  ...over,
});

/** Colours make the assertions unreadable and say nothing about the numbers. */
const plain = (text: string): string => text.replace(/\x1b\[[\d;]*m/g, '');

describe('folding a tree into one holding per venue', () => {
  it('counts months, parts, bytes and files', () => {
    const held = hold([
      part({ month: '202106', bytes: 100, files: 10 }),
      part({ month: '202107', bytes: 200, files: 20 }),
    ]).get('bybit')!;

    expect(held.monthCount).toBe(2);
    expect(held.parts).toBe(2);
    expect(held.bytes).toBe(300);
    expect(held.files).toBe(30);
  });

  it('keeps venues apart', () => {
    const venues = hold([part({ venue: 'bybit' }), part({ venue: 'okx' })]);

    expect([...venues.keys()].sort()).toEqual(['bybit', 'okx']);
  });

  it('counts a month once however many parts it took', () => {
    const held = hold([
      part({ month: '202106', seq: 1 }),
      part({ month: '202106', seq: 2 }),
      part({ month: '202106', seq: 3 }),
    ]).get('bybit')!;

    expect(held.monthCount).toBe(1);
    expect(held.parts).toBe(3);
  });

  /**
   * A partially uploaded month is neither in nor out, and rounding it either
   * way is a lie in a table whose job is saying where things stand.
   */
  it('counts a half-uploaded month as a fraction', () => {
    const held = hold([
      part({ month: '202106', seq: 1, uploadedAt: 'now' }),
      part({ month: '202106', seq: 2 }),
      part({ month: '202107', seq: 1, uploadedAt: 'now' }),
    ]).get('bybit')!;

    expect(held.sent).toBe(2);
    expect(held.sentMonths).toBeCloseTo(1.5);
  });

  it('counts only uploaded bytes as backed up', () => {
    const held = hold([
      part({ seq: 1, bytes: 100, uploadedAt: 'now' }),
      part({ seq: 2, bytes: 900 }),
    ]).get('bybit')!;

    expect(held.bytes).toBe(1000);
    expect(held.sentBytes).toBe(100);
  });
});

/**
 * The bug this exists to prevent: seven venues each holding 2020-03 are seven
 * venue-months of data and one calendar month, and unioning the sets printed
 * `108 mo` under a column adding to 252.
 */
describe('adding holdings together for the totals row', () => {
  it('adds month counts rather than unioning the months', () => {
    const venues = hold([
      part({ venue: 'bybit', month: '202103' }),
      part({ venue: 'okx',   month: '202103' }),
    ]);

    expect(merge([...venues.values()]).monthCount).toBe(2);
  });

  it('adds every other figure', () => {
    const total = merge([...hold([
      part({ venue: 'bybit', bytes: 100, files: 10, uploadedAt: 'now' }),
      part({ venue: 'okx',   bytes: 200, files: 20 }),
    ]).values()]);

    expect(total.parts).toBe(2);
    expect(total.bytes).toBe(300);
    expect(total.files).toBe(30);
    expect(total.sent).toBe(1);
    expect(total.sentBytes).toBe(100);
  });

  it('is zero across nothing at all', () => {
    expect(merge([]).parts).toBe(0);
    expect(merge([]).monthCount).toBe(0);
  });
});

describe('rendering one cell', () => {
  it('says nothing is here rather than printing zeroes', () => {
    expect(plain(render(undefined))).toBe('—');
  });

  it('spans the whole range, not only what is backed up', () => {
    const held = hold([
      part({ month: '201707', uploadedAt: 'now' }),
      part({ month: '202605' }),
    ]).get('bybit')!;

    expect(plain(render(held)).split('\n')[0]).toBe('2 mo (2017-07 → 2026-05)');
  });

  /**
   * `27 backed up (27.0 mo, 2.0GB)` under `27 parts (2.0GB)` is the same three
   * numbers twice, and most venues sit in exactly that state.
   */
  it('says a complete tree is complete rather than repeating itself', () => {
    const held = hold([part({ bytes: 1024 ** 3, uploadedAt: 'now' })]).get('bybit')!;

    expect(plain(render(held)).split('\n')[2]).toBe('all backed up (1.0GB)');
  });

  it('gives the backed-up count and its fractional months when short', () => {
    const held = hold([
      part({ month: '202106', seq: 1, bytes: 1024 ** 3, uploadedAt: 'now' }),
      part({ month: '202106', seq: 2, bytes: 1024 ** 3 }),
    ]).get('bybit')!;

    expect(plain(render(held)).split('\n')[2]).toBe('1 backed up (0.5 mo, 1.0GB)');
  });

  /** The totals row has no range: it spans every venue, not one timeline. */
  it('leaves the range off the totals row', () => {
    const held = hold([part({ month: '202106' })]).get('bybit')!;

    expect(plain(render(held, true)).split('\n')[0]).toBe('1 mo');
  });
});
