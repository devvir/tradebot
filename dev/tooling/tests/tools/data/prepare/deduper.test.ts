import { describe, it, expect } from 'vitest';
import { dedup, _test_TABLE_CONFIG } from '../../../../src/tools/data/prepare/tasks/deduper';
import type { Action, PreparedMessage } from '../../../../src/tools/data/prepare/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function msg(opts: {
  date:    string;
  action?: Action;
  val?:    string;
}): PreparedMessage {
  const date   = opts.date;
  const action = opts.action ?? 'update';
  const val    = opts.val ?? 'default';
  const ts     = date.slice(0, 23);

  return {
    rows:      [`${date},${action},${val}`],
    date,
    action,
    timestamp: null,
    ts,
    tsMs:      Date.parse(ts + 'Z'),
  };
}

async function* batches(...groups: PreparedMessage[][]): AsyncGenerator<PreparedMessage[]> {
  for (const g of groups) yield g;
}

async function collect(gen: AsyncGenerator<PreparedMessage[]>): Promise<PreparedMessage[]> {
  const out: PreparedMessage[] = [];

  for await (const batch of gen) out.push(...batch);

  return out;
}

function addMs(base: string, ms: number): string {
  return new Date(Date.parse(base) + ms).toISOString();
}

// ── Content key ───────────────────────────────────────────────────────────────

describe('content key', () => {
  it('excludes _date_ (before first comma): different dates, same content → treated as identical', async () => {
    const a  = msg({ date: '2026-01-01T12:00:00.000Z', action: 'insert', val: 'X' });
    const a2 = msg({ date: '2026-01-01T12:00:00.001Z', action: 'insert', val: 'X' });

    const out = await collect(dedup(batches([a, a2]), 'announcement'));

    expect(out).toHaveLength(1);
  });

  it('includes everything after the first comma: different val → different content', async () => {
    const a = msg({ date: '2026-01-01T12:00:00.000Z', action: 'insert', val: 'X' });
    const b = msg({ date: '2026-01-01T12:00:00.000Z', action: 'insert', val: 'Y' });

    const out = await collect(dedup(batches([a, b]), 'announcement'));

    expect(out).toHaveLength(2);
  });
});

// ── Partials ──────────────────────────────────────────────────────────────────

describe('partials', () => {
  it('partial passes through unconditionally even with identical content', async () => {
    const p1 = msg({ date: '2026-01-01T12:00:00.000Z', action: 'partial', val: 'X' });
    const p2 = msg({ date: '2026-01-01T12:00:01.000Z', action: 'partial', val: 'X' });

    const out = await collect(dedup(batches([p1, p2]), 'announcement'));

    expect(out).toHaveLength(2);
  });

  it('partial:<symbol> passes through unconditionally', async () => {
    const p1 = msg({ date: '2026-01-01T12:00:00.000Z', action: 'partial:XBTUSD', val: 'X' });
    const p2 = msg({ date: '2026-01-01T12:00:01.000Z', action: 'partial:XBTUSD', val: 'X' });

    const out = await collect(dedup(batches([p1, p2]), 'orderBookL2'));

    expect(out).toHaveLength(2);
  });

  it('partial does not update the contiguous lastHash (orderBookL2 update)', async () => {
    const u1 = msg({ date: '2026-01-01T12:00:00.000Z', action: 'update', val: 'A' });
    const p  = msg({ date: '2026-01-01T12:00:01.000Z', action: 'partial', val: 'X' });
    const u2 = msg({ date: '2026-01-01T12:00:02.000Z', action: 'update', val: 'A' }); // contiguous with u1 via lastHash → drop

    const out = await collect(dedup(batches([u1, p, u2]), 'orderBookL2'));

    expect(out.map(m => m.action)).toEqual(['update', 'partial']);
  });
});

// ── announcement / publicNotifications / liquidation ─────────────────────────
// Global hash, no time constraint — all actions (insert, update, delete).
// Any repeat of the same content, anywhere in the stream, is dropped.

describe('dedup — announcement / publicNotifications / liquidation', () => {
  it('drops a non-adjacent insert dupe', async () => {
    const a  = msg({ date: '2026-01-01T12:00:00.000Z', action: 'insert', val: 'X' });
    const b  = msg({ date: '2026-01-01T12:00:01.000Z', action: 'insert', val: 'Y' });
    const a2 = msg({ date: '2026-01-01T12:00:02.000Z', action: 'insert', val: 'X' }); // non-adjacent dup → drop

    const out = await collect(dedup(batches([a, b, a2]), 'announcement'));

    expect(out).toHaveLength(2);
  });

  it('drops a non-adjacent update dupe', async () => {
    const u1 = msg({ date: '2026-01-01T12:00:00.000Z', action: 'update', val: 'A' });
    const u2 = msg({ date: '2026-01-01T12:00:01.000Z', action: 'update', val: 'B' });
    const u3 = msg({ date: '2026-01-01T12:00:02.000Z', action: 'update', val: 'A' }); // non-adjacent dup → drop

    for (const table of ['announcement', 'publicNotifications', 'liquidation']) {
      const out = await collect(dedup(batches([u1, u2, u3]), table));

      expect(out).toHaveLength(2);
    }
  });

  it('drops same content regardless of how much time has elapsed', async () => {
    const a  = msg({ date: '2026-01-01T12:00:00.000Z', action: 'insert', val: 'X' });
    const a2 = msg({ date: '2026-01-01T18:00:00.000Z', action: 'insert', val: 'X' }); // 6h later — still dropped

    const out = await collect(dedup(batches([a], [a2]), 'liquidation'));

    expect(out).toHaveLength(1);
  });
});

// ── chat ─────────────────────────────────────────────────────────────────────
// Insert / delete: global hash, no time constraint.
// Update: global hash within 10s — same content repeated after 10s is kept.

describe('dedup — chat', () => {
  it('insert: drops non-adjacent dup regardless of time (global hash, no window)', async () => {
    const a  = msg({ date: '2026-01-01T12:00:00.000Z', action: 'insert', val: 'msg1' });
    const b  = msg({ date: '2026-01-01T12:00:01.000Z', action: 'insert', val: 'msg2' });
    const a2 = msg({ date: '2026-01-01T14:00:00.000Z', action: 'insert', val: 'msg1' }); // 2h later — still dropped

    const out = await collect(dedup(batches([a, b, a2]), 'chat'));

    expect(out).toHaveLength(2);
  });

  it('update: drops same content seen within updateWindow (covers cross-source lag)', async () => {
    const base   = '2026-01-01T12:00:00.000Z';
    const window = _test_TABLE_CONFIG.chat.updateWindow!;
    const u1     = msg({ date: base,                      action: 'update', val: 'A' });
    const u2     = msg({ date: addMs(base, window - 1),   action: 'update', val: 'A' }); // 1ms inside window → drop

    const out = await collect(dedup(batches([u1, u2]), 'chat'));

    expect(out).toHaveLength(1);
  });

  it('update: keeps same content once updateWindow has elapsed', async () => {
    const base   = '2026-01-01T12:00:00.000Z';
    const window = _test_TABLE_CONFIG.chat.updateWindow!;
    const u1     = msg({ date: base,                      action: 'update', val: 'A' });
    const u2     = msg({ date: addMs(base, window + 1),   action: 'update', val: 'A' }); // 1ms past window → keep

    const out = await collect(dedup(batches([u1], [u2]), 'chat'));

    expect(out).toHaveLength(2);
  });

  it('update: non-adjacent same content within updateWindow is still dropped (global hash, not contiguous)', async () => {
    const base   = '2026-01-01T12:00:00.000Z';
    const window = _test_TABLE_CONFIG.chat.updateWindow!;
    const u1     = msg({ date: base,                      action: 'update', val: 'A' });
    const u2     = msg({ date: addMs(base, 1000),         action: 'update', val: 'B' });
    const u3     = msg({ date: addMs(base, 2000),         action: 'update', val: 'A' }); // non-adjacent but within window → drop

    expect(2000).toBeLessThan(window);

    const out = await collect(dedup(batches([u1, u2, u3]), 'chat'));

    expect(out).toHaveLength(2);
  });
});

// ── instrument ────────────────────────────────────────────────────────────────
// Insert / delete: global hash, no time constraint.
// Update: contiguous only — only adjacent identical messages are dropped.

describe('dedup — instrument', () => {
  it('insert: drops non-adjacent dup (global hash)', async () => {
    const a  = msg({ date: '2026-01-01T12:00:00.000Z', action: 'insert', val: 'X' });
    const b  = msg({ date: '2026-01-01T12:00:01.000Z', action: 'insert', val: 'Y' });
    const a2 = msg({ date: '2026-01-01T12:00:02.000Z', action: 'insert', val: 'X' }); // non-adjacent dup → drop

    const out = await collect(dedup(batches([a, b, a2]), 'instrument'));

    expect(out).toHaveLength(2);
  });

  it('update: drops adjacent dup', async () => {
    const u1 = msg({ date: '2026-01-01T12:00:00.000Z', action: 'update', val: 'A' });
    const u2 = msg({ date: '2026-01-01T12:00:01.000Z', action: 'update', val: 'A' }); // adjacent dup → drop

    const out = await collect(dedup(batches([u1, u2]), 'instrument'));

    expect(out).toHaveLength(1);
  });

  it('update: keeps non-adjacent dup (contiguous, not global hash)', async () => {
    const u1 = msg({ date: '2026-01-01T12:00:00.000Z', action: 'update', val: 'A' });
    const u2 = msg({ date: '2026-01-01T12:00:01.000Z', action: 'update', val: 'B' });
    const u3 = msg({ date: '2026-01-01T12:00:02.000Z', action: 'update', val: 'A' }); // non-adjacent → keep

    const out = await collect(dedup(batches([u1, u2, u3]), 'instrument'));

    expect(out).toHaveLength(3);
  });

  it('update: preserves oscillation', async () => {
    const inputs = [
      msg({ date: '2026-01-01T12:00:00.000Z', action: 'update', val: 'up'   }),
      msg({ date: '2026-01-01T12:00:01.000Z', action: 'update', val: 'down' }),
      msg({ date: '2026-01-01T12:00:02.000Z', action: 'update', val: 'up'   }),
    ];

    const out = await collect(dedup(batches(inputs), 'instrument'));

    expect(out).toHaveLength(3);
  });
});

// ── orderBookL2 ───────────────────────────────────────────────────────────────
// Insert / delete: bounded hash (100) — catches ghost-sub dupes that may not be
// strictly adjacent due to interleaving of two source streams at the same ms.
// Update: contiguous only — same-ms oscillations are real events and must be kept.

describe('dedup — orderBookL2', () => {
  it('insert: drops adjacent dup', async () => {
    const a  = msg({ date: '2026-01-01T12:00:00.000Z', action: 'insert', val: 'X' });
    const a2 = msg({ date: '2026-01-01T12:00:00.001Z', action: 'insert', val: 'X' }); // adjacent dup → drop

    const out = await collect(dedup(batches([a, a2]), 'orderBookL2'));

    expect(out).toHaveLength(1);
  });

  it('insert: drops non-adjacent dup within bounded store (ghost sub interleaving)', async () => {
    // S1.E1 and S2.E1 are ghost dups but interleaved by S1.E2 from the merged stream.
    const s1_e1 = msg({ date: '2026-01-01T12:00:00.000Z', action: 'insert', val: 'X' });
    const s1_e2 = msg({ date: '2026-01-01T12:00:00.001Z', action: 'insert', val: 'Y' }); // different content
    const s2_e1 = msg({ date: '2026-01-01T12:00:00.002Z', action: 'insert', val: 'X' }); // ghost dup of s1_e1 → drop

    const out = await collect(dedup(batches([s1_e1, s1_e2, s2_e1]), 'orderBookL2'));

    expect(out.map(m => m.date)).toEqual([
      '2026-01-01T12:00:00.000Z',
      '2026-01-01T12:00:00.001Z',
    ]);
  });

  it('update: drops adjacent dup', async () => {
    const u1 = msg({ date: '2026-01-01T12:00:00.000Z', action: 'update', val: 'A' });
    const u2 = msg({ date: '2026-01-01T12:00:01.000Z', action: 'update', val: 'A' }); // adjacent dup → drop

    const out = await collect(dedup(batches([u1, u2]), 'orderBookL2'));

    expect(out).toHaveLength(1);
  });

  it('update: keeps non-adjacent dup (contiguous — same-ms oscillations are real)', async () => {
    const u1 = msg({ date: '2026-01-01T12:00:00.000Z', action: 'update', val: 'A' });
    const u2 = msg({ date: '2026-01-01T12:00:01.000Z', action: 'update', val: 'B' });
    const u3 = msg({ date: '2026-01-01T12:00:02.000Z', action: 'update', val: 'A' }); // non-adjacent → keep

    const out = await collect(dedup(batches([u1, u2, u3]), 'orderBookL2'));

    expect(out).toHaveLength(3);
  });
});

// ── connected ─────────────────────────────────────────────────────────────────
// Update: contiguous within 15s. Snapshots repeat every 30s — the 15s window
// catches ghost-sub dupes (ms apart) without dropping the next real snapshot.

describe('dedup — connected', () => {
  it('drops adjacent dup within updateWindow', async () => {
    const base   = '2026-01-01T12:00:00.000Z';
    const window = _test_TABLE_CONFIG.connected.updateWindow!;
    const u1     = msg({ date: base,                    action: 'update', val: 'count5' });
    const u2     = msg({ date: addMs(base, window - 1), action: 'update', val: 'count5' }); // 1ms inside window → drop

    const out = await collect(dedup(batches([u1, u2]), 'connected'));

    expect(out).toHaveLength(1);
  });

  it('keeps same content once updateWindow has elapsed (next real snapshot)', async () => {
    const base   = '2026-01-01T12:00:00.000Z';
    const window = _test_TABLE_CONFIG.connected.updateWindow!;
    const u1     = msg({ date: base,                    action: 'update', val: 'count5' });
    const u2     = msg({ date: addMs(base, window + 1), action: 'update', val: 'count5' }); // 1ms past window → keep

    const out = await collect(dedup(batches([u1], [u2]), 'connected'));

    expect(out).toHaveLength(2);
  });

  it('keeps non-adjacent same content regardless of window (oscillation)', async () => {
    const u1 = msg({ date: '2026-01-01T12:00:00.000Z', action: 'update', val: 'count5' });
    const u2 = msg({ date: '2026-01-01T12:00:01.000Z', action: 'update', val: 'count6' }); // different → keep
    const u3 = msg({ date: '2026-01-01T12:00:02.000Z', action: 'update', val: 'count5' }); // non-adjacent — keep regardless of window

    const out = await collect(dedup(batches([u1, u2, u3]), 'connected'));

    expect(out).toHaveLength(3);
  });

  it('adjacent dup past updateWindow is not dropped (window is relative to stored ts)', async () => {
    const base   = '2026-01-01T12:00:00.000Z';
    const window = _test_TABLE_CONFIG.connected.updateWindow!;
    const u1     = msg({ date: base,                    action: 'update', val: 'count5' });
    // u2 is adjacent to u1 (u1 is still lastKey) but past the window → keep
    const u2     = msg({ date: addMs(base, window + 1), action: 'update', val: 'count5' });

    const out = await collect(dedup(batches([u1], [u2]), 'connected'));

    expect(out).toHaveLength(2);
  });
});
