import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { merge, Peekable } from '../../../../src/tools/sources/prepare/tasks/merger';
import { _test_setColumns, _test_clearColumns } from '../../../../src/tools/sources/tables';
import type { PreparedMessage } from '../../../../src/tools/sources/prepare/types';

// 'orderBookL2' → potentialGapThresholdMs = 1 (timestamped)
// 'chat'        → potentialGapThresholdMs = 60_000 (timeless, fixedPartials)
beforeAll(() => {
  _test_setColumns('orderBookL2', ['_date_', '_action_', 'timestamp', 'symbol']);
});

afterAll(() => {
  _test_clearColumns('orderBookL2');
});

function msg(tsMs: number, label: string = `m-${tsMs}`): PreparedMessage {
  const ts = new Date(tsMs).toISOString().slice(0, 23);

  return {
    rows:      [{ _date_: ts + 'Z', _action_: 'update', label }],
    date:      ts + 'Z',
    action:    'update',
    timestamp: '',
    ts,
    tsMs,
  };
}

function label(m: PreparedMessage): string {
  return m.rows[0]!['label'] ?? '';
}

async function* batches(...batches: PreparedMessage[][]): AsyncGenerator<PreparedMessage[]> {
  for (const b of batches) {
    yield b;
  }
}

async function* fromList(list: PreparedMessage[], batchSize: number = 1): AsyncGenerator<PreparedMessage[]> {
  for (let i = 0; i < list.length; i += batchSize) {
    yield list.slice(i, i + batchSize);
  }
}

async function collect(gen: AsyncGenerator<PreparedMessage[]>): Promise<PreparedMessage[]> {
  const out: PreparedMessage[] = [];

  for await (const batch of gen) {
    out.push(...batch);
  }

  return out;
}

// ── Peekable ────────────────────────────────────────────────────────────────

describe('Peekable', () => {
  it('peek does not advance, pop does', async () => {
    const p = new Peekable(batches([msg(1, 'a'), msg(2, 'b')]));

    expect(label(await p.peek()!)).toBe('a');
    expect(label(await p.peek()!)).toBe('a');
    expect(label(await p.pop()!)).toBe('a');
    expect(label(await p.peek()!)).toBe('b');
  });

  it('returns null when exhausted', async () => {
    const p = new Peekable(batches([msg(1, 'a')]));

    expect(label(await p.pop()!)).toBe('a');
    expect(await p.peek()).toBeNull();
    expect(await p.pop()).toBeNull();
  });

  it('refills across batch boundaries', async () => {
    const p = new Peekable(batches([msg(1, 'a')], [msg(2, 'b')], [msg(3, 'c')]));

    expect(label(await p.pop()!)).toBe('a');
    expect(label(await p.pop()!)).toBe('b');
    expect(label(await p.pop()!)).toBe('c');
    expect(await p.pop()).toBeNull();
  });
});

// ── merge ───────────────────────────────────────────────────────────────────

describe('merge — single source', () => {
  it('passes through unchanged', async () => {
    const s   = fromList([msg(1, 'a'), msg(2, 'b'), msg(3, 'c')]);
    const out = await collect(merge([s], 'orderBookL2'));

    expect(out.map(label)).toEqual(['a', 'b', 'c']);
  });
});

describe('merge — gap fill (timestamped, gap=1)', () => {
  it('switches to secondary when primary has a gap', async () => {
    // S1 has gap from t=1 → t=10
    // S2 fills t=2..9
    const s1 = fromList([msg(1, 's1@1'), msg(10, 's1@10')]);
    const s2 = fromList([msg(1, 's2@1'), msg(2, 's2@2'), msg(5, 's2@5'), msg(10, 's2@10')]);

    const out = await collect(merge([s1, s2], 'orderBookL2'));

    // Expected: s1@1, then S1 has a gap (head=10, nextMs=2 → 10 > 2),
    // switch — drop s2@1 (covered), pick s2@2 (>= 2), continue on S2
    // up to s2@5. After s2@5, nextMs=6. S2 has next at 10 (> 6), gap.
    // Switch — S1 has 10 (>= 6), pick S1 (lower index when tied).
    expect(out.map(label)).toEqual(['s1@1', 's2@2', 's2@5', 's1@10']);
  });
});

describe('merge — priority order', () => {
  it('prefers higher-priority source on ties', async () => {
    const s1 = fromList([msg(1, 's1'), msg(2, 's1@2')]);
    const s2 = fromList([msg(1, 's2'), msg(2, 's2@2')]);

    const out = await collect(merge([s1, s2], 'orderBookL2'));

    // S1 wins at 1 (priority). Then nextMs=2, S1 head=2 still within range, stay.
    // S1 head=null after, gap. S2 has been advancing past covered range.
    expect(out.map(label)).toEqual(['s1', 's1@2']);
  });
});

describe('merge — timeless gap (gap=60_000)', () => {
  it('stays on primary across small gaps', async () => {
    // 30 second gap, threshold 60 seconds → stay on S1
    const s1 = fromList([msg(0, 's1@0'), msg(30_000, 's1@30')]);
    const s2 = fromList([msg(0, 's2@0'), msg(15_000, 's2@15')]);

    const out = await collect(merge([s1, s2], 'chat'));

    expect(out.map(label)).toEqual(['s1@0', 's1@30']);
  });

  it('switches when gap exceeds threshold', async () => {
    // 90 second gap, threshold 60 seconds → S2 fills middle
    const s1 = fromList([msg(0, 's1@0'), msg(90_000, 's1@90')]);
    const s2 = fromList([msg(0, 's2@0'), msg(30_000, 's2@30'), msg(60_000, 's2@60'), msg(90_000, 's2@90')]);

    const out = await collect(merge([s1, s2], 'chat'));

    // s1@0; nextMs=60_000; s1 head=90_000 > 60_000 → gap.
    // Drain: drop s2@0 (0 <= 0, covered). s2@30 survives (30_000 > 0).
    // Switch to s2 (lowest head). Emit s2@30, s2@60, s2@90.
    // s2 exhausted → drain: s1@90 (90_000 <= 90_000) → drop. Done.
    expect(out.map(label)).toEqual(['s1@0', 's2@30', 's2@60', 's2@90']);
  });

  it('includes the gap-triggering message from the new source (regression)', async () => {
    // Bug: drain used `tsMs < lastEmitted.tsMs + threshold` which dropped messages
    // that fell within the gap window but AFTER the last emitted time.
    // The first message of the new source must always be emitted.
    const s1 = fromList([msg(0, 's1@0'), msg(61_000, 's1@61')]);
    const s2 = fromList([msg(0, 's2@0'), msg(30_000, 's2@30'), msg(61_000, 's2@61')]);

    const out = await collect(merge([s1, s2], 'chat'));

    // s1@0; nextMs=60_000; s1 head=61_000 > 60_000 → gap.
    // Drain: s2@0 (0 <= 0) → drop. s2@30 survives.
    // s2@30 < s1@61 → switch to S2. Emit s2@30, s2@61.
    // s2 exhausted → drain: s1@61 (61_000 <= 61_000) → drop. Done.
    expect(out.map(label)).toEqual(['s1@0', 's2@30', 's2@61']);
  });
});

describe('merge — empty sources', () => {
  it('handles all-empty input', async () => {
    const out = await collect(merge([fromList([]), fromList([])], 'orderBookL2'));

    expect(out).toEqual([]);
  });

  it('handles a single non-empty source among empties', async () => {
    const out = await collect(merge([fromList([]), fromList([msg(1, 'a')]), fromList([])], 'orderBookL2'));

    expect(out.map(label)).toEqual(['a']);
  });
});
