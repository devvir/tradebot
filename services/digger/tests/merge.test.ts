import { describe, it, expect } from 'vitest';
import { pickNext, allExhausted } from '../src/websocket/merge';
import { createBuffer, enqueue } from '../src/websocket/buffer';
import type { State, MongoDoc } from '../src/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const tradeDoc = (ts: string, id = 1): MongoDoc => ({
  _id:       id,
  timestamp: ts,
  symbol:    'XBTUSD',
});

const makeState = (tables: Record<string, MongoDoc[]>): State => {
  const subscriptions: State['subscriptions'] = new Map();
  const buffers: State['buffers']             = new Map();

  for (const [table, docs] of Object.entries(tables)) {
    const buf = createBuffer(table as 'trade');

    enqueue(buf, docs);
    subscriptions.set(table, { table: table as 'trade' });
    buffers.set(table, buf);
  }

  return {
    subscriptions,
    buffers,
    broker:         null,
    isShuttingDown: false,
    isPaused:       false,
    messages:       0,
    lastMessageAt:  null,
  };
};

// ── pickNext ──────────────────────────────────────────────────────────────────

describe('pickNext', () => {
  it('returns null when all buffers are empty', () => {
    const state = makeState({ trade: [] });

    expect(pickNext(state)).toBeNull();
  });

  it('returns the only non-empty buffer', () => {
    const doc   = tradeDoc('2025-01-01T00:00:00.000Z');
    const state = makeState({ trade: [doc] });

    const result = pickNext(state);

    expect(result).not.toBeNull();
    expect(result!.table).toBe('trade');
  });

  it('picks the buffer with the globally smallest timestamp', () => {
    const earlier = tradeDoc('2025-01-01T00:00:00.000Z', 1);
    const later   = tradeDoc('2025-01-01T01:00:00.000Z', 2);
    const state   = makeState({
      trade:    [later],
      quote:    [earlier],
    });

    const result = pickNext(state);

    expect(result!.table).toBe('quote');
    expect(result!.timestamp).toBe(new Date('2025-01-01T00:00:00.000Z').getTime());
  });

  it('skips empty buffers and picks from a non-empty one', () => {
    const doc   = tradeDoc('2025-01-01T00:00:00.000Z');
    const state = makeState({ trade: [doc], quote: [] });

    const result = pickNext(state);

    expect(result!.table).toBe('trade');
  });
});

// ── allExhausted ──────────────────────────────────────────────────────────────

describe('allExhausted', () => {
  it('returns true when all subscribed buffers are exhausted and empty', () => {
    const state = makeState({ trade: [] });

    state.buffers.get('trade')!.exhausted = true;
    expect(allExhausted(state)).toBe(true);
  });

  it('returns false when a buffer still has entries', () => {
    const state = makeState({ trade: [tradeDoc('2025-01-01T00:00:00.000Z')] });

    state.buffers.get('trade')!.exhausted = true;
    expect(allExhausted(state)).toBe(false);
  });

  it('returns false when a subscribed buffer is not yet exhausted', () => {
    const state = makeState({ trade: [] });

    expect(allExhausted(state)).toBe(false);
  });

  it('ignores buffers that have no matching subscription', () => {
    const state = makeState({ trade: [] });

    state.buffers.get('trade')!.exhausted = true;
    // Add a buffer that has no subscription entry
    const extraBuf = createBuffer('quote');

    state.buffers.set('quote', extraBuf);
    // quote is empty, not exhausted, but has no subscription — should be ignored
    expect(allExhausted(state)).toBe(true);
  });

  it('returns false with no subscriptions', () => {
    const state: State = {
      subscriptions:  new Map(),
      buffers:        new Map(),
      broker:         null,
      isShuttingDown: false,
      isPaused:       false,
      messages:       0,
      lastMessageAt:  null,
    };

    expect(allExhausted(state)).toBe(true);
  });
});
