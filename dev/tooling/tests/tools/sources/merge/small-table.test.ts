import { describe, it, expect } from 'vitest';
import { mergeTable } from '../../../../src/tools/sources/merge/algorithm';
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
    [toAsyncIterable(a), toAsyncIterable(b)],
    async m => { output.push(m); },
    { timestampCol: null },
  );

  return output;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('mergeTable (no timestampCol) — first-source-wins per timestamp', () => {
  it('returns one copy when both files are identical (same _date_ → A wins, B skipped)', async () => {
    const msgs = [
      msg('insert', '1', 'hello'),
      msg('insert', '2', 'world'),
    ];

    const result = await collect([...msgs], [...msgs]);

    expect(result).toHaveLength(2);
  });

  it('A wins when both sources have the same _date_ — A version kept', async () => {
    const ts = '2024-01-01T00:00:01.000Z';
    // Same canonical timestamp (_date_), different id — A has priority.
    const aMsg = msg('insert', '1', 'text-A', ts);
    const bMsg = msg('insert', '2', 'text-B', ts);

    const result = await collect([aMsg], [bMsg]);

    expect(result).toHaveLength(1);
    expect(result[0].rows[0]?.['id']).toBe('1'); // A's message kept
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

  it('same canonical _date_ in both sources — A wins, B skipped (even if content differs)', async () => {
    const aMsg = msg('insert', '1', 'hello', '2024-01-01T00:00:01.000Z');
    const bMsg = msg('update', '2', 'world', '2024-01-01T00:00:01.000Z');  // same _date_, different content

    const result = await collect([aMsg], [bMsg]);

    expect(result).toHaveLength(1);
    expect(result[0].action).toBe('insert'); // A's version
  });
});

describe('mergeTable (no timestampCol) — partials', () => {
  it('same-timestamp partial in both sources — A wins, B skipped', async () => {
    const ts = '2024-01-01T00:00:01.000Z';
    const p  = msg('partial', '', '', ts);

    const result = await collect([p], [p]);

    expect(result).toHaveLength(1);
    expect(result[0].action).toBe('partial');
  });

  it('partials at different timestamps — both kept (each owns its timestamp)', async () => {
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
  it('same-timestamp multi-row message in both sources — A wins, B skipped (whole message)', async () => {
    const ts = '2024-01-01T00:00:01.000Z';
    const a = [multiMsg('insert', '1', 3, ts)];
    const b = [multiMsg('insert', '1', 3, ts)];

    const result = await collect(a, b);

    expect(result).toHaveLength(1);
    expect(result[0].rows).toHaveLength(3);
  });

  it('multi-row messages at different timestamps — both kept', async () => {
    const a = [multiMsg('insert', '1', 3, '2024-01-01T00:00:01.000Z')];
    const b = [multiMsg('insert', '2', 3, '2024-01-01T00:00:02.000Z')];  // different id

    const result = await collect(a, b);

    expect(result).toHaveLength(2);
  });
});

describe('mergeTable (no timestampCol) — distinct timestamps always kept', () => {
  it('insert and delete at different timestamps — both kept', async () => {
    const a = [msg('insert', '1', 'hello', '2024-01-01T00:00:01.000Z')];
    const b = [msg('delete', '1', 'hello', '2024-01-01T00:00:02.000Z')];

    const result = await collect(a, b);

    expect(result).toHaveLength(2);
    expect(result.map(m => m.action).sort()).toEqual(['delete', 'insert']);
  });
});

// ── N-way timestamp ownership combinations (_date_ canonical) ─────────────────
//
// Same ownership rules as large tables, but using _date_ as the canonical
// field (timestampCol: null).

describe('mergeTable (no timestampCol) — N-way timestamp ownership (3 streams)', () => {
  async function collectN3(streams: ReturnType<typeof msg>[][]): Promise<ReturnType<typeof msg>[]> {
    const output: ReturnType<typeof msg>[] = [];

    await mergeTable(
      streams.map(s => (async function* () { for (const m of s) yield m; })()),
      async m => { output.push(m); },
      { timestampCol: null },
    );

    return output;
  }

  const D1 = '2024-01-01T00:00:01.000Z';
  const D2 = '2024-01-01T00:00:02.000Z';
  const D3 = '2024-01-01T00:00:03.000Z';
  const D4 = '2024-01-01T00:00:04.000Z';

  function srcMsg(source: string, date: string, tag = ''): ReturnType<typeof msg> {
    return msg('insert', `${source}${tag}`, date, date); // _date_ = canonical
  }

  it('only A has a _date_ — taken from A', async () => {
    const result = await collectN3([[srcMsg('A', D1)], [], []]);
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe(D1);
  });

  it('only B has a _date_ — taken from B', async () => {
    const result = await collectN3([[], [srcMsg('B', D1)], []]);
    expect(result).toHaveLength(1);
  });

  it('only C has a _date_ — taken from C', async () => {
    const result = await collectN3([[], [], [srcMsg('C', D1)]]);
    expect(result).toHaveLength(1);
  });

  it('A and B share _date_ (not C) — A wins, B skipped', async () => {
    const result = await collectN3([
      [srcMsg('A', D1)],
      [srcMsg('B', D1)],
      [],
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].action).toBe('insert');
  });

  it('A and C share _date_ (not B) — A wins, C skipped', async () => {
    const result = await collectN3([
      [srcMsg('A', D1)],
      [],
      [srcMsg('C', D1)],
    ]);

    expect(result).toHaveLength(1);
  });

  it('B and C share _date_ (not A) — B wins, C skipped', async () => {
    const result = await collectN3([
      [],
      [srcMsg('B', D1)],
      [srcMsg('C', D1)],
    ]);

    expect(result).toHaveLength(1);
  });

  it('all three share _date_ — A wins, B and C both skipped', async () => {
    const result = await collectN3([
      [srcMsg('A', D1)],
      [srcMsg('B', D1)],
      [srcMsg('C', D1)],
    ]);

    expect(result).toHaveLength(1);
  });

  it('winner has multiple messages at same _date_ — all written; non-winner skipped', async () => {
    // A has two messages at D2; B also has one at D2 — both of A's written, B's skipped.
    const result = await collectN3([
      [srcMsg('A', D2, 'x'), srcMsg('A', D2, 'y')],
      [srcMsg('B', D2)],
      [],
    ]);

    expect(result).toHaveLength(2);
  });

  it('non-winner has multiple messages at same _date_ — all skipped', async () => {
    const result = await collectN3([
      [srcMsg('A', D1), srcMsg('A', D2)],
      [srcMsg('B', D1, 'x'), srcMsg('B', D1, 'y'), srcMsg('B', D1, 'z'), srcMsg('B', D3)],
      [],
    ]);

    // D1 → A (1); D2 → A (1); D3 → B (1). Three B messages at D1 all skipped.
    expect(result).toHaveLength(3);
  });

  it('later _date_ from lower-priority source taken once higher-priority has moved on', async () => {
    const result = await collectN3([
      [srcMsg('A', D1), srcMsg('A', D2)],
      [srcMsg('B', D1), srcMsg('B', D3)],
      [srcMsg('C', D4)],
    ]);

    // D1 → A; D2 → A; D3 → B; D4 → C
    expect(result).toHaveLength(4);
    const dates = result.map(m => m.date);
    expect(dates).toEqual([D1, D2, D3, D4]);
  });
});

// ── No partial precedence on small tables ─────────────────────────────────────
//
// Partials are only privileged when the table has a `timestamp` column. Small
// tables (canonical = `_date_`) follow plain first-source-wins, so a partial
// in a non-winner source is dropped at a clashed `_date_` exactly like any
// other message.

describe('mergeTable (no timestampCol) — partials are NOT privileged', () => {
  it('partial in lower-priority source is dropped when higher-priority has any message at same _date_', async () => {
    const ts = '2024-01-01T00:00:01.000Z';

    // A has a regular insert at ts; B has a partial at ts. A wins (small table).
    const aMsg = msg('insert', '1', 'hello', ts);
    const bMsg = msg('partial', '', '', ts);

    const result = await collect([aMsg], [bMsg]);

    expect(result).toHaveLength(1);
    expect(result[0].action).toBe('insert');  // A's insert kept; B's partial dropped
  });
});
