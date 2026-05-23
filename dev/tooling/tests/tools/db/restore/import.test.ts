import { describe, it, expect } from 'vitest';
import {
  _test_parseProgress as parseProgress,
  _test_parseDoneLine as parseDoneLine,
} from '../../../../src/tools/db/restore/import';

describe('parseProgress (mongorestore --verbose stderr line)', () => {
  it('extracts the running counter from a typical line', () => {
    const line = '2026-05-24T12:00:00.000+0000\ttradebot.quote  91212';
    expect(parseProgress(line)).toEqual({ done: 91212 });
  });

  it('returns null for non-progress lines', () => {
    expect(parseProgress('checking for collection data in archive')).toBeNull();
    expect(parseProgress('reading metadata for tradebot.quote from archive')).toBeNull();
    expect(parseProgress('finished restoring tradebot.quote (10000 documents)')).toBeNull();
    expect(parseProgress('')).toBeNull();
  });
});

describe('parseDoneLine (mongorestore finished line)', () => {
  it('extracts the doc count from "finished restoring" lines', () => {
    expect(parseDoneLine('finished restoring tradebot.quote (10000 documents)')).toBe(10000);
    expect(parseDoneLine('finished restoring tradebot.tradeBin1d (1 document)')).toBe(1);
    expect(parseDoneLine('finished restoring tradebot.settlement (0 documents)')).toBe(0);
  });

  it('works regardless of namespace digits', () => {
    expect(parseDoneLine('finished restoring tradebot.tradeBin1m (42 documents)')).toBe(42);
  });

  it('returns null for non-done lines', () => {
    expect(parseDoneLine('tradebot.quote  5234')).toBeNull();
    expect(parseDoneLine('')).toBeNull();
  });
});
