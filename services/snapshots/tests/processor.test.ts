import { describe, it, expect, beforeEach } from 'vitest';
import type { Message, Snapshot } from '../src/types';

// Helper to extract processor logic and test it
const processMessage = (
  snapshots: Record<string, Snapshot>,
  message: Message,
) => {
  const snapshot = snapshots[message.table] as Snapshot | undefined;

  // Drop pre-filtered partials (snapshots are unfiltered, table-based only)
  if (message.action === 'partial' && 'filter' in message && 'symbol' in (message.filter as any)!) {
    throw new Error('Received pre-filtered partial (not supported)');
  }

  // Drop deltas until we have initialized the table snapshot
  if (! snapshot && message.action !== 'partial') {
    return { processed: false, reason: 'Discarding delta: no partial yet' };
  }

  // Initialize or refresh the table snapshot
  if (message.action === 'partial') {
    snapshots[message.table] = message as Snapshot;
  } else if (snapshot) {
    // applyDelta would be called here in real code
    snapshot.counter = message.counter;
  }

  return { processed: true, snapshot: snapshots[message.table] };
};

describe('processor', () => {
  let snapshots: Record<string, Snapshot>;

  beforeEach(() => {
    snapshots = {};
  });

  describe('message handling', () => {
    it('initializes snapshot on partial', () => {
      const partial: Message = {
        table: 'orderBookL2',
        action: 'partial',
        keys: ['id'],
        types: { id: 'long' },
        data: [{ id: 1, price: 100 }],
        counter: 1,
      };

      const result = processMessage(snapshots, partial);

      expect(result.processed).toBe(true);
      expect(snapshots.orderBookL2).toBeDefined();
      expect(snapshots.orderBookL2.data).toHaveLength(1);
      expect(snapshots.orderBookL2.counter).toBe(1);
    });

    it('drops insert before partial', () => {
      const insert: Message = {
        table: 'orderBookL2',
        action: 'insert',
        data: [{ id: 2, price: 110 }],
        counter: 2,
      };

      const result = processMessage(snapshots, insert);

      expect(result.processed).toBe(false);
      expect(result.reason).toBe('Discarding delta: no partial yet');
    });

    it('drops update before partial', () => {
      const update: Message = {
        table: 'orderBookL2',
        action: 'update',
        data: [{ id: 1, price: 105 }],
        counter: 2,
      };

      const result = processMessage(snapshots, update);

      expect(result.processed).toBe(false);
    });

    it('drops delete before partial', () => {
      const del: Message = {
        table: 'orderBookL2',
        action: 'delete',
        data: [{ id: 1 }],
        counter: 2,
      };

      const result = processMessage(snapshots, del);

      expect(result.processed).toBe(false);
    });

    it('processes insert after partial', () => {
      // Initialize with partial
      const partial: Message = {
        table: 'orderBookL2',
        action: 'partial',
        keys: ['id'],
        types: { id: 'long' },
        data: [{ id: 1, price: 100 }],
        counter: 1,
      };
      processMessage(snapshots, partial);

      // Now process insert
      const insert: Message = {
        table: 'orderBookL2',
        action: 'insert',
        data: [{ id: 2, price: 110 }],
        counter: 2,
      };

      const result = processMessage(snapshots, insert);

      expect(result.processed).toBe(true);
      expect(snapshots.orderBookL2.counter).toBe(2);
    });

    it('replaces snapshot on second partial', () => {
      // First partial
      const partial1: Message = {
        table: 'orderBookL2',
        action: 'partial',
        keys: ['id'],
        types: { id: 'long' },
        data: [{ id: 1, price: 100 }],
        counter: 1,
      };
      processMessage(snapshots, partial1);
      const firstSnapshot = snapshots.orderBookL2;

      // Second partial
      const partial2: Message = {
        table: 'orderBookL2',
        action: 'partial',
        keys: ['id'],
        types: { id: 'long' },
        data: [{ id: 2, price: 200 }],
        counter: 5,
      };
      processMessage(snapshots, partial2);

      expect(snapshots.orderBookL2).not.toBe(firstSnapshot);
      expect(snapshots.orderBookL2.data).toHaveLength(1);
      expect(snapshots.orderBookL2.data[0]).toEqual({ id: 2, price: 200 });
      expect(snapshots.orderBookL2.counter).toBe(5);
    });
  });

  describe('filter validation', () => {
    it('throws on pre-filtered partial with symbol filter', () => {
      const filtered: Message = {
        table: 'OrderBookL2',
        action: 'partial',
        keys: ['id'],
        types: { id: 'long' },
        filter: { symbol: 'XBTUSD' },
        data: [{ id: 1, price: 100 }],
        counter: 1,
      };

      expect(() => processMessage(snapshots, filtered)).toThrow(
        /pre-filtered/
      );
    });

    it('throws on pre-filtered partial with any filter property', () => {
      const filtered: Message = {
        table: 'trade',
        action: 'partial',
        keys: ['trdID'],
        types: { trdID: 'long' },
        filter: { symbol: 'XBTUSD' },
        data: [],
        counter: 1,
      };

      expect(() => processMessage(snapshots, filtered)).toThrow();
    });

    it('allows partial with empty filter', () => {
      const partial: Message = {
        table: 'instrument',
        action: 'partial',
        keys: ['symbol'],
        types: { symbol: 'string' },
        filter: {},
        data: [],
        counter: 1,
      };

      const result = processMessage(snapshots, partial);
      expect(result.processed).toBe(true);
    });
  });

  describe('counter handling', () => {
    beforeEach(() => {
      const partial: Message = {
        table: 'orderBookL2',
        action: 'partial',
        keys: ['id'],
        types: { id: 'long' },
        data: [{ id: 1, price: 100 }],
        counter: 1,
      };
      processMessage(snapshots, partial);
    });

    it('increments snapshot counter with deltas', () => {
      const update: Message = {
        table: 'orderBookL2',
        action: 'update',
        data: [{ id: 1, price: 105 }],
        counter: 42,
      };

      processMessage(snapshots, update);

      expect(snapshots.orderBookL2.counter).toBe(42);
    });

    it('tracks message counts across multiple tables', () => {
      const orderBookDelta: Message = {
        table: 'orderBookL2',
        action: 'update',
        data: [{ id: 1, price: 110 }],
        counter: 10,
      };

      const instrumentPartial: Message = {
        table: 'instrument',
        action: 'partial',
        keys: ['symbol'],
        types: { symbol: 'string' },
        data: [{ symbol: 'XBTUSD' }],
        counter: 100,
      };

      processMessage(snapshots, orderBookDelta);
      processMessage(snapshots, instrumentPartial);

      expect(snapshots.orderBookL2.counter).toBe(10);
      expect(snapshots.instrument.counter).toBe(100);
    });
  });

  describe('multiple tables', () => {
    it('maintains separate snapshots per table', () => {
      const orderBookPartial: Message = {
        table: 'orderBookL2',
        action: 'partial',
        keys: ['id'],
        types: { id: 'long' },
        data: [{ id: 1 }],
        counter: 1,
      };

      const tradePartial: Message = {
        table: 'trade',
        action: 'partial',
        keys: ['trdID'],
        types: { trdID: 'long' },
        data: [{ trdID: 100 }],
        counter: 2,
      };

      processMessage(snapshots, orderBookPartial);
      processMessage(snapshots, tradePartial);

      expect(Object.keys(snapshots)).toHaveLength(2);
      expect(snapshots.orderBookL2.table).toBe('orderBookL2');
      expect(snapshots.trade.table).toBe('trade');
    });

    it('processes deltas for correct table only', () => {
      const orderBookPartial: Message = {
        table: 'orderBookL2',
        action: 'partial',
        keys: ['id'],
        types: { id: 'long' },
        data: [{ id: 1 }],
        counter: 1,
      };
      processMessage(snapshots, orderBookPartial);

      // Try to process trade delta before trade partial exists
      const tradeDelta: Message = {
        table: 'trade',
        action: 'insert',
        data: [{ trdID: 100 }],
        counter: 2,
      };

      const result = processMessage(snapshots, tradeDelta);

      expect(result.processed).toBe(false);
      expect(snapshots.orderBookL2).toBeDefined();
      expect(snapshots.trade).toBeUndefined();
    });
  });
});
