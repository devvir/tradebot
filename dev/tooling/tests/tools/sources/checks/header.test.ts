import { describe, it, expect } from 'vitest';
import { headerCheck, midStreamHeaderCheck } from '../../../../src/tools/sources/checks/header';
import type { CheckContext } from '../../../../src/tools/sources/checks/types';
import type { Message } from '../../../../src/tools/sources/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_HEADER = '_date_,_action_,timestamp,symbol,price';

function ctx(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    filePath:     '/data/vault/orderBookL2/2026/20260101.csv.gz',
    tableName:    'orderBookL2',
    header:       null,
    timestampCol: 'timestamp',
    ...overrides,
  };
}

/** Parse a CSV line into a record using the given column names. */
function parseRow(line: string, columns: string[]): Record<string, string> {
  const values = line.split(',').map(v => v.trim());
  const record: Record<string, string> = {};

  columns.forEach((col, idx) => {
    record[col] = values[idx] ?? '';
  });

  return record;
}

function msg(firstLine: string, columns: string[] = ['_date_', '_action_', 'timestamp', 'symbol', 'price']): Message {
  const row = parseRow(firstLine, columns);

  return {
    rows:      [row],
    date:      row['_date_'] ?? '2026-01-01T00:00:00.000Z',
    action:    row['_action_'] ?? 'insert',
    timestamp: row['timestamp'] ?? '',
  };
}

// ── headerCheck (pre-pass) ────────────────────────────────────────────────────

describe('headerCheck — valid header', () => {
  it('returns no issues and the parsed header', () => {
    const { issues, recoveredHeader } = headerCheck.run(VALID_HEADER, ctx());

    expect(issues).toHaveLength(0);
    expect(recoveredHeader).not.toBeNull();
    expect(recoveredHeader?.columns).toEqual(['_date_', '_action_', 'timestamp', 'symbol', 'price']);
    expect(recoveredHeader?.hasTimestamp).toBe(true);
  });

  it('returns columns in the correct order', () => {
    const { recoveredHeader } = headerCheck.run(VALID_HEADER, ctx());

    expect(recoveredHeader?.columns).toEqual(['_date_', '_action_', 'timestamp', 'symbol', 'price']);
  });
});

describe('headerCheck — missing columns', () => {
  it('emits missing-header when _date_ is missing', () => {
    const { issues, recoveredHeader } = headerCheck.run('_action_,timestamp,symbol', ctx());

    expect(issues).toHaveLength(1);
    expect(issues[0]?.type).toBe('missing-header');
    expect(recoveredHeader).toBeNull();
  });

  it('emits missing-header when file is empty', () => {
    const { issues, recoveredHeader } = headerCheck.run(null, ctx());

    expect(issues).toHaveLength(1);
    expect(issues[0]?.type).toBe('missing-header');
    expect(issues[0]?.message).toMatch(/empty/);
    expect(recoveredHeader).toBeNull();
  });
});
// ── midStreamHeaderCheck ──────────────────────────────────────────────────────

describe('midStreamHeaderCheck — header-in-wrong-row', () => {
  it('fires when a message starts with a header-looking row', () => {
    const issues = midStreamHeaderCheck.onMessage(msg(VALID_HEADER), ctx());

    expect(issues).toHaveLength(1);
    expect(issues[0]?.type).toBe('header-in-wrong-row');
  });

  it('does not fire for a normal data row', () => {
    const issues = midStreamHeaderCheck.onMessage(
      msg('2026-01-01T00:00:01.000Z,insert,2026-01-01T00:00:01.000Z,XBTUSD,30000'),
      ctx(),
    );

    expect(issues).toHaveLength(0);
  });
});
