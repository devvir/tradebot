import { describe, it, expect } from 'vitest';
import { createBuffer, enqueue, dequeue, hasNext, peek, needsRefetch } from '../src/websocket/buffer';

// ── createBuffer ──────────────────────────────────────────────────────────────

describe('createBuffer', () => {
  it('creates an empty buffer with correct initial shape', () => {
    const buf = createBuffer('trade');

    expect(buf.table).toBe('trade');
    expect(buf.entries).toEqual([]);
    expect(buf.cursor).toBeNull();
    expect(buf.isFetching).toBe(false);
    expect(buf.exhausted).toBe(false);
  });
});

// ── enqueue ───────────────────────────────────────────────────────────────────

describe('enqueue', () => {
  it('appends docs to the buffer', () => {
    const buf  = createBuffer('trade');
    const docs = [{ _id: 1, timestamp: 't1' }, { _id: 2, timestamp: 't2' }];

    enqueue(buf, docs);

    expect(buf.entries).toHaveLength(2);
    expect(buf.entries[0]._id).toBe(1);
    expect(buf.entries[1]._id).toBe(2);
  });

  it('appends to existing entries', () => {
    const buf = createBuffer('trade');

    enqueue(buf, [{ _id: 1 }]);
    enqueue(buf, [{ _id: 2 }, { _id: 3 }]);

    expect(buf.entries).toHaveLength(3);
    expect(buf.entries[2]._id).toBe(3);
  });
});

// ── dequeue ───────────────────────────────────────────────────────────────────

describe('dequeue', () => {
  it('removes n entries from the front', () => {
    const buf = createBuffer('trade');

    enqueue(buf, [{ _id: 1 }, { _id: 2 }, { _id: 3 }]);
    dequeue(buf, 2);

    expect(buf.entries).toHaveLength(1);
    expect(buf.entries[0]._id).toBe(3);
  });

  it('removing all entries leaves an empty buffer', () => {
    const buf = createBuffer('trade');

    enqueue(buf, [{ _id: 1 }]);
    dequeue(buf, 1);

    expect(buf.entries).toHaveLength(0);
  });
});

// ── hasNext ───────────────────────────────────────────────────────────────────

describe('hasNext', () => {
  it('returns false for an empty buffer', () => {
    expect(hasNext(createBuffer('trade'))).toBe(false);
  });

  it('returns true when entries exist', () => {
    const buf = createBuffer('trade');

    enqueue(buf, [{ _id: 1 }]);
    expect(hasNext(buf)).toBe(true);
  });
});

// ── peek ──────────────────────────────────────────────────────────────────────

describe('peek', () => {
  it('returns undefined on empty buffer', () => {
    expect(peek(createBuffer('trade'))).toBeUndefined();
  });

  it('returns the first entry without removing it', () => {
    const buf = createBuffer('trade');

    enqueue(buf, [{ _id: 1 }, { _id: 2 }]);
    expect(peek(buf)?._id).toBe(1);
    expect(buf.entries).toHaveLength(2);
  });
});

// ── needsRefetch ──────────────────────────────────────────────────────────────

describe('needsRefetch', () => {
  it('returns true when below watermark and not fetching or exhausted', () => {
    const buf = createBuffer('trade');

    enqueue(buf, [{ _id: 1 }, { _id: 2 }]);
    expect(needsRefetch(buf, 5_000)).toBe(true);
  });

  it('returns false when already fetching', () => {
    const buf = createBuffer('trade');

    buf.isFetching = true;
    expect(needsRefetch(buf, 5_000)).toBe(false);
  });

  it('returns false when exhausted', () => {
    const buf = createBuffer('trade');

    buf.exhausted = true;
    expect(needsRefetch(buf, 5_000)).toBe(false);
  });

  it('returns false when at or above watermark', () => {
    const buf = createBuffer('trade');

    enqueue(buf, Array.from({ length: 5_001 }, (_, i) => ({ _id: i })));
    expect(needsRefetch(buf, 5_000)).toBe(false);
  });
});
