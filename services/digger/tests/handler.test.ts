import { describe, it, expect } from 'vitest';
import {
  timestampFromId,
  timestampFromData,
  timestampFromField,
  wrapAsInsert,
  makeEmptyPartial,
} from '../src/tables/handler';

// ── Constants (mirrored from handler.ts) ──────────────────────────────────────

const EPOCH_2000_MS = Date.UTC(2000, 0, 1);
const MS_PER_DAY    = 86_400_000;
const SHIFT_39      = 549_755_813_888;

// ── timestampFromId ───────────────────────────────────────────────────────────

describe('timestampFromId', () => {
  it('returns epoch-2000 for _id = 0', () => {
    expect(timestampFromId({ _id: 0 })).toBe(EPOCH_2000_MS);
  });

  it('returns epoch-2000 + 1 day for _id = SHIFT_39', () => {
    expect(timestampFromId({ _id: SHIFT_39 })).toBe(EPOCH_2000_MS + MS_PER_DAY);
  });

  it('ignores sub-day bits (msgIndex and reserved)', () => {
    // _id with dateOffset=1, msgIndex=999, reserved=42
    const id = 1 * SHIFT_39 + 999 * 4_096 + 42;

    expect(timestampFromId({ _id: id })).toBe(EPOCH_2000_MS + MS_PER_DAY);
  });
});

// ── timestampFromData ─────────────────────────────────────────────────────────

describe('timestampFromData', () => {
  it('reads timestamp from data[0].timestamp', () => {
    const ts  = '2025-06-01T12:00:00.000Z';
    const doc = { _id: 0, data: [{ symbol: 'XBTUSD', timestamp: ts }] };

    expect(timestampFromData(doc)).toBe(new Date(ts).getTime());
  });

  it('falls back to _id decode when data has no timestamp field', () => {
    const doc = { _id: SHIFT_39, data: [{ symbol: 'XBTUSD' }] };

    expect(timestampFromData(doc)).toBe(EPOCH_2000_MS + MS_PER_DAY);
  });

  it('falls back to _id decode when data array is empty', () => {
    const doc = { _id: SHIFT_39, data: [] };

    expect(timestampFromData(doc)).toBe(EPOCH_2000_MS + MS_PER_DAY);
  });

  it('falls back to _id decode when data is absent', () => {
    const doc = { _id: SHIFT_39 };

    expect(timestampFromData(doc)).toBe(EPOCH_2000_MS + MS_PER_DAY);
  });
});

// ── timestampFromField ────────────────────────────────────────────────────────

describe('timestampFromField', () => {
  it('reads timestamp from the flat timestamp field', () => {
    const ts  = '2025-01-15T08:30:00.000Z';
    const doc = { _id: 0, timestamp: ts, symbol: 'XBTUSD' };

    expect(timestampFromField(doc)).toBe(new Date(ts).getTime());
  });
});

// ── wrapAsInsert ──────────────────────────────────────────────────────────────

describe('wrapAsInsert', () => {
  it('wraps a flat doc as a single-item insert message', () => {
    const ts  = '2025-01-01T00:00:00.000Z';
    const doc = { _id: 42, timestamp: ts, symbol: 'XBTUSD', price: 50_000 };

    const result = wrapAsInsert('trade', doc);

    expect(result.consumed).toBe(1);
    expect(result.messages).toHaveLength(1);

    const msg = result.messages[0]!;

    expect(msg.table).toBe('trade');
    expect(msg.action).toBe('insert');
    expect(msg.timestamp).toBe(new Date(ts).getTime());
    expect(msg.payload.table).toBe('trade');
    expect(msg.payload.action).toBe('insert');
    expect(msg.payload.data).toHaveLength(1);
  });

  it('strips _id from the published data', () => {
    const doc    = { _id: 99, timestamp: '2025-01-01T00:00:00.000Z', symbol: 'XBTUSD' };
    const result = wrapAsInsert('trade', doc);
    const item   = result.messages[0]!.payload.data[0] as Record<string, unknown>;

    expect(item['_id']).toBeUndefined();
    expect(item['symbol']).toBe('XBTUSD');
  });
});

// ── makeEmptyPartial ──────────────────────────────────────────────────────────

describe('makeEmptyPartial', () => {
  it('builds a partial with empty data array', () => {
    const partial = makeEmptyPartial(
      'trade',
      ['timestamp', 'symbol'],
      { timestamp: 'timestamp', symbol: 'symbol' },
    );

    expect(partial.table).toBe('trade');
    expect(partial.action).toBe('partial');
    expect(partial.keys).toEqual(['timestamp', 'symbol']);
    expect(partial.types).toEqual({ timestamp: 'timestamp', symbol: 'symbol' });
    expect(partial.data).toEqual([]);
  });

  it('includes optional foreignKeys and attributes when provided', () => {
    const partial = makeEmptyPartial(
      'trade',
      [],
      {},
      { symbol: 'instrument' },
      { timestamp: 'sorted' },
      { test: true },
    );

    expect(partial.foreignKeys).toEqual({ symbol: 'instrument' });
    expect(partial.attributes).toEqual({ timestamp: 'sorted' });
    expect(partial.filter).toEqual({ test: true });
  });

  it('omits optional fields when not provided', () => {
    const partial = makeEmptyPartial('quote', [], {});

    expect(partial.foreignKeys).toBeUndefined();
    expect(partial.attributes).toBeUndefined();
  });
});
