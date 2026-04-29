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

/** Collect all output messages from a merge of 2 streams. */
async function collect(
  a: Message[],
  b: Message[],
): Promise<{ messages: Message[]; warnings: string[] }> {
  const output: Message[] = [];

  const result = await mergeTable(
    [toAsyncIterable(a), toAsyncIterable(b)],
    async (msg) => {
      output.push(msg);
    },
    { timestampCol: 'timestamp' },
  );

  return { messages: output, warnings: result.warnings };
}

/** Collect all output messages from a merge of N streams. */
async function collectN(
  streams: Message[][],
): Promise<{ messages: Message[]; warnings: string[] }> {
  const output: Message[] = [];

  const result = await mergeTable(
    streams.map(s => toAsyncIterable(s)),
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

  it('when two sources have the same timestamp, A wins and B is skipped entirely — even if content differs', async () => {
    const ts = '2024-01-01T00:00:01.000Z';
    const aMsg = msg(ts, 'insert', 'rx-a', '1,100');
    const bMsg = msg(ts, 'insert', 'rx-b', '2,200');

    const { messages } = await collect([aMsg], [bMsg]);

    // A owns this timestamp; B's message is skipped regardless of content.
    expect(messages).toHaveLength(1);
    expect(messages[0].date).toBe('rx-a');
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
        [toAsyncIterable(a), toAsyncIterable([])],
        async () => {},
        { timestampCol: 'timestamp', fileLabels: ['my-base-file.csv', 'my-gaps-file.csv'] },
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

describe('mergeTable — N-way (3+ streams)', () => {
  it('merges three streams in timestamp order', async () => {
    const a = [msg('2024-01-01T00:00:01.000Z'), msg('2024-01-01T00:00:04.000Z')];
    const b = [msg('2024-01-01T00:00:02.000Z'), msg('2024-01-01T00:00:05.000Z')];
    const c = [msg('2024-01-01T00:00:03.000Z'), msg('2024-01-01T00:00:06.000Z')];

    const { messages } = await collectN([a, b, c]);

    expect(timestamps(messages)).toEqual([
      '2024-01-01T00:00:01.000Z',
      '2024-01-01T00:00:02.000Z',
      '2024-01-01T00:00:03.000Z',
      '2024-01-01T00:00:04.000Z',
      '2024-01-01T00:00:05.000Z',
      '2024-01-01T00:00:06.000Z',
    ]);
  });

  it('first stream wins when all three share a timestamp — others skipped', async () => {
    const shared = msg('2024-01-01T00:00:01.000Z', 'insert', 'shared-date', '1,100');
    const a = [shared, msg('2024-01-01T00:00:02.000Z')];
    const b = [shared, msg('2024-01-01T00:00:03.000Z')];
    const c = [shared, msg('2024-01-01T00:00:04.000Z')];

    const { messages } = await collectN([a, b, c]);

    // ts=01: A wins (B and C skipped); ts=02,03,04 each from their only source.
    expect(messages).toHaveLength(4);
    expect(timestamps(messages)[0]).toBe('2024-01-01T00:00:01.000Z');
    expect(messages[0].date).toBe('shared-date'); // A's version
  });

  it('handles one empty stream among three', async () => {
    const a = [msg('2024-01-01T00:00:01.000Z'), msg('2024-01-01T00:00:03.000Z')];
    const b: Message[] = [];
    const c = [msg('2024-01-01T00:00:02.000Z'), msg('2024-01-01T00:00:04.000Z')];

    const { messages } = await collectN([a, b, c]);

    expect(timestamps(messages)).toEqual([
      '2024-01-01T00:00:01.000Z',
      '2024-01-01T00:00:02.000Z',
      '2024-01-01T00:00:03.000Z',
      '2024-01-01T00:00:04.000Z',
    ]);
  });

  it('throws on monotonicity violation in the third stream', async () => {
    const a = [msg('2024-01-01T00:00:01.000Z')];
    const b = [msg('2024-01-01T00:00:02.000Z')];
    const c = [
      msg('2024-01-01T00:00:03.000Z'),
      msg('2024-01-01T00:00:02.000Z'), // backwards
    ];

    await expect(collectN([a, b, c])).rejects.toThrow(/went backwards/);
  });
});

describe('mergeTable — multi-row messages', () => {
  it('writes all rows of a multi-row message atomically', async () => {
    const big   = multiMsg('2024-01-01T00:00:01.000Z', 5, 'partial');
    const small = msg('2024-01-01T00:00:02.000Z');

    const allMsgs: Message[] = [];

    await mergeTable(
      [toAsyncIterable([big, small]), toAsyncIterable([])],
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

// ── N-way timestamp ownership combinations ────────────────────────────────────
//
// For every combination of which sources share a given timestamp, the lowest-
// index (highest-priority) source wins and all others are skipped.
// Sources are ordered alphabetically — streams[0]=A, [1]=B, [2]=C.

describe('mergeTable — N-way timestamp ownership (3 streams)', () => {
  // Tag each message with its source name in the `date` field so tests can
  // assert which source produced each output message.
  function srcMsg(source: string, ts: string, tag = ''): Message {
    return msg(ts, 'insert', `${source}:${ts}${tag}`);
  }

  function sources(messages: Message[]): string[] {
    return messages.map(m => m.date.split(':')[0]!);
  }

  const T1 = '2024-01-01T00:00:01.000Z';
  const T2 = '2024-01-01T00:00:02.000Z';
  const T3 = '2024-01-01T00:00:03.000Z';
  const T4 = '2024-01-01T00:00:04.000Z';
  const T5 = '2024-01-01T00:00:05.000Z';
  const T7 = '2024-01-01T00:00:07.000Z';
  const T8 = '2024-01-01T00:00:08.000Z';
  const T9 = '2024-01-01T00:00:09.000Z';

  it('only A has a timestamp — taken from A', async () => {
    const { messages } = await collectN([
      [srcMsg('A', T1)],
      [],
      [],
    ]);

    expect(sources(messages)).toEqual(['A']);
  });

  it('only B has a timestamp — taken from B', async () => {
    const { messages } = await collectN([
      [],
      [srcMsg('B', T1)],
      [],
    ]);

    expect(sources(messages)).toEqual(['B']);
  });

  it('only C has a timestamp — taken from C', async () => {
    const { messages } = await collectN([
      [],
      [],
      [srcMsg('C', T1)],
    ]);

    expect(sources(messages)).toEqual(['C']);
  });

  it('A and B share a timestamp (not C) — A wins, B skipped', async () => {
    const { messages } = await collectN([
      [srcMsg('A', T1)],
      [srcMsg('B', T1)],
      [],
    ]);

    expect(messages).toHaveLength(1);
    expect(sources(messages)).toEqual(['A']);
  });

  it('A and C share a timestamp (not B) — A wins, C skipped', async () => {
    const { messages } = await collectN([
      [srcMsg('A', T1)],
      [],
      [srcMsg('C', T1)],
    ]);

    expect(messages).toHaveLength(1);
    expect(sources(messages)).toEqual(['A']);
  });

  it('B and C share a timestamp (not A) — B wins, C skipped', async () => {
    const { messages } = await collectN([
      [],
      [srcMsg('B', T1)],
      [srcMsg('C', T1)],
    ]);

    expect(messages).toHaveLength(1);
    expect(sources(messages)).toEqual(['B']);
  });

  it('all three share a timestamp — A wins, B and C both skipped', async () => {
    const { messages } = await collectN([
      [srcMsg('A', T1)],
      [srcMsg('B', T1)],
      [srcMsg('C', T1)],
    ]);

    expect(messages).toHaveLength(1);
    expect(sources(messages)).toEqual(['A']);
  });

  it('winner has multiple messages at the same timestamp — all written; non-winner skipped', async () => {
    // A has two messages at T2; B also has one at T2 — both of A's are written, B's is skipped.
    const { messages } = await collectN([
      [srcMsg('A', T2, 'x'), srcMsg('A', T2, 'y')],
      [srcMsg('B', T2)],
      [],
    ]);

    expect(messages).toHaveLength(2);
    expect(sources(messages)).toEqual(['A', 'A']);
  });

  it('non-winner has multiple messages at the same timestamp — all skipped', async () => {
    // B has three messages at T1; A also has one → all three of B's are skipped.
    const { messages } = await collectN([
      [srcMsg('A', T1), srcMsg('A', T2)],
      [srcMsg('B', T1, 'x'), srcMsg('B', T1, 'y'), srcMsg('B', T1, 'z'), srcMsg('B', T3)],
      [],
    ]);

    // T1 → A wins (1 msg); T2 → A wins (1 msg); T3 → B wins (1 msg).
    expect(messages).toHaveLength(3);
    expect(sources(messages)).toEqual(['A', 'A', 'B']);
  });

  it('full spec example: A=1,2,4x,4y,5,8  B=2,3x,3y,5,7  C=1,5,8,9  → A1,A2,B3x,B3y,A4x,A4y,A5,B7,A8,C9', async () => {
    const a = [
      srcMsg('A', T1),
      srcMsg('A', T2),
      srcMsg('A', T4, 'x'), srcMsg('A', T4, 'y'),
      srcMsg('A', T5),
      srcMsg('A', T8),
    ];

    const b = [
      srcMsg('B', T2),
      srcMsg('B', T3, 'x'), srcMsg('B', T3, 'y'),
      srcMsg('B', T5),
      srcMsg('B', T7),
    ];

    const c = [
      srcMsg('C', T1),
      srcMsg('C', T5),
      srcMsg('C', T8),
      srcMsg('C', T9),
    ];

    const { messages } = await collectN([a, b, c]);

    expect(sources(messages)).toEqual(['A', 'A', 'B', 'B', 'A', 'A', 'A', 'B', 'A', 'C']);
    expect(timestamps(messages)).toEqual([T1, T2, T3, T3, T4, T4, T5, T7, T8, T9]);
  });

  it('later timestamp from lower-priority source is taken when higher-priority has moved on', async () => {
    // After A exhausts ts=T1 and T2, B's T3 is the only candidate — B wins.
    // This confirms priority is per-timestamp, not global dominance.
    const { messages } = await collectN([
      [srcMsg('A', T1), srcMsg('A', T2)],
      [srcMsg('B', T1), srcMsg('B', T3)],
      [srcMsg('C', T4)],
    ]);

    // T1 → A; T2 → A; T3 → B (A exhausted); T4 → C (A and B exhausted).
    expect(sources(messages)).toEqual(['A', 'A', 'B', 'C']);
    expect(timestamps(messages)).toEqual([T1, T2, T3, T4]);
  });
});

// ── Partial-takes-precedence (timestamped tables) ─────────────────────────────
//
// A `partial` is a full state snapshot, so when any source has a partial at a
// given timestamp it wins outright — even if a higher-priority source has a
// non-partial at that same timestamp. Source order is still the tiebreaker
// when multiple sources have a partial at the same timestamp. The
// "one-source-per-timestamp" rule still holds: only the partial winner's
// message is written; every other source's message at that timestamp is
// dropped.

describe('mergeTable — partial precedence (timestamped tables)', () => {
  function srcMsg(source: string, ts: string, action: string = 'insert'): Message {
    return msg(ts, action, `${source}:${ts}`);
  }

  function srcPartial(source: string, ts: string, rowCount = 2): Message {
    const m = multiMsg(ts, rowCount, 'partial', `${source}:${ts}`);
    return m;
  }

  function sources(messages: Message[]): string[] {
    return messages.map(m => m.date.split(':')[0]!);
  }

  const T1 = '2024-01-01T00:00:01.000Z';
  const T2 = '2024-01-01T00:00:02.000Z';
  const T3 = '2024-01-01T00:00:03.000Z';
  const T4 = '2024-01-01T00:00:04.000Z';
  const T5 = '2024-01-01T00:00:05.000Z';
  const T7 = '2024-01-01T00:00:07.000Z';
  const T8 = '2024-01-01T00:00:08.000Z';

  it('lower-priority partial wins over higher-priority non-partial at the same ts', async () => {
    // A has a regular insert at T1; C has a partial at T1.
    // Expected: C's partial wins, A's insert is dropped.
    const { messages } = await collectN([
      [srcMsg('A', T1)],
      [],
      [srcPartial('C', T1)],
    ]);

    expect(messages).toHaveLength(1);
    expect(sources(messages)).toEqual(['C']);
    expect(messages[0].action).toBe('partial');
  });

  it('drops every other source at the partial timestamp — including non-partials in the winner stream order', async () => {
    // A insert(T1), B insert(T1), C partial(T1) — only C's partial survives.
    const { messages } = await collectN([
      [srcMsg('A', T1)],
      [srcMsg('B', T1)],
      [srcPartial('C', T1)],
    ]);

    expect(messages).toHaveLength(1);
    expect(sources(messages)).toEqual(['C']);
  });

  it('among multiple partials at the same ts, lowest-index source wins; others dropped', async () => {
    // Both A and C have a partial at T1 — A wins by source order.
    const { messages } = await collectN([
      [srcPartial('A', T1)],
      [],
      [srcPartial('C', T1)],
    ]);

    expect(messages).toHaveLength(1);
    expect(sources(messages)).toEqual(['A']);
  });

  it('partial in non-winner stream drops a multi-message run from a higher-priority source at the same ts', async () => {
    // A has two messages at T2; C has a partial at T2.
    // C's partial wins — both of A's messages at T2 are dropped.
    const { messages } = await collectN([
      [srcMsg('A', T2), srcMsg('A', T2)],
      [],
      [srcPartial('C', T2)],
    ]);

    expect(messages).toHaveLength(1);
    expect(sources(messages)).toEqual(['C']);
  });

  it('partials at adjacent but distinct timestamps each take their own slot', async () => {
    // A partial(T1), C partial(T2), then a non-partial follow-up — both partials kept.
    const { messages } = await collectN([
      [srcPartial('A', T1), srcMsg('A', T3)],
      [],
      [srcPartial('C', T2)],
    ]);

    expect(messages).toHaveLength(3);
    expect(messages.map(m => m.action)).toEqual(['partial', 'partial', 'insert']);
    expect(timestamps(messages)).toEqual([T1, T2, T3]);
  });

  it('full spec example: A1, A2, A4, A7  /  B1, B3, B8  /  C1(partial), C3, C5, C6, C7, C8', async () => {
    // From the merge spec, with C1 a partial — at T1 the partial wins,
    // A1 and B1 are both dropped.
    const a = [
      srcMsg('A', T1),
      srcMsg('A', T2),
      srcMsg('A', T4),
      srcMsg('A', T7),
    ];

    const b = [
      srcMsg('B', T1),
      srcMsg('B', T3),
      srcMsg('B', T8),
    ];

    const c = [
      srcPartial('C', T1),
      srcMsg('C', T3),
      srcMsg('C', T5),
      srcMsg('C', '2024-01-01T00:00:06.000Z'),
      srcMsg('C', T7),
      srcMsg('C', T8),
    ];

    const { messages } = await collectN([a, b, c]);

    expect(sources(messages)).toEqual(['C', 'A', 'B', 'A', 'C', 'C', 'A', 'B']);
    expect(timestamps(messages)).toEqual([
      T1, T2, T3, T4, T5,
      '2024-01-01T00:00:06.000Z',
      T7, T8,
    ]);
    // Only the T1 winner (C's) is a partial.
    expect(messages.map(m => m.action)).toEqual([
      'partial', 'insert', 'insert', 'insert',
      'insert', 'insert', 'insert', 'insert',
    ]);
  });
});
