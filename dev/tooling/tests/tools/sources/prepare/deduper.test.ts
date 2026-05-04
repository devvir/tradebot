import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { dedup, _test_computeHash } from '../../../../src/tools/sources/prepare/tasks/deduper';
import { _test_setColumns, _test_clearColumns } from '../../../../src/tools/sources/tables';
import type { Action, PreparedMessage } from '../../../../src/tools/sources/prepare/types';

// ── Test columns ─────────────────────────────────────────────────────────────

const TEST_COLS = ['_date_', '_action_', 'val'];

// Table → strategy mapping used by deduper:
//   announcement → hash
//   orderBookL2  → contiguous
//   liquidation  → hybrid
beforeAll(() => {
  _test_setColumns('announcement', TEST_COLS);
  _test_setColumns('orderBookL2',  TEST_COLS);
  _test_setColumns('liquidation',  TEST_COLS);
});

afterAll(() => {
  _test_clearColumns('announcement');
  _test_clearColumns('orderBookL2');
  _test_clearColumns('liquidation');
});

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
    rows:      [{ _date_: date, _action_: action, val }],
    date,
    action,
    timestamp: '',
    ts,
    tsMs:      Date.parse(ts + 'Z'),
  };
}

async function* batches(...batches: PreparedMessage[][]): AsyncGenerator<PreparedMessage[]> {
  for (const b of batches) {
    yield b;
  }
}

async function collect(gen: AsyncGenerator<PreparedMessage[]>): Promise<PreparedMessage[]> {
  const out: PreparedMessage[] = [];

  for await (const batch of gen) {
    out.push(...batch);
  }

  return out;
}

// ── computeHash ─────────────────────────────────────────────────────────────

describe('computeHash', () => {
  it('blanks _date_ and includes everything else', () => {
    const cols = ['_date_', '_action_', 'symbol'];
    const a = _test_computeHash('insert', [{ _date_: 'x', _action_: 'insert', symbol: 'XBT' }], cols);
    const b = _test_computeHash('insert', [{ _date_: 'y', _action_: 'insert', symbol: 'XBT' }], cols);

    expect(a).toBe(b); // _date_ blanked → identical hash
  });

  it('differs when non-_date_ fields differ', () => {
    const cols = ['_date_', '_action_', 'symbol'];
    const a = _test_computeHash('insert', [{ _date_: 'x', _action_: 'insert', symbol: 'XBT' }], cols);
    const b = _test_computeHash('insert', [{ _date_: 'x', _action_: 'insert', symbol: 'ETH' }], cols);

    expect(a).not.toBe(b);
  });
});

// ── hash strategy ────────────────────────────────────────────────────────────

describe('dedup — hash strategy', () => {
  it('drops messages whose content was seen earlier', async () => {
    const a  = msg({ date: '2026-01-01T12:00:00.000Z', val: 'XBT' });
    const b  = msg({ date: '2026-01-01T12:00:01.000Z', val: 'ETH' });
    const a2 = msg({ date: '2026-01-01T12:00:02.000Z', val: 'XBT' });  // same as a

    const out = await collect(dedup(batches([a, b, a2]), 'announcement'));

    expect(out.map(m => m.date)).toEqual([
      '2026-01-01T12:00:00.000Z',
      '2026-01-01T12:00:01.000Z',
    ]);
  });

  it('keeps every hash for the lifetime of the stream (no window)', async () => {
    const a1 = msg({ date: '2026-01-01T12:00:00.000Z', val: 'A' });
    const b  = msg({ date: '2026-01-01T12:30:00.000Z', val: 'B' });
    const c  = msg({ date: '2026-01-01T13:00:00.000Z', val: 'C' });
    const a2 = msg({ date: '2026-01-01T18:00:00.000Z', val: 'A' });  // 6h later — still dropped

    const out = await collect(dedup(batches([a1], [b], [c], [a2]), 'announcement'));

    expect(out.map(m => m.date)).toEqual([
      '2026-01-01T12:00:00.000Z',
      '2026-01-01T12:30:00.000Z',
      '2026-01-01T13:00:00.000Z',
    ]);
  });

  it('passes partials through unconditionally', async () => {
    const p1 = msg({ date: '2026-01-01T12:00:00.000Z', action: 'partial', val: 'X' });
    const p2 = msg({ date: '2026-01-01T12:01:00.000Z', action: 'partial', val: 'X' });  // same content

    const out = await collect(dedup(batches([p1, p2]), 'announcement'));

    expect(out).toHaveLength(2);
  });
});

// ── contiguous strategy ─────────────────────────────────────────────────────

describe('dedup — contiguous strategy', () => {
  it('drops only adjacent identical messages', async () => {
    const a1 = msg({ date: '2026-01-01T12:00:00.000Z', val: 'A' });
    const a2 = msg({ date: '2026-01-01T12:00:01.000Z', val: 'A' });   // adjacent dup → drop
    const b  = msg({ date: '2026-01-01T12:00:02.000Z', val: 'B' });
    const a3 = msg({ date: '2026-01-01T12:00:03.000Z', val: 'A' });   // non-adjacent → keep
    const a4 = msg({ date: '2026-01-01T12:00:04.000Z', val: 'A' });   // adjacent dup → drop

    const out = await collect(dedup(batches([a1, a2, b, a3, a4]), 'orderBookL2'));

    expect(out.map(m => m.date)).toEqual([
      '2026-01-01T12:00:00.000Z',
      '2026-01-01T12:00:02.000Z',
      '2026-01-01T12:00:03.000Z',
    ]);
  });

  it('preserves oscillation when content alternates', async () => {
    const inputs = [
      msg({ date: '2026-01-01T12:00:00.000Z', val: 'plus'  }),
      msg({ date: '2026-01-01T12:00:01.000Z', val: 'minus' }),
      msg({ date: '2026-01-01T12:00:02.000Z', val: 'plus'  }),  // oscillates back — must keep
    ];

    const out = await collect(dedup(batches(inputs), 'orderBookL2'));

    expect(out).toHaveLength(3);
  });

  it('passes partials through but does not anchor lastHash', async () => {
    const inputs = [
      msg({ date: '2026-01-01T12:00:00.000Z', val: 'A' }),
      msg({ date: '2026-01-01T12:00:01.000Z', action: 'partial', val: 'X' }),
      msg({ date: '2026-01-01T12:00:02.000Z', val: 'A' }),  // adjacent to last non-partial → drop
    ];

    const out = await collect(dedup(batches(inputs), 'orderBookL2'));

    // expected: d0, d1 (partial) — d2 is contiguous w/ d0 via lastHash
    expect(out.map(m => m.date)).toEqual([
      '2026-01-01T12:00:00.000Z',
      '2026-01-01T12:00:01.000Z',
    ]);
  });
});

// ── hybrid strategy ─────────────────────────────────────────────────────────

describe('dedup — hybrid strategy (liquidation)', () => {
  it('hash-deduplicates inserts and deletes; contiguous-deduplicates updates', async () => {
    const inputs = [
      msg({ date: '2026-01-01T12:00:00.000Z', action: 'insert', val: 'I1' }),
      msg({ date: '2026-01-01T12:00:01.000Z', action: 'update', val: 'U1' }),
      msg({ date: '2026-01-01T12:00:02.000Z', action: 'update', val: 'U1' }),  // contiguous dup → drop
      msg({ date: '2026-01-01T12:00:03.000Z', action: 'update', val: 'U2' }),
      msg({ date: '2026-01-01T12:00:04.000Z', action: 'update', val: 'U1' }),  // not contiguous → keep
      msg({ date: '2026-01-01T12:00:05.000Z', action: 'insert', val: 'I1' }),  // hash dup of earlier → drop
      msg({ date: '2026-01-01T12:00:06.000Z', action: 'delete', val: 'D1' }),
      msg({ date: '2026-01-01T12:00:07.000Z', action: 'delete', val: 'D1' }),  // hash dup → drop
    ];

    const out = await collect(dedup(batches(inputs), 'liquidation'));

    expect(out.map(m => `${m.action}|${m.date}`)).toEqual([
      'insert|2026-01-01T12:00:00.000Z',
      'update|2026-01-01T12:00:01.000Z',
      'update|2026-01-01T12:00:03.000Z',
      'update|2026-01-01T12:00:04.000Z',
      'delete|2026-01-01T12:00:06.000Z',
    ]);
  });

  it('keeps insert/delete hashes for the lifetime of the stream', async () => {
    const inputs = [
      msg({ date: '2026-01-01T12:00:00.000Z', action: 'insert', val: 'I1' }),
      msg({ date: '2026-01-01T18:00:00.000Z', action: 'insert', val: 'I1' }),  // 6h later — still dropped
    ];

    const out = await collect(dedup(batches(inputs), 'liquidation'));

    expect(out).toHaveLength(1);
  });
});
