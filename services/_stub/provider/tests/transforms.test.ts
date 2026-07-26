import { describe, it, expect } from 'vitest';
import { toMs } from '../src/ws/time';
import { messageItem } from '../src/ws/message';
import { wrapInsert, groupBySweep } from '../src/ws/wrap';
import { staticPartial } from '../src/ws/partial';
import type { StoredDoc } from '../src/types';

// ── toMs ──────────────────────────────────────────────────────────────────────

describe('toMs', () => {
  it('parses millisecond ISO with Z', () => {
    expect(toMs('2026-01-01T06:51:00.000Z')).toBe(Date.UTC(2026, 0, 1, 6, 51, 0, 0));
  });

  it('parses the ancient nanosecond-without-Z form as UTC, truncating to ms', () => {
    expect(toMs('2019-01-01T00:00:50.590967000')).toBe(Date.UTC(2019, 0, 1, 0, 0, 50, 590));
  });

  it('parses a no-fraction, no-Z timestamp as UTC', () => {
    expect(toMs('2019-01-01T04:00:00')).toBe(Date.UTC(2019, 0, 1, 4, 0, 0, 0));
  });
});

// ── messageItem (message tables) ──────────────────────────────────────────────

describe('messageItem', () => {
  it('strips _id and top-level timestamp, keeps action/data and partial meta', () => {
    const doc: StoredDoc = {
      _id:       42,
      table:     'orderBookL2',
      action:    'partial',
      timestamp: '2019-04-01T00:00:02.680Z',
      keys:      ['symbol', 'id', 'side'],
      types:     { symbol: 'symbol' },
      filter:    {},
      data:      [{ symbol: 'XBTUSD', id: 8700000000, side: 'Sell', size: 1830 }],
    };

    const { ts, msg } = messageItem(doc);

    expect(ts).toBe(Date.UTC(2019, 3, 1, 0, 0, 2, 680));
    expect(msg).toEqual({
      table:  'orderBookL2',
      action: 'partial',
      keys:   ['symbol', 'id', 'side'],
      types:  { symbol: 'symbol' },
      filter: {},
      data:   [{ symbol: 'XBTUSD', id: 8700000000, side: 'Sell', size: 1830 }],
    });
    expect('_id' in msg).toBe(false);
    expect('timestamp' in msg).toBe(false);
  });

  it('republishes a delta with no partial metadata', () => {
    const doc: StoredDoc = {
      _id:       43,
      table:     'orderBookL2',
      action:    'update',
      timestamp: '2019-04-01T00:00:07.853Z',
      data:      [{ symbol: 'XBTUSD', id: 8799590900, side: 'Sell', size: 801268 }],
    };

    expect(messageItem(doc).msg).toEqual({
      table:  'orderBookL2',
      action: 'update',
      data:   [{ symbol: 'XBTUSD', id: 8799590900, side: 'Sell', size: 801268 }],
    });
  });
});

// ── wrapInsert / groupBySweep (flat tables) ───────────────────────────────────

const trade = (id: number, ts: string, symbol: string, price: number): StoredDoc =>
  ({ _id: id, timestamp: ts, symbol, side: 'Buy', size: 1, price });

describe('wrapInsert', () => {
  it('wraps one flat record as a single-item insert, stripping _id', () => {
    const { ts, msg } = wrapInsert('quote', { _id: 7, timestamp: '2019-01-01T00:00:04.386Z', symbol: 'XBTUSD', bidPrice: 1 });

    expect(ts).toBe(Date.UTC(2019, 0, 1, 0, 0, 4, 386));
    expect(msg).toEqual({ table: 'quote', action: 'insert', data: [{ timestamp: '2019-01-01T00:00:04.386Z', symbol: 'XBTUSD', bidPrice: 1 }] });
  });
});

describe('groupBySweep', () => {
  it('groups consecutive same timestamp+symbol records into one insert', () => {
    const docs = [
      trade(1, '2019-01-01T00:00:00.000Z', 'XBTUSD', 100),
      trade(2, '2019-01-01T00:00:00.000Z', 'XBTUSD', 101),
      trade(3, '2019-01-01T00:00:01.000Z', 'XBTUSD', 102),
    ];

    const { items, consumedId } = groupBySweep('trade', docs, false);

    expect(items).toHaveLength(2);
    expect(items[0]!.msg.data).toHaveLength(2);
    expect(items[1]!.msg.data).toHaveLength(1);
    expect(consumedId).toBe(3);
  });

  it('separates different symbols at the same timestamp', () => {
    const docs = [
      trade(1, '2019-01-01T00:00:00.000Z', 'XBTUSD', 100),
      trade(2, '2019-01-01T00:00:00.000Z', 'ETHUSD', 5),
    ];

    expect(groupBySweep('trade', docs, false).items).toHaveLength(2);
  });

  it('holds back the trailing group when the batch is full (more may follow)', () => {
    const docs = [
      trade(1, '2019-01-01T00:00:00.000Z', 'XBTUSD', 100),
      trade(2, '2019-01-01T00:00:01.000Z', 'XBTUSD', 101),
      trade(3, '2019-01-01T00:00:01.000Z', 'XBTUSD', 102),
    ];

    const { items, consumedId } = groupBySweep('trade', docs, true);

    expect(items).toHaveLength(1);          // only the first (complete) group
    expect(consumedId).toBe(1);             // trailing 00:00:01 group held back
  });

  it('emits a whole-batch single group rather than stalling (accepted straddle)', () => {
    const docs = [
      trade(1, '2019-01-01T00:00:00.000Z', 'XBTUSD', 100),
      trade(2, '2019-01-01T00:00:00.000Z', 'XBTUSD', 101),
    ];

    const { items, consumedId } = groupBySweep('trade', docs, true);

    expect(items).toHaveLength(1);
    expect(items[0]!.msg.data).toHaveLength(2);
    expect(consumedId).toBe(2);
  });
});

// ── staticPartial ─────────────────────────────────────────────────────────────

describe('staticPartial', () => {
  it('builds a schema-only partial from TABLE_SPECS', () => {
    const p = staticPartial('trade');

    expect(p.action).toBe('partial');
    expect(p.data).toEqual([]);
    expect(p.keys).toBeDefined();
    expect(p.types!.timestamp).toBe('timestamp');
  });

  it('works for the deferred order-book tables (empty)', () => {
    const p = staticPartial('orderBook10');

    expect(p.action).toBe('partial');
    expect(p.data).toEqual([]);
    expect(p.types!.bids).toBeDefined();
  });
});
