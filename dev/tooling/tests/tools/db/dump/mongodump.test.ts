import { describe, it, expect } from 'vitest';
import {
  _test_parseProgress as parseProgress,
  _test_parseDoneLine as parseDoneLine,
} from '../../../../src/tools/db/dump/mongodump';

describe('parseProgress (mongodump --verbose stderr line)', () => {
  it('extracts the running counter from a typical line', () => {
    const line = '2026-05-23T21:33:11.624+0400\ttradebot.compositeIndex  91212';
    expect(parseProgress(line)).toEqual({ done: 91212 });
  });

  it('handles single-digit counts', () => {
    expect(parseProgress('2026-05-23T21:33:11.624+0400\ttradebot.quote  1')).toEqual({ done: 1 });
  });

  it('handles namespaces with extra dots (db.dot.coll edge case)', () => {
    expect(parseProgress('2026-05-23T21:33:11.624+0400\tfoo.bar.baz  42')).toEqual({ done: 42 });
  });

  it('returns null for non-progress lines', () => {
    expect(parseProgress('2026-05-23T21:33:08.701+0400\tarchive prelude `tradebot.compositeIndex`')).toBeNull();
    expect(parseProgress('2026-05-23T21:33:08.702+0400\tdumping up to 1 collections in parallel')).toBeNull();
    expect(parseProgress('writing `tradebot.quote` to "archive `/tmp/x.archive`"')).toBeNull();
    expect(parseProgress('done dumping `tradebot.quote` (10000 documents)')).toBeNull();
    expect(parseProgress('')).toBeNull();
  });

  it('does not match lines that end in non-counter digits', () => {
    expect(parseProgress('connected to host port 17017')).toBeNull();
  });
});

describe('parseDoneLine (mongodump completion line)', () => {
  it('extracts the doc count from the real mongodump format (backticked namespace)', () => {
    expect(parseDoneLine('done dumping `tradebot.quote` (10000 documents)')).toBe(10000);
    expect(parseDoneLine('done dumping `tradebot.tradeBin1d` (1 document)')).toBe(1);
    expect(parseDoneLine('done dumping `tradebot.settlement` (0 documents)')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(parseDoneLine('Done Dumping `tradebot.quote` (42 documents)')).toBe(42);
  });

  it('returns null for non-done lines', () => {
    expect(parseDoneLine('writing `tradebot.quote` to "archive `/tmp/x.archive`"')).toBeNull();
    expect(parseDoneLine('tradebot.quote  5234')).toBeNull();
    expect(parseDoneLine('')).toBeNull();
  });
});
