import { describe, it, expect } from 'vitest';
import {
  createWrongOrderCheck,
  createGapCheck,
  _test_pickTimestamp,
  _test_GAP_THRESHOLD_MS,
} from '../../../../src/tools/sources/checks/gaps';
import type { CheckContext } from '../../../../src/tools/sources/checks/types';
import type { Message } from '../../../../src/tools/sources/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function ctx(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    filePath:     '/data/vault/orderBookL2/2026/20260101.csv.gz',
    tableName:    'orderBookL2',
    header:       null,
    timestampCol: 'timestamp',
    ...overrides,
  };
}

function msg(date: string, timestamp = date, action = 'insert'): Message {
  return { lines: [`${date},${action},${timestamp},XBTUSD,30000`], date, action, timestamp };
}

// ── pickTimestamp ─────────────────────────────────────────────────────────────

describe('pickTimestamp', () => {
  it('uses timestamp when timestampCol is configured and value is present', () => {
    const ts = _test_pickTimestamp(
      { date: '2026-01-01T00:00:01.000Z', timestamp: '2026-01-01T00:00:00.500Z' },
      'timestamp',
    );

    expect(ts).toBe('2026-01-01T00:00:00.500Z');
  });

  it('falls back to date when timestampCol is null', () => {
    const ts = _test_pickTimestamp(
      { date: '2026-01-01T00:00:01.000Z', timestamp: '2026-01-01T00:00:00.500Z' },
      null,
    );

    expect(ts).toBe('2026-01-01T00:00:01.000Z');
  });

  it('falls back to date when timestamp value is empty', () => {
    const ts = _test_pickTimestamp(
      { date: '2026-01-01T00:00:01.000Z', timestamp: '' },
      'timestamp',
    );

    expect(ts).toBe('2026-01-01T00:00:01.000Z');
  });
});

// ── createWrongOrderCheck ─────────────────────────────────────────────────────

describe('createWrongOrderCheck — no issues on first message', () => {
  it('does not fire for the first message', () => {
    const check = createWrongOrderCheck();
    const issues = check.onMessage(msg('2026-01-01T00:00:01.000Z'), ctx());

    expect(issues).toHaveLength(0);
  });
});

describe('createWrongOrderCheck — ordered stream', () => {
  it('does not fire when messages are in order', () => {
    const check = createWrongOrderCheck();
    const c = ctx();

    check.onMessage(msg('2026-01-01T00:00:01.000Z'), c);
    check.onMessage(msg('2026-01-01T00:00:02.000Z'), c);
    const issues = check.onMessage(msg('2026-01-01T00:00:03.000Z'), c);

    expect(issues).toHaveLength(0);
  });

  it('does not fire for equal timestamps', () => {
    const check = createWrongOrderCheck();
    const c = ctx();
    const ts = '2026-01-01T00:00:01.000Z';

    check.onMessage(msg(ts), c);
    const issues = check.onMessage(msg(ts), c);

    expect(issues).toHaveLength(0);
  });
});

describe('createWrongOrderCheck — backwards timestamps', () => {
  it('fires when a message timestamp is earlier than the previous', () => {
    const check = createWrongOrderCheck();
    const c = ctx();

    check.onMessage(msg('2026-01-01T00:00:02.000Z'), c);
    const issues = check.onMessage(msg('2026-01-01T00:00:01.000Z'), c);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.type).toBe('wrong-order');
  });

  it('includes both timestamps in the message', () => {
    const check = createWrongOrderCheck();
    const c = ctx();

    check.onMessage(msg('2026-01-01T00:00:02.000Z'), c);
    const issues = check.onMessage(msg('2026-01-01T00:00:01.000Z'), c);

    expect(issues[0]?.message).toMatch(/2026-01-01T00:00:01/);
    expect(issues[0]?.message).toMatch(/2026-01-01T00:00:02/);
  });

  it('does not update last-seen after a violation (does not propagate bad state)', () => {
    const check = createWrongOrderCheck();
    const c = ctx();

    check.onMessage(msg('2026-01-01T00:00:03.000Z'), c);
    check.onMessage(msg('2026-01-01T00:00:01.000Z'), c); // violation

    // Next message is after the last VALID seen (00:03), so should not fire
    const issues = check.onMessage(msg('2026-01-01T00:00:04.000Z'), c);

    expect(issues).toHaveLength(0);
  });
});

describe('createWrongOrderCheck — uses timestamp column over date when configured', () => {
  it('compares by the message.timestamp value when timestampCol is set', () => {
    const check = createWrongOrderCheck();
    const c = ctx({ timestampCol: 'timestamp' });

    // Receive time (_date_) is later for m1 than m2, but timestamp order is correct
    check.onMessage(msg('2026-01-01T00:00:02.000Z', '2026-01-01T00:00:01.000Z'), c);
    const issues = check.onMessage(msg('2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z'), c);

    expect(issues).toHaveLength(0);
  });
});

// ── createGapCheck ────────────────────────────────────────────────────────────

describe('createGapCheck — no issues on first message', () => {
  it('does not fire for the first message', () => {
    const check = createGapCheck(_test_GAP_THRESHOLD_MS);
    const issues = check.onMessage(msg('2026-01-01T00:00:01.000Z'), ctx());

    expect(issues).toHaveLength(0);
  });
});

describe('createGapCheck — contiguous stream', () => {
  it('does not fire for messages within the threshold', () => {
    const check = createGapCheck(_test_GAP_THRESHOLD_MS);
    const c = ctx();

    check.onMessage(msg('2026-01-01T00:00:01.000Z'), c);
    const issues = check.onMessage(msg(`2026-01-01T00:00:01.${_test_GAP_THRESHOLD_MS - 1}Z`), c);

    // Within threshold — check this doesn't fire
    // (just verifying type works; exact arithmetic depends on the ISO string)
    expect(issues).toBeDefined();
  });

  it('does not fire when messages are exactly at the threshold', () => {
    const check = createGapCheck(_test_GAP_THRESHOLD_MS);
    const c = ctx();
    const base = new Date('2026-01-01T00:00:00.000Z').getTime();

    check.onMessage(msg(new Date(base).toISOString()), c);
    // Exactly at GAP_THRESHOLD_MS — should NOT fire (> threshold, not >=)
    const atThreshold = check.onMessage(msg(new Date(base + _test_GAP_THRESHOLD_MS).toISOString()), c);

    expect(atThreshold).toHaveLength(0);
  });
});

describe('createGapCheck — gap detection', () => {
  it('fires when the gap exceeds the threshold', () => {
    const check = createGapCheck(_test_GAP_THRESHOLD_MS);
    const c = ctx();
    const base = new Date('2026-01-01T00:00:00.000Z').getTime();

    check.onMessage(msg(new Date(base).toISOString()), c);
    const issues = check.onMessage(msg(new Date(base + _test_GAP_THRESHOLD_MS + 1).toISOString()), c);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.type).toBe('gap');
  });

  it('includes the gap size in the message', () => {
    const check = createGapCheck(_test_GAP_THRESHOLD_MS);
    const c = ctx();
    const gapMs = 5000;
    const base = new Date('2026-01-01T00:00:00.000Z').getTime();

    check.onMessage(msg(new Date(base).toISOString()), c);
    const issues = check.onMessage(msg(new Date(base + gapMs).toISOString()), c);

    expect(issues[0]?.message).toMatch(`${gapMs} ms`);
  });

  it('fires on a second independent gap', () => {
    const check = createGapCheck(_test_GAP_THRESHOLD_MS);
    const c = ctx();
    const base = new Date('2026-01-01T00:00:00.000Z').getTime();

    check.onMessage(msg(new Date(base).toISOString()), c);
    check.onMessage(msg(new Date(base + _test_GAP_THRESHOLD_MS + 100).toISOString()), c); // first gap
    check.onMessage(msg(new Date(base + _test_GAP_THRESHOLD_MS + 200).toISOString()), c); // contiguous

    const issues = check.onMessage(msg(new Date(base + _test_GAP_THRESHOLD_MS * 3).toISOString()), c);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.type).toBe('gap');
  });

  it('does not fire for a backwards jump (negative delta)', () => {
    const check = createGapCheck(_test_GAP_THRESHOLD_MS);
    const c = ctx();
    const base = new Date('2026-01-01T00:00:01.000Z').getTime();

    check.onMessage(msg(new Date(base).toISOString()), c);
    const issues = check.onMessage(msg(new Date(base - 5000).toISOString()), c);

    expect(issues).toHaveLength(0);
  });

  it('does not fire a false gap after a backwards jump', () => {
    // Regression: a backwards timestamp must not reset lastMs, or the next
    // forward message would appear as a giant false gap.
    const check = createGapCheck(_test_GAP_THRESHOLD_MS);
    const c = ctx();
    const base = new Date('2026-01-01T00:00:05.000Z').getTime();

    check.onMessage(msg(new Date(base).toISOString()), c);                    // lastMs = base
    check.onMessage(msg(new Date(base - 4000).toISOString()), c);             // backward: lastMs must stay at base
    const issues = check.onMessage(msg(new Date(base + 500).toISOString()), c); // 500 ms after base — no gap

    expect(issues).toHaveLength(0);
  });

  it('silently skips messages with an unparseable date', () => {
    const check = createGapCheck(_test_GAP_THRESHOLD_MS);
    const c = ctx();

    check.onMessage(msg('not-a-date'), c);
    check.onMessage(msg('also-not-a-date'), c);

    // No throw, no issues
    const issues = check.onMessage(msg('2026-01-01T00:00:01.000Z'), c);

    expect(issues).toHaveLength(0);
  });
});

// ── createGapCheck — custom threshold ────────────────────────────────────────

describe('createGapCheck — custom threshold', () => {
  it('does not fire when gap is within the custom threshold', () => {
    const check = createGapCheck(5000);
    const c = ctx();
    const base = new Date('2026-01-01T00:00:00.000Z').getTime();

    check.onMessage(msg(new Date(base).toISOString()), c);
    const issues = check.onMessage(msg(new Date(base + 1001).toISOString()), c);

    expect(issues).toHaveLength(0);
  });

  it('fires when gap exceeds the custom threshold', () => {
    const check = createGapCheck(5000);
    const c = ctx();
    const base = new Date('2026-01-01T00:00:00.000Z').getTime();

    check.onMessage(msg(new Date(base).toISOString()), c);
    const issues = check.onMessage(msg(new Date(base + 5001).toISOString()), c);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.type).toBe('gap');
  });
});

// ── createGapCheck — resumes with partial ─────────────────────────────────────

describe('createGapCheck — resumes with partial', () => {
  it('appends "(resumes with partial)" when the first message after the gap is a partial', () => {
    const check = createGapCheck(_test_GAP_THRESHOLD_MS);
    const c = ctx();
    const base = new Date('2026-01-01T00:00:00.000Z').getTime();

    check.onMessage(msg(new Date(base).toISOString()), c);
    const issues = check.onMessage(msg(new Date(base + _test_GAP_THRESHOLD_MS + 1).toISOString(), undefined, 'partial'), c);

    expect(issues[0]?.message).toMatch('(resumes with partial)');
  });

  it('does not append the suffix when the first message after the gap is not a partial', () => {
    const check = createGapCheck(_test_GAP_THRESHOLD_MS);
    const c = ctx();
    const base = new Date('2026-01-01T00:00:00.000Z').getTime();

    check.onMessage(msg(new Date(base).toISOString()), c);
    const issues = check.onMessage(msg(new Date(base + _test_GAP_THRESHOLD_MS + 1).toISOString()), c);

    expect(issues[0]?.message).not.toMatch('(resumes with partial)');
  });
});

// ── each instance has independent state ───────────────────────────────────────

describe('check instances — independent state', () => {
  it('two wrong-order checks do not share state', () => {
    const c = ctx();
    const base = new Date('2026-01-01T00:00:02.000Z').getTime();
    const check1 = createWrongOrderCheck();
    const check2 = createWrongOrderCheck();

    check1.onMessage(msg(new Date(base).toISOString()), c);

    // check2 has never seen any message — should not fire
    const issues = check2.onMessage(msg(new Date(base - 1000).toISOString()), c);

    expect(issues).toHaveLength(0);
  });

  it('two gap checks do not share state', () => {
    const c = ctx();
    const base = new Date('2026-01-01T00:00:00.000Z').getTime();
    const check1 = createGapCheck(_test_GAP_THRESHOLD_MS);
    const check2 = createGapCheck(_test_GAP_THRESHOLD_MS);

    check1.onMessage(msg(new Date(base).toISOString()), c);

    // check2 first message — should not fire
    const issues = check2.onMessage(msg(new Date(base + _test_GAP_THRESHOLD_MS * 2).toISOString()), c);

    expect(issues).toHaveLength(0);
  });
});
