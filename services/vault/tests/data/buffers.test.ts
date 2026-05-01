import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { buffers, _test_reset, _test_BATCH_SIZE, _test_STALE_THRESHOLD } from '../../src/data/buffers';

beforeEach(() => _test_reset());
afterEach(() => vi.useRealTimers());

// ── Singleton behaviour ───────────────────────────────────────────────────────

describe('buffers.get — identity', () => {
  it('returns a buffer with the correct table and filename', () => {
    const buf = buffers.get('trade', '2023-02-01');
    expect(buf.table).toBe('trade');
    expect(buf.filename).toBe('2023-02-01');
  });

  it('returns the same instance on subsequent calls', () => {
    expect(buffers.get('trade', '2023-02-01')).toBe(buffers.get('trade', '2023-02-01'));
  });

  it('returns distinct instances for different table/filename pairs', () => {
    const a = buffers.get('trade', '2023-02-01');
    const b = buffers.get('quote', '2023-02-01');
    const c = buffers.get('trade', '2023-02-02');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('treats a suffixed filename as a separate buffer from the bare date', () => {
    const bare     = buffers.get('trade', '2023-02-01');
    const suffixed = buffers.get('trade', '2023-02-01.snapshot');
    expect(bare).not.toBe(suffixed);
    expect(suffixed.filename).toBe('2023-02-01.snapshot');
  });
});

// ── Buffer API ────────────────────────────────────────────────────────────────

describe('buffer.push / count', () => {
  it('starts empty', () => {
    expect(buffers.get('trade', '2023-02-01').count()).toBe(0);
  });

  it('counts pushed lines', () => {
    const buf = buffers.get('trade', '2023-02-01');
    buf.push('a,b,c');
    buf.push('d,e,f');
    expect(buf.count()).toBe(2);
  });
});

describe('buffer.pushMany', () => {
  it('adds all lines at once', () => {
    const buf = buffers.get('trade', '2023-02-01');
    buf.pushMany(['a', 'b', 'c']);
    expect(buf.count()).toBe(3);
  });
});

describe('buffer.flush', () => {
  it('returns all buffered lines in FIFO order', () => {
    const buf = buffers.get('trade', '2023-02-01');
    buf.push('a');
    buf.push('b');
    expect(buf.flush()).toEqual(['a', 'b']);
  });

  it('clears the buffer after flush', () => {
    const buf = buffers.get('trade', '2023-02-01');
    buf.push('a');
    buf.flush();
    expect(buf.count()).toBe(0);
  });

  it('returns an empty array when flushed with nothing buffered', () => {
    expect(buffers.get('trade', '2023-02-01').flush()).toEqual([]);
  });

  it('persists state across get calls', () => {
    buffers.get('trade', '2023-02-01').push('x');
    expect(buffers.get('trade', '2023-02-01').count()).toBe(1);
  });

  it('updates lastFlushed on flush', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    const buf = buffers.get('trade', '2023-02-01');
    const t0  = buf.lastFlushed();

    vi.setSystemTime(new Date('2024-01-01T00:00:05Z'));
    buf.push('a');
    buf.flush();

    expect(buf.lastFlushed()).toBeGreaterThan(t0);
  });
});

// ── flushReady ────────────────────────────────────────────────────────────────

describe('buffers.flushReady', () => {
  it('returns nothing when all buffers are empty', () => {
    buffers.get('trade', '2023-02-01');
    expect(buffers.flushReady()).toEqual([]);
  });

  it('skips non-empty buffers below the size and time thresholds', () => {
    const buf = buffers.get('trade', '2023-02-01');
    buf.push('a');
    expect(buffers.flushReady()).toEqual([]);
    expect(buf.count()).toBe(1);
  });

  it('flushes a buffer that has reached BATCH_SIZE', () => {
    const buf  = buffers.get('trade', '2023-02-01');
    const size = _test_BATCH_SIZE();

    for (let i = 0; i < size; i++) buf.push(`row-${i}`);

    const result = buffers.flushReady();
    expect(result).toHaveLength(1);
    expect(result[0]!.table).toBe('trade');
    expect(result[0]!.filename).toBe('2023-02-01');
    expect(result[0]!.lines.length).toBe(size);
    expect(buf.count()).toBe(0);
  });

  it('flushes a stale buffer (time threshold)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

    const buf = buffers.get('trade', '2023-02-01');
    buf.push('a');

    vi.setSystemTime(Date.now() + _test_STALE_THRESHOLD() + 1);

    const result = buffers.flushReady();
    expect(result).toHaveLength(1);
    expect(result[0]!.lines).toEqual(['a']);
  });

  it('does not double-flush a buffer in the same tick', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

    const buf  = buffers.get('trade', '2023-02-01');
    const size = _test_BATCH_SIZE();

    for (let i = 0; i < size; i++) buf.push(`r${i}`);

    // First call flushes for size; second call should see lastFlushed updated
    // and not fire the time trigger.
    buffers.flushReady();
    expect(buffers.flushReady()).toEqual([]);
  });
});

// ── flushAll ──────────────────────────────────────────────────────────────────

describe('buffers.flushAll', () => {
  it('returns every non-empty buffer regardless of thresholds', () => {
    buffers.get('trade', '2023-02-01').push('a');
    buffers.get('quote', '2023-02-01').push('b');
    buffers.get('chat',  '2023-02-01'); // empty — should be skipped

    const result = buffers.flushAll();
    expect(result.map(r => `${r.table}/${r.filename}`).sort()).toEqual(['quote/2023-02-01', 'trade/2023-02-01']);
  });

  it('clears the buffers it flushes', () => {
    const buf = buffers.get('trade', '2023-02-01');
    buf.push('a');
    buffers.flushAll();
    expect(buf.count()).toBe(0);
  });
});
