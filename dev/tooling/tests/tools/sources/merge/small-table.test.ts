import { describe, it, expect } from 'vitest';
import { mergeTable, _test_messageKey } from '../../../../src/tools/sources/merge/algorithm';
import type { Message } from '../../../../src/tools/sources/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COLUMNS = ['_date_', '_action_', 'id', 'text'];

function parseRow(line: string): Record<string, string> {
  const values = line.split(',').map(v => v.trim());
  const record: Record<string, string> = {};

  COLUMNS.forEach((col, idx) => {
    record[col] = values[idx] ?? '';
  });

  return record;
}

function msg(
  action: string,
  id: string,
  text: string,
  date: string = `rx-${action}-${id}`,
): Message {
  const csvLine = `${date},${action},${id},${text}`;
  const row = parseRow(csvLine);

  return {
    rows:      [row],
    date,
    action,
    timestamp: '',
  };
}

/** Multi-row message. */
function multiMsg(
  action: string,
  id: string,
  rowCount: number,
  date: string = `rx-${action}-${id}`,
): Message {
  const rows = [
    parseRow(`${date},${action},${id},text-0`),
    ...Array.from({ length: rowCount - 1 }, (_, i) => parseRow(`,,${id}-cont-${i},text-${i + 1}`)),
  ];

  return { rows, date, action, timestamp: '' };
}

async function* toAsyncIterable<T>(arr: T[]): AsyncGenerator<T> {
  for (const item of arr) {
    yield item;
  }
}

/** Collect all output messages from a merge (timestampCol: null — uses _date_ as canonical). */
async function collect(a: Message[], b: Message[]): Promise<Message[]> {
  const output: Message[] = [];

  await mergeTable(
    toAsyncIterable(a),
    toAsyncIterable(b),
    async m => { output.push(m); },
    { timestampCol: null },
  );

  return output;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('mergeTable (no timestampCol) — deduplication', () => {
  it('returns one copy when both files are identical', async () => {
    const msgs = [
      msg('insert', '1', 'hello'),
      msg('insert', '2', 'world'),
    ];

    const result = await collect([...msgs], [...msgs]);

    expect(result).toHaveLength(2);
  });

  it('keeps the A (base) version of a duplicate', async () => {
    const aMsg = msg('insert', '1', 'hello', 'date-from-A');
    const bMsg = msg('insert', '1', 'hello', 'date-from-B');

    const result = await collect([aMsg], [bMsg]);

    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('date-from-A');
  });

  it('includes unique messages from both files', async () => {
    const a = [msg('insert', '1', 'hello', '2024-01-01T00:00:01.000Z')];
    const b = [msg('insert', '2', 'world', '2024-01-01T00:00:02.000Z')];

    const result = await collect(a, b);

    expect(result).toHaveLength(2);
    const ids = result.map(m => m.rows[0]['id']);
    expect(ids).toContain('1');
    expect(ids).toContain('2');
  });

  it('treats messages with different content as distinct even if same id', async () => {
    // Same id but different text field — both are real events.
    const a = [msg('update', '1', 'original-text', '2024-01-01T00:00:01.000Z')];
    const b = [msg('update', '1', 'different-text', '2024-01-01T00:00:02.000Z')];

    const result = await collect(a, b);

    expect(result).toHaveLength(2);
  });

  it('deduplicates regardless of _date_ value', async () => {
    const aMsg = msg('insert', '1', 'hello', '2024-01-01T00:00:01.000Z');
    const bMsg = msg('insert', '1', 'hello', '2024-01-01T00:00:01.000Z');  // same _date_ = same canonical

    const result = await collect([aMsg], [bMsg]);

    expect(result).toHaveLength(1);
  });
});

describe('mergeTable (no timestampCol) — partials', () => {
  // Partials are treated as regular messages and deduplicated by hash.
  // For tables with empty or fixed-content partials, this means all but one
  // occurrence is dropped — see merge.ts for the rationale.
  it('deduplicates identical partials to one', async () => {
    const ts = '2024-01-01T00:00:01.000Z';
    const p  = msg('partial', '', '', ts);

    const result = await collect([p], [p]);

    expect(result).toHaveLength(1);
    expect(result[0].action).toBe('partial');
  });

  it('keeps partials with different content as distinct messages', async () => {
    // Two partial snapshots with different content (e.g. different state)
    const a = [msg('partial', '1', 'state-A', '2024-01-01T00:00:01.000Z')];
    const b = [msg('partial', '2', 'state-B', '2024-01-01T00:00:02.000Z')];

    const result = await collect(a, b);

    expect(result).toHaveLength(2);
  });
});

describe('mergeTable (no timestampCol) — sort order', () => {
  it('output is ordered by canonical (_date_) ascending', async () => {
    // Each file is individually sorted; the merge interleaves them.
    const a = [
      msg('insert', '1', 'hello', '2024-01-01T00:00:03.000Z'),
      msg('insert', '2', 'world', '2024-01-01T00:00:05.000Z'),
    ];

    const b = [
      msg('insert', '3', 'foo', '2024-01-01T00:00:01.000Z'),
      msg('insert', '4', 'bar', '2024-01-01T00:00:04.000Z'),
    ];

    const result = await collect(a, b);

    const dates = result.map(m => m.date);
    expect(dates).toEqual([
      '2024-01-01T00:00:01.000Z',
      '2024-01-01T00:00:03.000Z',
      '2024-01-01T00:00:04.000Z',
      '2024-01-01T00:00:05.000Z',
    ]);
  });
});

describe('mergeTable (no timestampCol) — empty inputs', () => {
  it('returns empty when both files are empty', async () => {
    expect(await collect([], [])).toHaveLength(0);
  });

  it('returns A content when B is empty', async () => {
    const a = [
      msg('insert', '1', 'hello', '2024-01-01T00:00:01.000Z'),
      msg('insert', '2', 'world', '2024-01-01T00:00:02.000Z'),
    ];

    const result = await collect(a, []);

    expect(result).toHaveLength(2);
  });

  it('returns B content when A is empty', async () => {
    const b = [
      msg('insert', '1', 'hello', '2024-01-01T00:00:01.000Z'),
      msg('insert', '2', 'world', '2024-01-01T00:00:02.000Z'),
    ];

    const result = await collect([], b);

    expect(result).toHaveLength(2);
  });
});

describe('mergeTable (no timestampCol) — multi-row messages', () => {
  it('treats multi-row messages as a single unit for dedup', async () => {
    const ts = '2024-01-01T00:00:01.000Z';
    const a = [multiMsg('insert', '1', 3, ts)];
    const b = [multiMsg('insert', '1', 3, ts)];  // identical content and canonical

    const result = await collect(a, b);

    expect(result).toHaveLength(1);
    expect(result[0].rows).toHaveLength(3);
  });

  it('keeps both when multi-row messages differ in content', async () => {
    const a = [multiMsg('insert', '1', 3, '2024-01-01T00:00:01.000Z')];
    const b = [multiMsg('insert', '2', 3, '2024-01-01T00:00:02.000Z')];  // different id

    const result = await collect(a, b);

    expect(result).toHaveLength(2);
  });
});

describe('mergeTable (no timestampCol) — action included in dedup key', () => {
  it('keeps insert and delete of the same item as distinct messages', async () => {
    const a = [msg('insert', '1', 'hello', '2024-01-01T00:00:01.000Z')];
    const b = [msg('delete', '1', 'hello', '2024-01-01T00:00:02.000Z')];

    const result = await collect(a, b);

    expect(result).toHaveLength(2);
    expect(result.map(m => m.action).sort()).toEqual(['delete', 'insert']);
  });
});

// ── _test_messageKey ──────────────────────────────────────────────────────────

describe('_test_messageKey', () => {
  it('produces the same key for messages with different _date_ but same content', () => {
    const a = msg('insert', '1', 'hello', 'date-A');
    const b = msg('insert', '1', 'hello', 'date-B');

    expect(_test_messageKey(a)).toBe(_test_messageKey(b));
  });

  it('produces different keys for messages with different content', () => {
    const a = msg('insert', '1', 'hello');
    const b = msg('insert', '1', 'world');

    expect(_test_messageKey(a)).not.toBe(_test_messageKey(b));
  });

  it('produces different keys for different actions on same content', () => {
    const a = msg('insert', '1', 'hello');
    const b = msg('delete', '1', 'hello');

    expect(_test_messageKey(a)).not.toBe(_test_messageKey(b));
  });
});
