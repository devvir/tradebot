import { describe, it, expect } from 'vitest';
import { prune, _test_extractTimestampMs, _test_contentKey } from '../../../../src/tools/data/dedup/prune';
import type { Message } from '../../../../src/tools/data/types';
import type { PruneStats } from '../../../../src/tools/data/dedup/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Timestamp is at column index 2: `_date_, _action_, timestamp, symbol, val`
 * Matches instrument / orderBookL2 layout.
 */
const TS_IDX = 2;

function msg(date: string, ts: string, val: string, action = 'update'): Message {
  return {
    rows:      [`${date},${action},${ts},SYM,${val}`],
    date,
    action,
    timestamp: null,
  };
}

function partial(date: string, ts: string): Message {
  return {
    rows:      [`${date},partial,${ts},SYM,`],
    date,
    action:    'partial',
    timestamp: null,
  };
}

function stats(): PruneStats {
  return { kept: 0, dropped: 0 };
}

async function* batches(...groups: Message[][]): AsyncGenerator<Message[]> {
  for (const g of groups) yield g;
}

async function collect(gen: AsyncGenerator<Message[]>): Promise<Message[]> {
  const out: Message[] = [];

  for await (const batch of gen) {
    for (const m of batch) out.push(m);
  }

  return out;
}

function addMs(base: string, ms: number): string {
  return new Date(Date.parse(base) + ms).toISOString();
}

// ── Pass-through ──────────────────────────────────────────────────────────────

describe('pass-through', () => {
  it('unique messages all pass through', async () => {
    const base = '2026-01-01T00:00:00.000Z';
    const s    = stats();
    const out  = await collect(prune(batches([
      msg(base, base, 'A'),
      msg(base, addMs(base, 100), 'B'),
      msg(base, addMs(base, 200), 'C'),
    ]), 1000, s, TS_IDX));

    expect(out).toHaveLength(3);
    expect(s.kept).toBe(3);
    expect(s.dropped).toBe(0);
  });

  it('empty stream returns nothing', async () => {
    const s = stats();

    expect(await collect(prune(batches([]), 1000, s, TS_IDX))).toHaveLength(0);
    expect(s.kept + s.dropped).toBe(0);
  });
});

// ── Partials ──────────────────────────────────────────────────────────────────

describe('partials', () => {
  it('a partial is deduped like any message and advances the clock', async () => {
    const base  = '2026-01-01T00:00:00.000Z';
    const ahead = addMs(base, 2000);
    const s     = stats();

    // First partial kept (clock=base). A delta at ahead advances clock to base+2000.
    // The duplicate partial (same content, ts=base) is now > threshold behind → DROPPED.
    const out = await collect(prune(batches([
      partial(base,  base),   // kept, clock=base
      msg(base,      ahead, 'X'),  // kept, clock=base+2000
      partial(ahead, base),   // dup of first partial, ts=base < clock(2000)-1000 → DROPPED
    ]), 1000, s, TS_IDX));

    expect(out).toHaveLength(2);
    expect(s.dropped).toBe(1);
  });

  it('a duplicate partial within threshold is kept (legit, not yet stale)', async () => {
    const base = '2026-01-01T00:00:00.000Z';
    const s    = stats();

    // Two identical partials at the same timestamp, clock not advanced past threshold → both kept.
    const out = await collect(prune(batches([
      partial(base, base),
      partial(base, base),
    ]), 1000, s, TS_IDX));

    expect(out).toHaveLength(2);
    expect(s.dropped).toBe(0);
  });

  it('a re-partial at a fresh timestamp (reconnect) has a different key and is kept', async () => {
    const base  = '2026-01-01T00:00:00.000Z';
    const later = addMs(base, 5000);
    const s     = stats();

    // Reconnect snapshot carries a new timestamp → different content key → never a duplicate.
    const out = await collect(prune(batches([
      partial(base,  base),
      partial(later, later),
    ]), 1000, s, TS_IDX));

    expect(out).toHaveLength(2);
    expect(s.dropped).toBe(0);
  });
});

// ── Clock and drop condition ──────────────────────────────────────────────────

describe('clock and drop condition', () => {
  it('duplicate is NOT dropped while clock has not advanced past ts + threshold', async () => {
    const base = '2026-01-01T00:00:00.000Z';
    const s    = stats();

    // m1 at ts=base, clock=base. m2 (dup) also at ts=base.
    // base < base - 1000 = base-1000ms? No → kept.
    const out = await collect(prune(batches([
      msg(base, base, 'X'),
      msg(base, base, 'X'),
    ]), 1000, s, TS_IDX));

    expect(out).toHaveLength(2);
    expect(s.dropped).toBe(0);
  });

  it('duplicate IS dropped once clock has advanced past ts + threshold', async () => {
    const base  = '2026-01-01T00:00:00.000Z';
    const ahead = addMs(base, 2000);
    const s     = stats();

    // Primary stream: m1 at ts=base, m_ahead at ts=base+2000ms (advances clock to base+2000).
    // Ghost dup: m1 again at ts=base. clock=base+2000, base < base+2000-1000=base+1000 → DROP.
    const out = await collect(prune(batches([
      msg(base,   base,   'X'),  // kept, clock = base
      msg(ahead,  ahead,  'Y'),  // kept, clock = base+2000
      msg(ahead,  base,   'X'),  // dup of m1, ts=base < clock(2000)-threshold(1000)=base+1000 → dropped
    ]), 1000, s, TS_IDX));

    expect(out).toHaveLength(2);
    expect(s.dropped).toBe(1);
  });

  it('duplicate exactly at the threshold boundary (ts == clock - threshold) is dropped', async () => {
    const base   = '2026-01-01T00:00:00.000Z';
    const ahead  = addMs(base, 1000);
    const s      = stats();

    // clock = base+1000, threshold = 1000. base < base+1000-1000 = base → false (not strictly less)
    // So exactly at boundary: NOT dropped (< not <=).
    const out = await collect(prune(batches([
      msg(base,  base,  'X'),
      msg(ahead, ahead, 'Y'),  // clock = base+1000
      msg(ahead, base,  'X'),  // ts=base, clock-threshold=base → base < base is false → kept
    ]), 1000, s, TS_IDX));

    expect(out).toHaveLength(3);
    expect(s.dropped).toBe(0);
  });

  it('duplicate 1ms past the threshold boundary is dropped', async () => {
    const base   = '2026-01-01T00:00:00.000Z';
    const ahead  = addMs(base, 1001);
    const s      = stats();

    // clock = base+1001, threshold = 1000. base < base+1001-1000 = base+1 → true → DROP.
    const out = await collect(prune(batches([
      msg(base,  base,  'X'),
      msg(ahead, ahead, 'Y'),  // clock = base+1001
      msg(ahead, base,  'X'),  // ts=base < base+1 → dropped
    ]), 1000, s, TS_IDX));

    expect(out).toHaveLength(2);
    expect(s.dropped).toBe(1);
  });

  it('clock is monotonic — out-of-order messages do not decrease it', async () => {
    const base  = '2026-01-01T00:00:00.000Z';
    const t200  = addMs(base, 200);
    const t2000 = addMs(base, 2000);
    const s     = stats();

    // Process in order: t2000 (clock=2000), then t200 (out-of-order, clock stays 2000).
    // Dup of t200 message arrives; ts=200 < clock(2000)-threshold(1000)=1000 → DROP.
    const out = await collect(prune(batches([
      msg(base,  t2000, 'Z'),  // clock = base+2000
      msg(base,  t200,  'X'),  // out-of-order, clock stays 2000; kept, hash stored
      msg(base,  t200,  'X'),  // dup, ts=200 < 2000-1000=1000 → dropped
    ]), 1000, s, TS_IDX));

    expect(out).toHaveLength(2);
    expect(s.dropped).toBe(1);
  });

  it('a recurrence at a different timestamp is a different event (different key), never a duplicate', async () => {
    const base = '2026-01-01T00:00:00.000Z';
    const t1   = base;
    const t2   = addMs(base, 500);
    const t3   = addMs(base, 1000);
    const s    = stats();

    // price=100 at t1, price=101 at t2, price=100 again at t3.
    // t3 carries a different ts field → different content key → not a duplicate.
    // (This is NOT a same-ms oscillation — that case is below.)
    const out = await collect(prune(batches([
      msg(base, t1, '100'),
      msg(base, t2, '101'),
      msg(base, t3, '100'),  // different timestamp → different key → kept
    ]), 1000, s, TS_IDX));

    expect(out).toHaveLength(3);
    expect(s.dropped).toBe(0);
  });

  it('a legitimate same-millisecond oscillation (same timestamp, same content) is kept', async () => {
    const base = '2026-01-01T00:00:00.000Z';
    const s    = stats();

    // A→B→A within one ms: the two A messages share the same timestamp AND the
    // same content key — identical hashes. They are kept because the clock has
    // not advanced past their timestamp by more than threshold. This is exactly
    // why content-only dedup is wrong and the clock+threshold is needed.
    const out = await collect(prune(batches([
      msg(base, base, '100'),  // A
      msg(base, base, '101'),  // B
      msg(base, base, '100'),  // A again — same ts, same key as first → still kept
    ]), 1000, s, TS_IDX));

    expect(out).toHaveLength(3);
    expect(s.dropped).toBe(0);
  });
});

// ── Missing / invalid timestamp ───────────────────────────────────────────────

describe('missing timestamp', () => {
  it('message with empty timestamp passes through without dedup check', async () => {
    const base = '2026-01-01T00:00:00.000Z';
    const s    = stats();

    const noTs: Message = { rows: [`${base},update,,SYM,X`], date: base, action: 'update', timestamp: null };

    const out = await collect(prune(batches([noTs, noTs]), 1000, s, TS_IDX));

    expect(out).toHaveLength(2);
    expect(s.dropped).toBe(0);
  });
});

// ── contentKey (length-based hashing) ──────────────────────────────────────────

describe('contentKey', () => {
  function bigPartial(date: string, ts: string, n: number, tail = 'x'): Message {
    const rows = [`${date},partial,SYM,${ts},${tail}`];

    for (let i = 0; i < n; i++) rows.push(`,,SYM,${ts},lvl${i}`);

    return { rows, date, action: 'partial', timestamp: null };
  }

  it('keys a large (>250 B) message by a compact hash, not the full content', () => {
    const base = '2026-01-01T00:00:00.000Z';
    const key  = _test_contentKey(bigPartial(base, base, 50_000));

    // ~50k rows would be a multi-MB join; the hashed key is tiny and \0-prefixed.
    expect(key.length).toBeLessThan(32);
    expect(key.startsWith('\x00')).toBe(true);
  });

  it('identical large messages hash equal; a different snapshot hashes differently', () => {
    const base  = '2026-01-01T00:00:00.000Z';
    const later = '2026-01-01T00:00:05.000Z';

    expect(_test_contentKey(bigPartial(base, base, 1000))).toBe(_test_contentKey(bigPartial(base, base, 1000)));
    expect(_test_contentKey(bigPartial(base, base, 1000))).not.toBe(_test_contentKey(bigPartial(base, later, 1000))); // fresh ts
    expect(_test_contentKey(bigPartial(base, base, 1000))).not.toBe(_test_contentKey(bigPartial(base, base, 1001))); // extra level
  });

  it('a short single-row message keeps its full literal key', () => {
    const base = '2026-01-01T00:00:00.000Z';
    const m: Message = { rows: [`${base},update,SYM,${base},9`], date: base, action: 'update', timestamp: null };

    const key = _test_contentKey(m);

    expect(key.startsWith('\x00')).toBe(false);
    expect(key).toContain('update,SYM');
  });

  it('a short multi-row message (≤500 B) still keeps its full literal key', () => {
    const base = '2026-01-01T00:00:00.000Z';
    const m: Message = { rows: [`${base},update,SYM,${base},9`, `,,SYM,${base},10`], date: base, action: 'update', timestamp: null };

    const key = _test_contentKey(m);

    expect(key.startsWith('\x00')).toBe(false);
    expect(key).toContain('update,SYM');
  });

  it('a long single-row message (>500 B) falls back to a hash', () => {
    const base = '2026-01-01T00:00:00.000Z';
    const m: Message = { rows: [`${base},update,SYM,${base},${'9'.repeat(600)}`], date: base, action: 'update', timestamp: null };

    const key = _test_contentKey(m);

    expect(key.startsWith('\x00')).toBe(true);
  });
});

// ── extractTimestampMs ────────────────────────────────────────────────────────

describe('extractTimestampMs', () => {
  it('extracts the value at the given column index', () => {
    const row = '2026-01-01T00:00:00.000Z,insert,2026-01-01T12:34:56.789Z,SYM,val';

    expect(_test_extractTimestampMs(row, 2)).toBe(Date.parse('2026-01-01T12:34:56.789Z'));
  });

  it('returns NaN for an empty field', () => {
    const row = '2026-01-01T00:00:00.000Z,insert,,SYM,val';

    expect(_test_extractTimestampMs(row, 2)).toBeNaN();
  });
});

// ── Window rotation ───────────────────────────────────────────────────────────

describe('window rotation', () => {
  it('a key is still remembered after one rotation (it lives in the prev set)', async () => {
    // windowSize=2: k0, k1 fill cur → rotate (prev={k0,k1}, cur={}).
    // A k0 duplicate above threshold is still seen via prev → DROPPED.
    const base  = '2026-01-01T00:00:00.000Z';
    const ahead = addMs(base, 2000);
    const s     = stats();

    const out = await collect(prune(batches([
      msg(base,  base,  '0'),  // cur={k0}
      msg(base,  base,  '1'),  // cur={k0,k1} → rotate: prev={k0,k1}, cur={}
      msg(base,  ahead, 'Z'),  // clock=ahead; cur={Z}
      msg(base,  base,  '0'),  // seen via prev; base < ahead-1000 → DROPPED
    ]), 1000, s, TS_IDX, 2));

    expect(s.dropped).toBe(1);
    expect(out).toHaveLength(3);
  });

  it('a key is forgotten after two rotations (out of both sets)', async () => {
    // windowSize=2: k0,k1 fill → rotate1 (prev={k0,k1}). k2,k3 fill → rotate2
    // (prev={k2,k3}, k0/k1 discarded). A k0 duplicate is no longer seen → kept.
    const base  = '2026-01-01T00:00:00.000Z';
    const ahead = addMs(base, 2000);
    const s     = stats();

    const out = await collect(prune(batches([
      msg(base,  base,  '0'),  // cur={k0}
      msg(base,  base,  '1'),  // cur={k0,k1} → rotate1: prev={k0,k1}, cur={}
      msg(base,  base,  '2'),  // cur={k2}
      msg(base,  base,  '3'),  // cur={k2,k3} → rotate2: prev={k2,k3}, cur={} (k0,k1 gone)
      msg(base,  ahead, 'Z'),  // clock=ahead; cur={Z}
      msg(base,  base,  '0'),  // not in cur or prev → kept (no longer remembered)
    ]), 1000, s, TS_IDX, 2));

    expect(s.dropped).toBe(0);
    expect(out).toHaveLength(6);
  });
});
