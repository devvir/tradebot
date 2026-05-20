import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decodeFile } from '../../src/data/decode';

// Mock the parser — decode.ts streams records via createParser internally.
vi.mock('../../src/data/parse', () => ({
  createParser: vi.fn(),
}));

import { createParser } from '../../src/data/parse';

/** Helper: make an async generator from an array of records. */
async function* fromRecords(records: string[][]) {
  for (const r of records) yield r;
}

const read = vi.fn();

/** Configures createParser to stream the given records via its `read` method. */
const mockRecords = (records: string[][]) => {
  read.mockReturnValue(fromRecords(records));
  vi.mocked(createParser).mockReturnValue({ read } as never);
};

beforeEach(() => vi.clearAllMocks());

// ── REST files ────────────────────────────────────────────────────────────────

describe('REST file decoding', () => {
  it('emits one JSON object per data row', async () => {
    mockRecords([
      ['symbol', 'count', 'total'],
      ['XBTUSD', '10', '5000'],
      ['ETHUSD', '3',  '1500'],
    ]);

    const out: string[] = [];

    for await (const line of decodeFile('funding', '2023-02-01')) {
      out.push(line);
    }

    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0]!)).toEqual({ symbol: 'XBTUSD', count: '10', total: '5000' });
    expect(JSON.parse(out[1]!)).toEqual({ symbol: 'ETHUSD', count: '3',  total: '1500' });
  });

  it('returns nothing for a header-only file', async () => {
    mockRecords([['symbol', 'price']]);

    const out: string[] = [];

    for await (const line of decodeFile('funding', '2023-02-01')) {
      out.push(line);
    }

    expect(out).toHaveLength(0);
  });

  it('forwards the table to createParser and the skip to read', async () => {
    mockRecords([['symbol', 'price']]);

    for await (const _ of decodeFile('funding', '2023-02-01', 7)) { /* consume */ }

    expect(createParser).toHaveBeenCalledWith('funding');
    expect(read).toHaveBeenCalledWith('2023-02-01', 7);
  });
});

// ── WS files ─────────────────────────────────────────────────────────────────

describe('WS file decoding', () => {
  it('groups rows into message envelopes', async () => {
    mockRecords([
      ['_date_', '_action_', 'symbol', 'price'],
      ['2023-02-01T00:00:00.000Z', 'partial', 'XBTUSD', '30000'],
      ['', '', '', ''],
      ['2023-02-01T00:01:00.000Z', 'update',  'XBTUSD', '30100'],
    ]);

    const out: string[] = [];

    for await (const line of decodeFile('orderBookL2', '2023-02-01')) {
      out.push(line);
    }

    expect(out).toHaveLength(2);

    const first = JSON.parse(out[0]!);
    expect(first.action).toBe('partial');
    expect(first.date).toBe('2023-02-01T00:00:00.000Z');
    expect(first.data).toHaveLength(2);

    const second = JSON.parse(out[1]!);
    expect(second.action).toBe('update');
    expect(second.data).toHaveLength(1);
  });

  it('handles a quoted field containing a comma', async () => {
    mockRecords([
      ['_date_', '_action_', 'symbol', 'note'],
      ['2023-02-01T00:00:00.000Z', 'partial', 'XBTUSD', 'hello, world'],
    ]);

    const out: string[] = [];

    for await (const line of decodeFile('orderBookL2', '2023-02-01')) {
      out.push(line);
    }

    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!).data[0]).toMatchObject({ note: 'hello, world' });
  });

  it('preserves embedded newlines inside a quoted WS field', async () => {
    // The parser hands decode pre-parsed records, so the embedded newline that
    // would have been a multi-line stretch on disk arrives here as a single
    // field value in the record.
    mockRecords([
      ['_date_', '_action_', 'id', 'link', 'title', 'content', 'date'],
      [
        '2023-08-01T04:02:44.626Z',
        'insert',
        '48713',
        'https://blog.bitmex.com/site_announcement/now-live-xbteth/',
        'Now Live: XBTETH Perpetual Contract',
        '<p>line one</p>\n<p>line two</p>\n<p>line three</p>',
        '2023-08-01T04:02:44.626Z',
      ],
    ]);

    const out: string[] = [];

    for await (const line of decodeFile('announcement', '2023-02-01')) {
      out.push(line);
    }

    expect(out).toHaveLength(1);

    const msg = JSON.parse(out[0]!);
    expect(msg.action).toBe('insert');
    expect(msg.data).toHaveLength(1);
    expect(msg.data[0]).toMatchObject({
      id:      48713,
      title:   'Now Live: XBTETH Perpetual Contract',
      content: '<p>line one</p>\n<p>line two</p>\n<p>line three</p>',
    });
  });
});
