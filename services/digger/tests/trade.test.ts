import { describe, it, expect } from 'vitest';
import { tradeHandler } from '../src/tables/rest/trade';
import type { MongoDoc } from '../src/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const doc = (ts: string, sym: string, id: number): MongoDoc => ({
  _id:       id,
  timestamp: ts,
  symbol:    sym,
  side:      'Buy',
  size:      100,
  price:     50_000,
});

const ts1 = '2025-01-01T00:00:00.000Z';
const ts2 = '2025-01-01T00:00:00.001Z';

// ── Single doc ────────────────────────────────────────────────────────────────

describe('tradeHandler.take — single doc', () => {
  it('returns one insert message consuming one doc', () => {
    const docs   = [doc(ts1, 'XBTUSD', 1)];
    const result = tradeHandler.take(docs);

    expect(result).not.toBeNull();
    expect(result!.consumed).toBe(1);
    expect(result!.messages).toHaveLength(1);
    expect(result!.messages[0]!.action).toBe('insert');
    expect(result!.messages[0]!.payload.data).toHaveLength(1);
  });

  it('strips _id from the published data', () => {
    const docs   = [doc(ts1, 'XBTUSD', 42)];
    const result = tradeHandler.take(docs);
    const item   = result!.messages[0]!.payload.data[0] as Record<string, unknown>;

    expect(item['_id']).toBeUndefined();
    expect(item['timestamp']).toBe(ts1);
  });

  it('timestamp on the outbound message is epoch ms', () => {
    const docs   = [doc(ts1, 'XBTUSD', 1)];
    const result = tradeHandler.take(docs);

    expect(result!.messages[0]!.timestamp).toBe(new Date(ts1).getTime());
  });
});

// ── Sweep reconstruction ──────────────────────────────────────────────────────

describe('tradeHandler.take — sweep reconstruction', () => {
  it('groups consecutive docs with same timestamp+symbol into one insert', () => {
    const docs = [
      doc(ts1, 'XBTUSD', 1),
      doc(ts1, 'XBTUSD', 2),
      doc(ts1, 'XBTUSD', 3),
    ];
    const result = tradeHandler.take(docs);

    expect(result!.consumed).toBe(3);
    expect(result!.messages).toHaveLength(1);
    expect(result!.messages[0]!.payload.data).toHaveLength(3);
  });

  it('stops the sweep when timestamp changes', () => {
    const docs = [
      doc(ts1, 'XBTUSD', 1),
      doc(ts1, 'XBTUSD', 2),
      doc(ts2, 'XBTUSD', 3),
    ];
    const result = tradeHandler.take(docs);

    expect(result!.consumed).toBe(2);
    expect(result!.messages[0]!.payload.data).toHaveLength(2);
  });

  it('stops the sweep when symbol changes', () => {
    const docs = [
      doc(ts1, 'XBTUSD', 1),
      doc(ts1, 'ETHUSD', 2),
    ];
    const result = tradeHandler.take(docs);

    expect(result!.consumed).toBe(1);
    expect(result!.messages[0]!.payload.data).toHaveLength(1);
  });
});

// ── Empty buffer ──────────────────────────────────────────────────────────────

describe('tradeHandler.take — empty buffer', () => {
  it('returns null on empty input', () => {
    expect(tradeHandler.take([])).toBeNull();
  });
});
