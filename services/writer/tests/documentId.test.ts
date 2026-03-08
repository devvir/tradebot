import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import generateId, { ACTION_ID, _getInstanceSlot, moveToNextSlot, _clearCacheSlot, _resetInstanceSlot } from '../src/documentId';
import type { BitmexAction } from '@tradebot/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const NUM_DISCRIMINATORS = 128; // 512 / 4 instances

/**
 * Calculate expected ID matching the actual generateId formula.
 * timestampSlot = (ts & 0x1FFFFFFFFFFn) << 12n (as Number)
 * ID = timestampSlot + (discriminator * 4) + action
 * where discriminator = count + (slot * NUM_DISCRIMINATORS) - 1
 */
const id = (ts: number, count: number, slot: number, action: BitmexAction) => {
  const discriminator = (count + (slot * NUM_DISCRIMINATORS)) - 1;
  const timestampSlot = Number((BigInt(ts) & 0x1FFFFFFFFFFn) << 12n);
  return timestampSlot + (discriminator * 4) + ACTION_ID[action];
};

// ── Tests ─────────────────────────────────────────────────────────────────────
// Each test uses a unique table name to avoid bucket state collisions between tests.

describe('generateId', () => {
  beforeEach(() => {
    _resetInstanceSlot();
  });

  it('first message at a key: discriminator 1 in slot 0 (count increments before use)', () => {
    const ts = 1_000_000; // Use fixed timestamp to avoid cache pollution
    const result = generateId({ table: 'tbl-a', action: 'insert' } as any, ts);
    expect(result).toBe(id(ts, 1, 0, 'insert'));
  });

  it('second message at same key: local counter 2', () => {
    const ts = 2_000_000;
    generateId({ table: 'tbl-b', action: 'insert' } as any, ts);
    const result = generateId({ table: 'tbl-b', action: 'insert' } as any, ts);
    expect(result).toBe(id(ts, 2, 0, 'insert'));
  });

  it('third message at same key: local counter 3', () => {
    const ts = 3_000_000;
    generateId({ table: 'tbl-c', action: 'insert' } as any, ts);
    generateId({ table: 'tbl-c', action: 'insert' } as any, ts);
    const result = generateId({ table: 'tbl-c', action: 'insert' } as any, ts);
    expect(result).toBe(id(ts, 3, 0, 'insert'));
  });

  it('different action at same ts: independent counter', () => {
    const ts = 4_000_000;
    generateId({ table: 'tbl-d', action: 'insert' } as any, ts);
    const result = generateId({ table: 'tbl-d', action: 'update' } as any, ts);
    expect(result).toBe(id(ts, 1, 0, 'update'));
  });

  it('different table at same ts: independent counter', () => {
    const ts = 5_000_000;
    generateId({ table: 'tbl-e1', action: 'insert' } as any, ts);
    const result = generateId({ table: 'tbl-e2', action: 'insert' } as any, ts);
    expect(result).toBe(id(ts, 1, 0, 'insert'));
  });

  it('action bits are encoded correctly for all 4 actions', () => {
    const ts = 6_000_000;
    const actionIds = ['partial', 'insert', 'update', 'delete'] as const;
    for (let i = 0; i < actionIds.length; i++) {
      const action = actionIds[i];
      const generatedId = generateId({ table: `tbl-act-${i}`, action } as any, ts);
      expect((generatedId & 0b11) === i, `action ${action} should encode as ${i}, got ${generatedId & 0b11}`).toBe(true);
    }
  });

  it('overflow: count >= 128 (NUM_DISCRIMINATORS=128) borrows from next timestamp', () => {
    const ts = 7_000_999; // Near second boundary to avoid cache slot collision

    // Burn through counters 1..128 (NUM_DISCRIMINATORS=128)
    for (let i = 0; i < 128; i++) generateId({ table: 'tbl-g', action: 'insert' } as any, ts);

    // The 257th call should overflow and recurse to ts+1 (next second)
    const result = generateId({ table: 'tbl-g', action: 'insert' } as any, ts);
    expect(result).toBe(id(ts + 1, 1, 0, 'insert'));
  });

  it('cleanup: after slot is cleared, key is treated as new', () => {
    const ts = 8_000_000;
    generateId({ table: 'tbl-h', action: 'insert' } as any, ts);

    _clearCacheSlot(ts);

    // Same key now treated as fresh — counter increments from 0 to 1
    const result = generateId({ table: 'tbl-h', action: 'insert' } as any, ts);
    expect(result).toBe(id(ts, 1, 0, 'insert'));
  });
});

describe('slot partitioning', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetInstanceSlot();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts at slot 0', () => {
    expect(_getInstanceSlot()).toBe(0);
  });

  it('moveToNextSlot advances circularly', async () => {
    let p = moveToNextSlot();
    vi.runAllTimers();
    await p;
    expect(_getInstanceSlot()).toBe(1);

    p = moveToNextSlot();
    vi.runAllTimers();
    await p;
    expect(_getInstanceSlot()).toBe(2);

    p = moveToNextSlot();
    vi.runAllTimers();
    await p;
    expect(_getInstanceSlot()).toBe(3);

    p = moveToNextSlot();
    vi.runAllTimers();
    await p;
    expect(_getInstanceSlot()).toBe(0);
  });

  it('different slots produce different base discriminators', async () => {
    const ts = 7_000_000;
    const doc = { table: 'tbl-slots', action: 'insert' };

    // Slot 0: first call
    const id0 = generateId(doc as any, ts);
    expect(_getInstanceSlot()).toBe(0);

    // Move to slot 1, clear cache to reset counter
    _clearCacheSlot(ts);
    const p = moveToNextSlot();
    vi.runAllTimers();
    await p;
    expect(_getInstanceSlot()).toBe(1);

    // Slot 1: same table/action/ts, but different slot
    const id1 = generateId(doc as any, ts);

    // IDs should be different because discriminators use different slot offsets
    expect(id0).not.toBe(id1);

    // Discriminator difference should be IDS_PER_MS * 4
    expect(id1 - id0).toBe(NUM_DISCRIMINATORS * 4);
  });
});
