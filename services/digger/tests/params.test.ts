import { describe, it, expect, beforeEach } from 'vitest';
import * as clock from '../src/clock';
import { parseRestParams } from '../src/rest/params';

beforeEach(() => { clock._test_reset(); });

// ── Defaults ──────────────────────────────────────────────────────────────────

describe('parseRestParams — defaults', () => {
  it('returns sensible defaults for empty input', () => {
    const params = parseRestParams({});

    expect(params.count).toBe(100);
    expect(params.start).toBe(0);
    expect(params.reverse).toBe(false);
    expect(params.symbol).toBeUndefined();
    expect(params.startTime).toBeUndefined();
    expect(params.columns).toBeUndefined();
  });
});

// ── count ─────────────────────────────────────────────────────────────────────

describe('parseRestParams — count', () => {
  it('respects an explicit count', () => {
    expect(parseRestParams({ count: 50 }).count).toBe(50);
  });

  it('caps count at 500', () => {
    expect(parseRestParams({ count: 1_000 }).count).toBe(500);
  });

  it('accepts count as a string number', () => {
    expect(parseRestParams({ count: '200' }).count).toBe(200);
  });
});

// ── start ─────────────────────────────────────────────────────────────────────

describe('parseRestParams — start', () => {
  it('uses 0 when unset', () => {
    expect(parseRestParams({}).start).toBe(0);
  });

  it('respects an explicit start', () => {
    expect(parseRestParams({ start: 10 }).start).toBe(10);
  });
});

// ── reverse ───────────────────────────────────────────────────────────────────

describe('parseRestParams — reverse', () => {
  it('false by default', () => {
    expect(parseRestParams({}).reverse).toBe(false);
  });

  it('true for boolean true', () => {
    expect(parseRestParams({ reverse: true }).reverse).toBe(true);
  });

  it('true for string "true"', () => {
    expect(parseRestParams({ reverse: 'true' }).reverse).toBe(true);
  });

  it('true for string "1"', () => {
    expect(parseRestParams({ reverse: '1' }).reverse).toBe(true);
  });

  it('false for string "false"', () => {
    expect(parseRestParams({ reverse: 'false' }).reverse).toBe(false);
  });
});

// ── endTime default when reverse=true ─────────────────────────────────────────

describe('parseRestParams — endTime defaults to clock when reverse=true', () => {
  it('uses the replay clock when set', () => {
    const clockMs = 1_700_000_000_000;

    clock.set(clockMs);

    const params = parseRestParams({ reverse: 'true' });

    expect(params.endTime).toBe(clockMs);
  });

  it('falls back to Date.now() when clock is null', () => {
    const before = Date.now();
    const params = parseRestParams({ reverse: 'true' });
    const after  = Date.now();

    expect(params.endTime).toBeGreaterThanOrEqual(before);
    expect(params.endTime).toBeLessThanOrEqual(after);
  });

  it('does not set endTime when reverse=false', () => {
    clock.set(1_700_000_000_000);
    expect(parseRestParams({ reverse: 'false' }).endTime).toBeUndefined();
  });

  it('explicit endTime overrides the clock default', () => {
    const explicit = '2025-01-01T00:00:00.000Z';

    clock.set(1_700_000_000_000);

    const params = parseRestParams({ reverse: 'true', endTime: explicit });

    expect(params.endTime).toBe(new Date(explicit).getTime());
  });
});

// ── time parsing ──────────────────────────────────────────────────────────────

describe('parseRestParams — time parsing', () => {
  it('parses ISO string startTime', () => {
    const ts     = '2025-06-01T00:00:00.000Z';
    const params = parseRestParams({ startTime: ts });

    expect(params.startTime).toBe(new Date(ts).getTime());
  });

  it('accepts numeric epoch ms', () => {
    const ms     = 1_700_000_000_000;
    const params = parseRestParams({ startTime: ms });

    expect(params.startTime).toBe(ms);
  });

  it('throws 400 on invalid time string', () => {
    expect(() => parseRestParams({ startTime: 'not-a-date' })).toThrow();
  });
});

// ── columns ───────────────────────────────────────────────────────────────────

describe('parseRestParams — columns', () => {
  it('parses comma-separated columns', () => {
    const params = parseRestParams({ columns: 'timestamp,symbol,price' });

    expect(params.columns).toEqual(['timestamp', 'symbol', 'price']);
  });

  it('trims whitespace around column names', () => {
    const params = parseRestParams({ columns: ' timestamp , symbol ' });

    expect(params.columns).toEqual(['timestamp', 'symbol']);
  });

  it('returns undefined when columns is not a string', () => {
    expect(parseRestParams({}).columns).toBeUndefined();
  });
});

// ── symbol ────────────────────────────────────────────────────────────────────

describe('parseRestParams — symbol', () => {
  it('passes through a symbol string', () => {
    expect(parseRestParams({ symbol: 'XBTUSD' }).symbol).toBe('XBTUSD');
  });

  it('returns undefined for an empty symbol', () => {
    expect(parseRestParams({ symbol: '' }).symbol).toBeUndefined();
  });
});
