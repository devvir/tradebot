import { describe, it, expect } from 'vitest';
import { mergeTable } from '../../../../src/tools/sources/merge/algorithm';
import type { Message } from '../../../../src/tools/sources/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COLUMNS = ['_date_', '_action_', 'timestamp', 'id', 'price'];

function parseRow(line: string): Record<string, string> {
  const values = line.split(',').map(v => v.trim());
  const record: Record<string, string> = {};

  COLUMNS.forEach((col, idx) => {
    record[col] = values[idx] ?? '';
  });

  return record;
}

/** Build a single-row message. ts format: "2024-01-01T00:00:XX.000Z" */
function msg(
  timestamp: string,
  action: string = 'insert',
  date: string = `rx-${timestamp}`,
  extra: string = '1,100',
): Message {
  const csvLine = `${date},${action},${timestamp},${extra}`;
  const row = parseRow(csvLine);

  return {
    rows:      [row],
    date,
    action,
    timestamp,
  };
}

/** Build a multi-row message (first row + N continuation rows). */
function multiMsg(
  timestamp: string,
  rowCount: number,
  action: string = 'partial',
  date: string = `rx-${timestamp}`,
): Message {
  const rows = [
    parseRow(`${date},${action},${timestamp},1,100`),
    ...Array.from({ length: rowCount - 1 }, (_, i) =>
      parseRow(`,,${timestamp},${i + 2},${(i + 2) * 100}`),
    ),
  ];

  return { rows, date, action, timestamp };
}

/** Collect all output messages from a merge. */
async function collect(
  a: Message[],
  b: Message[],
): Promise<{ messages: Message[]; warnings: string[] }> {
  const output: Message[] = [];

  const result = await mergeTable(
    toAsyncIterable(a),
    toAsyncIterable(b),
    async (msg) => {
      output.push(msg);
    },
    { timestampCol: 'timestamp' },
  );

  return { messages: output, warnings: result.warnings };
}

async function* toAsyncIterable<T>(arr: T[]): AsyncGenerator<T> {
  for (const item of arr) {
    yield item;
  }
}

function timestamps(messages: Message[]): string[] {
  return messages.map(m => m.timestamp);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('mergeTable — identical files', () => {
  it('deduplicates: output equals one copy of the input', async () => {
    const msgs = [
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:02.000Z'),
      msg('2024-01-01T00:00:03.000Z'),
    ];

    const { messages, warnings } = await collect(msgs, [...msgs]);

    expect(timestamps(messages)).toEqual([
      '2024-01-01T00:00:01.000Z',
      '2024-01-01T00:00:02.000Z',
      '2024-01-01T00:00:03.000Z',
    ]);
    expect(warnings).toHaveLength(0);
  });

  it('keeps the A (base) version of duplicate messages', async () => {
    const ts = '2024-01-01T00:00:01.000Z';
    const aMsg = msg(ts, 'insert', 'date-from-A');
    const bMsg = msg(ts, 'insert', 'date-from-B');

    const { messages } = await collect([aMsg], [bMsg]);

    expect(messages).toHaveLength(1);
    expect(messages[0].date).toBe('date-from-A');
  });

  it('keeps both when same canonical timestamp but different content', async () => {
    const ts = '2024-01-01T00:00:01.000Z';
    const aMsg = msg(ts, 'insert', 'rx-a', '1,100');   // id=1, price=100
    const bMsg = msg(ts, 'insert', 'rx-b', '2,200');   // id=2, price=200 — genuinely different event

    const { messages } = await collect([aMsg], [bMsg]);

    expect(messages).toHaveLength(2);
  });
});

describe('mergeTable — monotonicity violations', () => {
  it('throws when A timestamps go backwards', async () => {
    const a = [
      msg('2024-01-01T00:00:02.000Z'),
      msg('2024-01-01T00:00:01.000Z'),  // backwards
    ];

    await expect(collect(a, [])).rejects.toThrow(/went backwards/);
  });

  it('throws when B timestamps go backwards', async () => {
    const b = [
      msg('2024-01-01T00:00:02.000Z'),
      msg('2024-01-01T00:00:01.000Z'),  // backwards
    ];

    await expect(collect([], b)).rejects.toThrow(/went backwards/);
  });

  it('error message names the offending file label', async () => {
    const a = [
      msg('2024-01-01T00:00:02.000Z'),
      msg('2024-01-01T00:00:01.000Z'),
    ];

    await expect(
      mergeTable(
        toAsyncIterable(a),
        toAsyncIterable([]),
        async () => {},
        { timestampCol: 'timestamp', fileLabels: { a: 'my-base-file.csv', b: 'my-gaps-file.csv' } },
      ),
    ).rejects.toThrow('my-base-file.csv');
  });
});

describe('mergeTable — A starts earlier', () => {
  it('includes A-only prefix, then merged overlap', async () => {
    const a = [
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:02.000Z'),
      msg('2024-01-01T00:00:03.000Z'),
      msg('2024-01-01T00:00:04.000Z'),
    ];

    const b = [
      msg('2024-01-01T00:00:03.000Z'),
      msg('2024-01-01T00:00:04.000Z'),
    ];

    const { messages } = await collect(a, b);

    expect(timestamps(messages)).toEqual([
      '2024-01-01T00:00:01.000Z',
      '2024-01-01T00:00:02.000Z',
      '2024-01-01T00:00:03.000Z',
      '2024-01-01T00:00:04.000Z',
    ]);
  });
});

describe('mergeTable — B starts earlier', () => {
  it('includes B-only prefix, then merged overlap', async () => {
    const a = [
      msg('2024-01-01T00:00:03.000Z'),
      msg('2024-01-01T00:00:04.000Z'),
    ];

    const b = [
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:02.000Z'),
      msg('2024-01-01T00:00:03.000Z'),
      msg('2024-01-01T00:00:04.000Z'),
    ];

    const { messages } = await collect(a, b);

    expect(timestamps(messages)).toEqual([
      '2024-01-01T00:00:01.000Z',
      '2024-01-01T00:00:02.000Z',
      '2024-01-01T00:00:03.000Z',
      '2024-01-01T00:00:04.000Z',
    ]);
  });
});

describe('mergeTable — diverge then re-sync', () => {
  it('A has a gap that B fills', async () => {
    const a = [
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:02.000Z'),
      // gap: 03, 04 missing from A
      msg('2024-01-01T00:00:05.000Z'),
      msg('2024-01-01T00:00:06.000Z'),
    ];

    const b = [
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:02.000Z'),
      msg('2024-01-01T00:00:03.000Z'),
      msg('2024-01-01T00:00:04.000Z'),
      msg('2024-01-01T00:00:05.000Z'),
      msg('2024-01-01T00:00:06.000Z'),
    ];

    const { messages } = await collect(a, b);

    expect(timestamps(messages)).toEqual([
      '2024-01-01T00:00:01.000Z',
      '2024-01-01T00:00:02.000Z',
      '2024-01-01T00:00:03.000Z',
      '2024-01-01T00:00:04.000Z',
      '2024-01-01T00:00:05.000Z',
      '2024-01-01T00:00:06.000Z',
    ]);
  });

  it('B has a gap that A fills', async () => {
    const a = [
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:02.000Z'),
      msg('2024-01-01T00:00:03.000Z'),
      msg('2024-01-01T00:00:04.000Z'),
      msg('2024-01-01T00:00:05.000Z'),
    ];

    const b = [
      msg('2024-01-01T00:00:01.000Z'),
      // gap: 02, 03 missing from B
      msg('2024-01-01T00:00:04.000Z'),
      msg('2024-01-01T00:00:05.000Z'),
    ];

    const { messages } = await collect(a, b);

    expect(timestamps(messages)).toEqual([
      '2024-01-01T00:00:01.000Z',
      '2024-01-01T00:00:02.000Z',
      '2024-01-01T00:00:03.000Z',
      '2024-01-01T00:00:04.000Z',
      '2024-01-01T00:00:05.000Z',
    ]);
  });

  it('both have different gaps that each fills for the other', async () => {
    // A missing: 03, 04 — B missing: 07, 08
    const a = [
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:02.000Z'),
      msg('2024-01-01T00:00:05.000Z'),
      msg('2024-01-01T00:00:06.000Z'),
      msg('2024-01-01T00:00:07.000Z'),
      msg('2024-01-01T00:00:08.000Z'),
    ];

    const b = [
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:02.000Z'),
      msg('2024-01-01T00:00:03.000Z'),
      msg('2024-01-01T00:00:04.000Z'),
      msg('2024-01-01T00:00:05.000Z'),
      msg('2024-01-01T00:00:06.000Z'),
    ];

    const { messages } = await collect(a, b);

    expect(timestamps(messages)).toEqual([
      '2024-01-01T00:00:01.000Z',
      '2024-01-01T00:00:02.000Z',
      '2024-01-01T00:00:03.000Z',
      '2024-01-01T00:00:04.000Z',
      '2024-01-01T00:00:05.000Z',
      '2024-01-01T00:00:06.000Z',
      '2024-01-01T00:00:07.000Z',
      '2024-01-01T00:00:08.000Z',
    ]);
  });
});

describe('mergeTable — no overlap', () => {
  it('concatenates when A ends before B starts', async () => {
    const a = [
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:02.000Z'),
    ];

    const b = [
      msg('2024-01-01T01:00:00.000Z'),
      msg('2024-01-01T01:00:01.000Z'),
    ];

    const { messages, warnings } = await collect(a, b);

    expect(timestamps(messages)).toEqual([
      '2024-01-01T00:00:01.000Z',
      '2024-01-01T00:00:02.000Z',
      '2024-01-01T01:00:00.000Z',
      '2024-01-01T01:00:01.000Z',
    ]);

    // No re-sync occurs, so no short-gap warning.
    expect(warnings).toHaveLength(0);
  });

  it('concatenates when B ends before A starts', async () => {
    const a = [
      msg('2024-01-01T01:00:00.000Z'),
      msg('2024-01-01T01:00:01.000Z'),
    ];

    const b = [
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:02.000Z'),
    ];

    const { messages } = await collect(a, b);

    expect(timestamps(messages)).toEqual([
      '2024-01-01T00:00:01.000Z',
      '2024-01-01T00:00:02.000Z',
      '2024-01-01T01:00:00.000Z',
      '2024-01-01T01:00:01.000Z',
    ]);
  });
});

describe('mergeTable — one file empty', () => {
  it('returns all A messages when B is empty', async () => {
    const a = [
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:02.000Z'),
    ];

    const { messages } = await collect(a, []);

    expect(timestamps(messages)).toEqual([
      '2024-01-01T00:00:01.000Z',
      '2024-01-01T00:00:02.000Z',
    ]);
  });

  it('returns all B messages when A is empty', async () => {
    const b = [
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:02.000Z'),
    ];

    const { messages } = await collect([], b);

    expect(timestamps(messages)).toEqual([
      '2024-01-01T00:00:01.000Z',
      '2024-01-01T00:00:02.000Z',
    ]);
  });

  it('returns empty output when both files are empty', async () => {
    const { messages } = await collect([], []);
    expect(messages).toHaveLength(0);
  });
});

describe('mergeTable — short-gap warning', () => {
  it('warns when the gap resolves in less than 1 second', async () => {
    // B has a gap from 500ms to 800ms — only 300ms, below threshold.
    const a = [
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:01.500Z'),
      msg('2024-01-01T00:00:01.800Z'),
      msg('2024-01-01T00:00:02.000Z'),
    ];

    const b = [
      msg('2024-01-01T00:00:01.000Z'),
      // gap: 500ms and 800ms missing from B
      msg('2024-01-01T00:00:02.000Z'),
    ];

    const { warnings } = await collect(a, b);

    // gapStart = 1.500Z (first A message B skips), re-sync = 2.000Z → 500ms
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/short gap/i);
    expect(warnings[0]).toMatch(/500ms/);
  });

  it('does not warn when the gap is at least 1 second', async () => {
    const a = [
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:02.000Z'),
      msg('2024-01-01T00:00:03.000Z'),
      msg('2024-01-01T00:00:10.000Z'),
    ];

    const b = [
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:10.000Z'),
    ];

    const { warnings } = await collect(a, b);

    expect(warnings).toHaveLength(0);
  });

  it('warns once per short gap, not once per message', async () => {
    // A has 5 messages in a 200ms window that B skips — should be 1 warning.
    const a = [
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:01.040Z'),
      msg('2024-01-01T00:00:01.080Z'),
      msg('2024-01-01T00:00:01.120Z'),
      msg('2024-01-01T00:00:01.160Z'),
      msg('2024-01-01T00:00:01.200Z'),
      msg('2024-01-01T00:00:05.000Z'),
    ];

    const b = [
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:01.200Z'),
      msg('2024-01-01T00:00:05.000Z'),
    ];

    const { warnings } = await collect(a, b);

    expect(warnings).toHaveLength(1);
  });
});

describe('mergeTable — multi-row messages', () => {
  it('writes all rows of a multi-row message atomically', async () => {
    const big   = multiMsg('2024-01-01T00:00:01.000Z', 5, 'partial');
    const small = msg('2024-01-01T00:00:02.000Z');

    const allMsgs: Message[] = [];

    await mergeTable(
      toAsyncIterable([big, small]),
      toAsyncIterable([]),
      async (m) => { allMsgs.push(m); },
      { timestampCol: 'timestamp' },
    );

    expect(allMsgs).toHaveLength(2);
    expect(allMsgs[0]?.rows).toHaveLength(5);  // partial has 5 rows
    expect(allMsgs[1]?.rows).toHaveLength(1);  // single row
  });

  it('deduplicates multi-row messages with identical content', async () => {
    const big = multiMsg('2024-01-01T00:00:01.000Z', 4, 'partial');
    const a = [big, msg('2024-01-01T00:00:02.000Z')];
    const b = [big, msg('2024-01-01T00:00:02.000Z')];

    const { messages } = await collect(a, b);

    expect(messages).toHaveLength(2);
    expect(messages[0].rows).toHaveLength(4);
  });

  it('correctly merges when A has a multi-row partial and B fills subsequent gap', async () => {
    const partial = multiMsg('2024-01-01T00:00:00.000Z', 3, 'partial');

    const a = [
      partial,
      msg('2024-01-01T00:00:01.000Z'),
      // gap: 02 missing from A
      msg('2024-01-01T00:00:03.000Z'),
    ];

    const b = [
      partial,
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:02.000Z'),
      msg('2024-01-01T00:00:03.000Z'),
    ];

    const { messages } = await collect(a, b);

    expect(timestamps(messages)).toEqual([
      '2024-01-01T00:00:00.000Z',
      '2024-01-01T00:00:01.000Z',
      '2024-01-01T00:00:02.000Z',
      '2024-01-01T00:00:03.000Z',
    ]);
    expect(messages[0].rows).toHaveLength(3);
  });
});

describe('mergeTable — partials at different timestamps', () => {
  it('keeps both partials when they occur at different timestamps', async () => {
    // A reconnected at ts=02, B reconnected at ts=05 — both partials kept.
    const a = [
      msg('2024-01-01T00:00:01.000Z'),
      multiMsg('2024-01-01T00:00:02.000Z', 2, 'partial'),
      msg('2024-01-01T00:00:03.000Z'),
    ];

    const b = [
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:03.000Z'),
      msg('2024-01-01T00:00:04.000Z'),
      multiMsg('2024-01-01T00:00:05.000Z', 2, 'partial'),
      msg('2024-01-01T00:00:06.000Z'),
    ];

    const { messages } = await collect(a, b);

    expect(timestamps(messages)).toEqual([
      '2024-01-01T00:00:01.000Z',
      '2024-01-01T00:00:02.000Z',
      '2024-01-01T00:00:03.000Z',
      '2024-01-01T00:00:04.000Z',
      '2024-01-01T00:00:05.000Z',
      '2024-01-01T00:00:06.000Z',
    ]);

    const actions = messages.map(m => m.action);
    expect(actions).toContain('partial');
    expect(actions.filter(a => a === 'partial')).toHaveLength(2);
  });
});

describe('mergeTable — output ordering', () => {
  it('output is strictly ordered by timestamp', async () => {
    const a = [
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:03.000Z'),
      msg('2024-01-01T00:00:05.000Z'),
    ];

    const b = [
      msg('2024-01-01T00:00:02.000Z'),
      msg('2024-01-01T00:00:04.000Z'),
      msg('2024-01-01T00:00:06.000Z'),
    ];

    const { messages } = await collect(a, b);

    const ts = timestamps(messages);

    for (let i = 1; i < ts.length; i++) {
      expect(ts[i] >= ts[i - 1]).toBe(true);
    }

    expect(ts).toEqual([
      '2024-01-01T00:00:01.000Z',
      '2024-01-01T00:00:02.000Z',
      '2024-01-01T00:00:03.000Z',
      '2024-01-01T00:00:04.000Z',
      '2024-01-01T00:00:05.000Z',
      '2024-01-01T00:00:06.000Z',
    ]);
  });

  it('written count matches output messages', async () => {
    const a = [msg('2024-01-01T00:00:01.000Z'), msg('2024-01-01T00:00:03.000Z')];
    const b = [msg('2024-01-01T00:00:02.000Z'), msg('2024-01-01T00:00:03.000Z')];

    const { messages, warnings: _ } = await collect(a, b);

    // 01, 02, 03 (03 deduplicated — same content in both files)
    expect(messages).toHaveLength(3);
  });
});

describe('mergeTable — A ends, B continues (long B tail)', () => {
  it('drains all remaining B messages after A exhausts', async () => {
    const a = [
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:02.000Z'),
    ];

    const b = [
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:02.000Z'),
      msg('2024-01-01T00:00:03.000Z'),
      msg('2024-01-01T00:00:04.000Z'),
      msg('2024-01-01T00:00:22.000Z'),  // simulate 20-hour tail
    ];

    const { messages } = await collect(a, b);

    expect(timestamps(messages)).toEqual([
      '2024-01-01T00:00:01.000Z',
      '2024-01-01T00:00:02.000Z',
      '2024-01-01T00:00:03.000Z',
      '2024-01-01T00:00:04.000Z',
      '2024-01-01T00:00:22.000Z',
    ]);
  });
});

describe('mergeTable — single-file diagnostics (empty B)', () => {
  it('detects backwards timestamps when merging with empty B', async () => {
    const a = [
      msg('2024-01-01T00:00:02.000Z'),
      msg('2024-01-01T00:00:01.000Z'),  // backwards
    ];

    await expect(collect(a, [])).rejects.toThrow(/went backwards/);
  });

  it('passes through all messages when file is correctly ordered', async () => {
    const a = [
      msg('2024-01-01T00:00:01.000Z'),
      msg('2024-01-01T00:00:02.000Z'),
      msg('2024-01-01T00:00:03.000Z'),
    ];

    const { messages, warnings } = await collect(a, []);

    expect(timestamps(messages)).toEqual([
      '2024-01-01T00:00:01.000Z',
      '2024-01-01T00:00:02.000Z',
      '2024-01-01T00:00:03.000Z',
    ]);
    expect(warnings).toHaveLength(0);
  });
});
