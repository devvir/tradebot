import { describe, it, expect } from 'vitest';
import {
  createDuplicateCheck,
  WINDOW_MINUTES,
  _test_messageKey,
  _test_advanceWindow,
  _test_canonicalMinute,
} from '../../../../src/tools/sources/checks/duplicates';
import type { CheckContext } from '../../../../src/tools/sources/checks/types';
import type { Message } from '../../../../src/tools/sources/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DEFAULT_COLUMNS = ['_date_', '_action_', 'timestamp', 'symbol', 'price'];

function parseRow(line: string, columns: string[] = DEFAULT_COLUMNS): Record<string, string> {
  const values = line.split(',').map(v => v.trim());
  const record: Record<string, string> = {};

  columns.forEach((col, idx) => {
    record[col] = values[idx] ?? '';
  });

  return record;
}

function ctx(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    filePath:     '/data/vault/orderBookL2/2026/20260101.csv.gz',
    tableName:    'orderBookL2',
    header:       {
      columns:    DEFAULT_COLUMNS,
      hasTimestamp: true,
    },
    timestampCol: 'timestamp',
    ...overrides,
  };
}

function makeMsg(
  date:      string,
  action:    string = 'insert',
  content:   string = 'XBTUSD,30000',
  timestamp: string = date,
): Message {
  const csvLine = `${date},${action},${timestamp},${content}`;
  const row = parseRow(csvLine);

  return {
    rows:      [row],
    date,
    action,
    timestamp,
  };
}

// ── messageKey ────────────────────────────────────────────────────────────────

describe('messageKey', () => {
  it('produces the same key for identical messages', () => {
    const m = makeMsg('2026-01-01T00:00:01.000Z');
    const key1 = _test_messageKey(m, ctx());
    const key2 = _test_messageKey(m, ctx());

    expect(key1).toBe(key2);
  });

  it('different actions produce different keys', () => {
    const insert = makeMsg('2026-01-01T00:00:01.000Z', 'insert');
    const update = makeMsg('2026-01-01T00:00:01.000Z', 'update');

    expect(_test_messageKey(insert, ctx())).not.toBe(_test_messageKey(update, ctx()));
  });

  it('different content produces different keys', () => {
    const m1 = makeMsg('2026-01-01T00:00:01.000Z', 'insert', 'XBTUSD,30000');
    const m2 = makeMsg('2026-01-01T00:00:01.000Z', 'insert', 'XBTUSD,31000');

    expect(_test_messageKey(m1, ctx())).not.toBe(_test_messageKey(m2, ctx()));
  });

  it('ignores the _date_ column — same content with different receive times is same key', () => {
    const m1 = makeMsg('2026-01-01T00:00:01.000Z', 'insert', 'XBTUSD,30000', '2026-01-01T00:00:00.500Z');
    const m2 = makeMsg('2026-01-01T00:00:02.000Z', 'insert', 'XBTUSD,30000', '2026-01-01T00:00:00.500Z');

    expect(_test_messageKey(m1, ctx())).toBe(_test_messageKey(m2, ctx()));
  });

  it('falls back to col 0 when header is null', () => {
    // Both messages have the same content except col 0 (_date_). When null header
    // blanks col 0, the keys should match.
    const fixedTimestamp = '2026-01-01T00:00:00.500Z';
    const m1 = makeMsg('2026-01-01T00:00:01.000Z', 'insert', 'XBTUSD,30000', fixedTimestamp);
    const m2 = makeMsg('2026-01-01T00:00:09.000Z', 'insert', 'XBTUSD,30000', fixedTimestamp);
    const ctxNull = ctx({ header: null });

    expect(_test_messageKey(m1, ctxNull)).toBe(_test_messageKey(m2, ctxNull));
  });
});

// ── createDuplicateCheck ──────────────────────────────────────────────────────

// Advance the lobby past a timestamp by sending a message with a different exchange ts.
// This simulates other exchange events arriving between two occurrences of the same message,
// as would happen during a reconnection (the lobby clears, so the original hash is no longer
// protected — seen catches it instead).
function advanceLobby(check: ReturnType<typeof createDuplicateCheck>, ts: string): void {
  check.onMessage(makeMsg(ts, 'insert', 'FILLER,0', ts), ctx());
}

describe('createDuplicateCheck — basic detection', () => {
  it('does not fire on the first occurrence of a message', () => {
    const check = createDuplicateCheck();
    const m     = makeMsg('2026-01-01T00:00:01.000Z');
    const issues = check.onMessage(m, ctx());

    expect(issues).toHaveLength(0);
  });

  it('fires on the second occurrence when a different exchange timestamp appeared in between', () => {
    const check = createDuplicateCheck();
    const m     = makeMsg('2026-01-01T00:00:01.000Z');

    check.onMessage(m, ctx());
    advanceLobby(check, '2026-01-01T00:00:02.000Z'); // lobby advances → original hash now in seen only
    const issues = check.onMessage(m, ctx());

    expect(issues).toHaveLength(1);
    expect(issues[0]?.type).toBe('duplicate');
  });

  it('reports the date of the first occurrence in firstDate', () => {
    const check = createDuplicateCheck();
    const m1    = makeMsg('2026-01-01T00:00:01.000Z');
    const m2    = { ...m1, date: '2026-01-01T00:00:02.000Z' }; // different _date_, same exchange ts

    check.onMessage(m1, ctx());
    advanceLobby(check, '2026-01-01T00:00:02.000Z');
    const issues = check.onMessage(m2, ctx());

    expect(issues[0]?.firstDate).toBe('2026-01-01T00:00:01.000Z');
    expect(issues[0]?.date).toBe('2026-01-01T00:00:02.000Z');
  });

  it('does not fire for messages with the same date but different content', () => {
    const check = createDuplicateCheck();
    const date  = '2026-01-01T00:00:01.000Z';
    const m1    = makeMsg(date, 'insert', 'XBTUSD,30000');
    const m2    = makeMsg(date, 'insert', 'XBTUSD,31000');

    check.onMessage(m1, ctx());
    const issues = check.onMessage(m2, ctx());

    expect(issues).toHaveLength(0);
  });

  it('each check instance has independent state', () => {
    const check1 = createDuplicateCheck();
    const check2 = createDuplicateCheck();
    const m      = makeMsg('2026-01-01T00:00:01.000Z');

    check1.onMessage(m, ctx());
    advanceLobby(check1, '2026-01-01T00:00:02.000Z');

    const issues1 = check1.onMessage(m, ctx());
    const issues2 = check2.onMessage(m, ctx());

    expect(issues1).toHaveLength(1);
    expect(issues2).toHaveLength(0);
  });
});

describe('createDuplicateCheck — partial exemption in timeless tables', () => {
  it('does not flag repeated partials in small tables (no timestampCol)', () => {
    const check   = createDuplicateCheck();
    const c       = ctx({ timestampCol: null, header: { ...ctx().header!, timestampColIdx: -1 } });
    const partial: Message = { ...makeMsg('2026-01-01T00:00:01.000Z', 'partial'), action: 'partial' };

    check.onMessage(partial, c);
    const issues = check.onMessage(partial, c);

    expect(issues).toHaveLength(0);
  });

  it('still flags repeated non-partial messages in small tables', () => {
    const check  = createDuplicateCheck();
    const c      = ctx({ timestampCol: null, header: { ...ctx().header!, timestampColIdx: -1 } });
    const insert = makeMsg('2026-01-01T00:00:01.000Z', 'insert');

    check.onMessage(insert, c);
    const issues = check.onMessage(insert, c);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.type).toBe('duplicate');
  });

  it('still flags repeated partials in large tables (has timestampCol)', () => {
    const check   = createDuplicateCheck();
    const c       = ctx(); // timestampCol = 'timestamp'
    const partial: Message = { ...makeMsg('2026-01-01T00:00:01.000Z', 'partial'), action: 'partial' };

    check.onMessage(partial, c);
    advanceLobby(check, '2026-01-01T00:00:02.000Z');
    const issues = check.onMessage(partial, c);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.type).toBe('duplicate');
  });
});

describe('createDuplicateCheck — multi-row messages', () => {
  it('detects duplication across multi-row messages', () => {
    const check = createDuplicateCheck();
    const csvLines = [
      '2026-01-01T00:00:01.000Z,partial,2026-01-01T00:00:01.000Z,XBTUSD,30000',
      ',,2026-01-01T00:00:01.000Z,ETHUSD,2000',
    ];
    const m: Message = {
      rows:      csvLines.map(l => parseRow(l)),
      date:      '2026-01-01T00:00:01.000Z',
      action:    'partial',
      timestamp: '2026-01-01T00:00:01.000Z',
    };

    check.onMessage(m, ctx());
    advanceLobby(check, '2026-01-01T00:00:02.000Z');
    const issues = check.onMessage(m, ctx());

    expect(issues).toHaveLength(1);
    expect(issues[0]?.type).toBe('duplicate');
  });
});

// ── advanceWindow ─────────────────────────────────────────────────────────────

describe('advanceWindow', () => {
  function makeState() {
    const seen:    Map<string, string>      = new Map();
    const buckets: Map<string, Set<string>> = new Map();
    const order:   string[]                 = [];

    return { seen, buckets, order };
  }

  it('adds a new minute to the window', () => {
    const { seen, buckets, order } = makeState();

    _test_advanceWindow('2026-01T00:00', order, buckets, seen);

    expect(order).toEqual(['2026-01T00:00']);
    expect(buckets.has('2026-01T00:00')).toBe(true);
  });

  it('does not add the same minute twice', () => {
    const { seen, buckets, order } = makeState();

    _test_advanceWindow('2026-01T00:00', order, buckets, seen);
    _test_advanceWindow('2026-01T00:00', order, buckets, seen);

    expect(order).toHaveLength(1);
  });

  it('evicts the oldest bucket when window exceeds WINDOW_MINUTES', () => {
    const { seen, buckets, order } = makeState();
    const N = WINDOW_MINUTES;

    // Fill exactly N minutes
    for (let i = 0; i < N; i++) {
      const minuteKey = `2026-01-01T00:${String(i).padStart(2, '0')}`;
      const hashKey   = `key-${i}`;

      _test_advanceWindow(minuteKey, order, buckets, seen);
      buckets.get(minuteKey)?.add(hashKey);
      seen.set(hashKey, minuteKey);
    }

    expect(order).toHaveLength(N);

    // Add one more — should evict minute 0
    const overflowKey = `2026-01-01T00:${String(N).padStart(2, '0')}`;

    _test_advanceWindow(overflowKey, order, buckets, seen);

    expect(order).toHaveLength(N);
    expect(buckets.has('2026-01-01T00:00')).toBe(false);
    expect(seen.has('key-0')).toBe(false);
  });

  it('evicted keys are removed from seen', () => {
    const { seen, buckets, order } = makeState();
    const N = WINDOW_MINUTES;

    const firstMinute = '2026-01-01T00:00';
    _test_advanceWindow(firstMinute, order, buckets, seen);
    buckets.get(firstMinute)?.add('evicted-key');
    seen.set('evicted-key', firstMinute);

    // Fill window to N-1 more, then overflow
    for (let i = 1; i <= N; i++) {
      _test_advanceWindow(`2026-01-01T00:${String(i).padStart(2, '0')}`, order, buckets, seen);
    }

    expect(seen.has('evicted-key')).toBe(false);
  });
});

// ── window-wide duplicate across minute boundary ──────────────────────────────

describe('createDuplicateCheck — cross-minute duplicate detection', () => {
  it('detects a duplicate that spans multiple minutes', () => {
    const check = createDuplicateCheck();
    const c = ctx();

    const m1 = makeMsg('2026-01-01T00:01:00.000Z');

    check.onMessage(m1, c);
    advanceLobby(check, '2026-01-01T00:02:00.000Z'); // lobby advances → original hash now in seen only

    // Same content, 10 minutes later — still within window
    const m2 = makeMsg('2026-01-01T00:10:00.000Z', 'insert', 'XBTUSD,30000', '2026-01-01T00:01:00.000Z');

    const issues = check.onMessage(m2, c);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.type).toBe('duplicate');
  });

  it('does not fire after the original has been evicted from the window (no lobby advance needed — different timestamp)', () => {
    const check = createDuplicateCheck();
    const c = ctx();
    const N = WINDOW_MINUTES;

    const original = makeMsg('2026-01-01T00:00:00.000Z');

    check.onMessage(original, c);

    // Advance N+2 minutes so the original's bucket is evicted
    for (let i = 1; i <= N + 2; i++) {
      const filler = makeMsg(
        `2026-01-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
        'insert',
        `FILLER,${i}`,
      );

      check.onMessage(filler, c);
    }

    // Same content as original — should NOT fire (evicted)
    const late = makeMsg('2026-01-01T00:30:00.000Z', 'insert', 'XBTUSD,30000', original.timestamp);
    const issues = check.onMessage(late, c);

    expect(issues).toHaveLength(0);
  });
});

// ── Lobby — bounce-back suppression ──────────────────────────────────────────

describe('createDuplicateCheck — lobby bounce-back suppression', () => {
  it('does not flag identical messages within the same exchange timestamp (bounce-back)', () => {
    const check = createDuplicateCheck();
    const ts    = '2026-01-01T00:00:01.000Z';
    const m     = makeMsg(ts, 'insert', 'XBTUSD,30000', ts);

    check.onMessage(m, ctx());
    const issues = check.onMessage(m, ctx());

    expect(issues).toHaveLength(0);
  });

  it('does not flag a third occurrence within the same exchange timestamp', () => {
    const check = createDuplicateCheck();
    const ts    = '2026-01-01T00:00:01.000Z';
    const m     = makeMsg(ts, 'insert', 'XBTUSD,30000', ts);

    check.onMessage(m, ctx());
    check.onMessage(m, ctx());
    const issues = check.onMessage(m, ctx());

    expect(issues).toHaveLength(0);
  });

  it('flags the same content after the exchange timestamp advances (real reconnection dupe)', () => {
    const check = createDuplicateCheck();
    const ts    = '2026-01-01T00:00:01.000Z';
    const m     = makeMsg(ts, 'insert', 'XBTUSD,30000', ts);

    check.onMessage(m, ctx());
    advanceLobby(check, '2026-01-01T00:00:02.000Z');
    const issues = check.onMessage(m, ctx());

    expect(issues).toHaveLength(1);
    expect(issues[0]?.type).toBe('duplicate');
  });

  it('does not apply lobby suppression for tables without timestampCol', () => {
    // Small tables have no exchange timestamp — every repeated message is a real dupe.
    const check = createDuplicateCheck();
    const c     = ctx({ timestampCol: null, header: { ...ctx().header!, timestampColIdx: -1 } });
    const m     = makeMsg('2026-01-01T00:00:01.000Z', 'insert');

    check.onMessage(m, c);
    const issues = check.onMessage(m, c);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.type).toBe('duplicate');
  });
});
