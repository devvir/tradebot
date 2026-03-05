import { describe, it, expect, beforeEach } from 'vitest';
import { EPOCH_2000_MS, ACTION_ID, generateId, getSlot, moveToNextSlot, _clearSlot, _resetSlot } from '../src/documentId';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** tsMs relative to EPOCH_2000_MS for the current second. */
const nowTsMs = () => Date.now() - EPOCH_2000_MS;

const PARTITION_SIZE = 256;

const id = (tsMs: number, slot: number, localCounter: number, action: keyof typeof ACTION_ID) =>
  tsMs * 4096 + (slot * PARTITION_SIZE + localCounter) * 4 + ACTION_ID[action];

// ── Tests ─────────────────────────────────────────────────────────────────────
// Each test uses a unique table name to avoid bucket state collisions between tests.

describe('generateId', () => {
  beforeEach(() => {
    _resetSlot();
  });

  it('first message at a key: discriminator 0 in slot 0', () => {
    const tsMs = nowTsMs();
    expect(generateId('tbl-a', 'insert', tsMs)).toBe(id(tsMs, 0, 0, 'insert'));
  });

  it('second message at same key: local counter 1', () => {
    const tsMs = nowTsMs();
    generateId('tbl-b', 'insert', tsMs);
    expect(generateId('tbl-b', 'insert', tsMs)).toBe(id(tsMs, 0, 1, 'insert'));
  });

  it('third message at same key: local counter 2', () => {
    const tsMs = nowTsMs();
    generateId('tbl-c', 'insert', tsMs);
    generateId('tbl-c', 'insert', tsMs);
    expect(generateId('tbl-c', 'insert', tsMs)).toBe(id(tsMs, 0, 2, 'insert'));
  });

  it('different action at same tsMs: independent counter', () => {
    const tsMs = nowTsMs();
    generateId('tbl-d', 'insert', tsMs);
    expect(generateId('tbl-d', 'update', tsMs)).toBe(id(tsMs, 0, 0, 'update'));
  });

  it('different table at same tsMs: independent counter', () => {
    const tsMs = nowTsMs();
    generateId('tbl-e1', 'insert', tsMs);
    expect(generateId('tbl-e2', 'insert', tsMs)).toBe(id(tsMs, 0, 0, 'insert'));
  });

  it('action bits are encoded correctly for all 4 actions', () => {
    const tsMs = nowTsMs();
    expect(generateId('tbl-f', 'partial', tsMs) & 0b11).toBe(0);
    expect(generateId('tbl-f', 'insert',  tsMs) & 0b11).toBe(1);
    expect(generateId('tbl-f', 'update',  tsMs) & 0b11).toBe(2);
    expect(generateId('tbl-f', 'delete',  tsMs) & 0b11).toBe(3);
  });

  it('overflow: local counter >= 256 seeds next-ms bucket in same slot', () => {
    const tsMs = nowTsMs();

    // Burn through local counters 0..255
    for (let i = 0; i < 256; i++) generateId('tbl-g', 'insert', tsMs);

    // The 257th call (localCounter=256) should spill: effective _id at tsMs+1, slot 0, counter 0
    expect(generateId('tbl-g', 'insert', tsMs)).toBe(id(tsMs + 1, 0, 0, 'insert'));

    // Next real message at tsMs+1 gets localCounter=1 (0 was taken by overflow)
    expect(generateId('tbl-g', 'insert', tsMs + 1)).toBe(id(tsMs + 1, 0, 1, 'insert'));
  });

  it('cleanup: after slot is cleared, key is treated as new', () => {
    const tsMs = nowTsMs();
    generateId('tbl-h', 'insert', tsMs); // prime counter to 0

    _clearSlot(tsMs); // simulate the cleanup interval firing

    // Same key now treated as fresh — gets local counter 0 again
    expect(generateId('tbl-h', 'insert', tsMs)).toBe(id(tsMs, 0, 0, 'insert'));
  });
});

describe('slot partitioning', () => {
  beforeEach(() => {
    _resetSlot();
  });

  it('starts at slot 0', () => {
    expect(getSlot()).toBe(0);
  });

  it('moveToNextSlot advances circularly', () => {
    moveToNextSlot();
    expect(getSlot()).toBe(1);
    moveToNextSlot();
    expect(getSlot()).toBe(2);
    moveToNextSlot();
    expect(getSlot()).toBe(3);
    moveToNextSlot();
    expect(getSlot()).toBe(0);
  });

  it('different slots produce non-overlapping discriminators', () => {
    const tsMs = nowTsMs();

    // Simulate 4 independent instances by clearing bucket state between slot changes
    const id0 = generateId('tbl-slot', 'insert', tsMs);

    _clearSlot(tsMs);
    moveToNextSlot();
    const id1 = generateId('tbl-slot', 'insert', tsMs);

    _clearSlot(tsMs);
    moveToNextSlot();
    const id2 = generateId('tbl-slot', 'insert', tsMs);

    _clearSlot(tsMs);
    moveToNextSlot();
    const id3 = generateId('tbl-slot', 'insert', tsMs);

    // All 4 ids must be distinct — each slot uses a different partition of the discriminator
    const ids = new Set([id0, id1, id2, id3]);
    expect(ids.size).toBe(4);

    // Verify discriminator ranges: slot N uses [N*256, (N+1)*256)
    const disc = (genId: number) => Math.floor((genId % 4096) / 4);
    expect(disc(id0)).toBe(0);    // slot 0, counter 0
    expect(disc(id1)).toBe(256);  // slot 1, counter 0
    expect(disc(id2)).toBe(512);  // slot 2, counter 0
    expect(disc(id3)).toBe(768);  // slot 3, counter 0
  });
});
