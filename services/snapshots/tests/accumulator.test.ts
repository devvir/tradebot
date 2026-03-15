import { describe, it, expect } from 'vitest';
import { applyDelta, newSnapshot } from '../src/accumulator';
import type { Message, Snapshot, SnapshotIndexedData } from '../src/types';

const createSnapshot = (withKeys: boolean, data: any[] = []): Snapshot => ({
  table: 'orderBookL2',
  action: 'partial',
  keys: withKeys ? ['id'] : [],
  types: { id: 'long', side: 'symbol' },
  data,
  counter: 1,
});

const createMessage = (action: 'insert' | 'delete' | 'update', counter: number, data: any[]): Message => ({
  table: 'orderBookL2',
  action,
  data,
  counter,
});

const getDataAsArray = (data: any): any[] => (data instanceof Map ? Array.from(data.values()) : data);

describe('accumulator', () => {
  describe('applyDelta - insert', () => {
    it('insert without keys: adds to array', () => {
      const snapshot = createSnapshot(false, [{ id: 1 }, { id: 2 }]);
      const msg = createMessage('insert', 2, [{ id: 3 }]);
      applyDelta(snapshot, msg);
      const data = getDataAsArray(snapshot.data);
      expect(data).toHaveLength(3);
      expect(data[2]).toEqual({ id: 3 });
      expect(snapshot.counter).toBe(2);
    });

    it('insert with keys: adds to indexed map', () => {
      const snapshot = createSnapshot(true, [{ id: 1, side: 'Buy' }, { id: 2, side: 'Sell' }]);
      newSnapshot(snapshot);
      const msg = createMessage('insert', 2, [{ id: 3, side: 'Buy' }]);
      applyDelta(snapshot, msg);
      const data = getDataAsArray(snapshot.data);
      expect(data).toHaveLength(3);
      expect(data.some((r: any) => r.id === 3)).toBe(true);
      expect(snapshot.counter).toBe(2);
    });
  });

  describe('applyDelta - delete', () => {
    it('delete without keys: logs error', () => {
      const snapshot = createSnapshot(false, [{ id: 1 }, { id: 2 }]);
      const msg = createMessage('delete', 2, [{ id: 1 }]);
      applyDelta(snapshot, msg);
      const data = getDataAsArray(snapshot.data);
      expect(data).toHaveLength(2);
    });

    it('delete with keys: removes from map', () => {
      const snapshot = createSnapshot(true, [{ id: 1, side: 'Buy' }, { id: 2, side: 'Sell' }]);
      newSnapshot(snapshot);
      const msg = createMessage('delete', 2, [{ id: 2 }]);
      applyDelta(snapshot, msg);
      const data = getDataAsArray(snapshot.data);
      expect(data).toHaveLength(1);
      expect(data.some((r: any) => r.id === 2)).toBe(false);
      expect(snapshot.counter).toBe(2);
    });
  });

  describe('applyDelta - update', () => {
    it('update without keys: logs error', () => {
      const snapshot = createSnapshot(false, [{ id: 1, size: 100 }]);
      const msg = createMessage('update', 2, [{ id: 1, size: 200 }]);
      applyDelta(snapshot, msg);
      const data = getDataAsArray(snapshot.data);
      expect((data[0] as any).size).toBe(100);
    });

    it('update with keys: merges into map', () => {
      const snapshot = createSnapshot(true, [{ id: 1, side: 'Buy', size: 100 }]);
      newSnapshot(snapshot);
      const msg = createMessage('update', 2, [{ id: 1, size: 200 }]);
      applyDelta(snapshot, msg);
      const data = getDataAsArray(snapshot.data);
      const updated = data.find((r: any) => r.id === 1);
      expect(updated?.size).toBe(200);
      expect(updated?.side).toBe('Buy');
      expect(snapshot.counter).toBe(2);
    });
  });

  describe('newSnapshot', () => {
    it('with keys: converts array to indexed map', () => {
      const data = [{ id: 1, side: 'Buy' }, { id: 2, side: 'Sell' }];
      const snapshot = createSnapshot(true, data);
      newSnapshot(snapshot);
      expect(snapshot.data instanceof Map).toBe(true);
      const map = snapshot.data as SnapshotIndexedData;
      expect(map.size).toBe(2);
      expect(map.get('1')).toEqual({ id: 1, side: 'Buy' });
    });

    it('without keys: keeps array unchanged', () => {
      const data = [{ id: 1, side: 'Buy' }];
      const snapshot = createSnapshot(false, data);
      newSnapshot(snapshot);
      expect(Array.isArray(snapshot.data)).toBe(true);
      expect(snapshot.data).toEqual(data);
    });
  });
});
