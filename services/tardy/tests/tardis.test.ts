import { describe, it, expect, vi, beforeEach } from 'vitest';
import { _test_parseLine, _test_parseMinute, streamMinute } from '../src/tardis';
import type { TardyTable } from '../src/types';

const ALL_TABLES: TardyTable[] = [
  'announcement', 'chat', 'connected', 'instrument',
  'liquidation', 'orderBookL2', 'publicNotifications',
];

// ── parseLine ─────────────────────────────────────────────────────────────────

describe('tardis — parseLine', () => {
  it('parses a well-formed line into a TardisMessage', () => {
    const line = '2019-04-01T00:00:02.6803580Z {"table":"orderBookL2","action":"insert","data":[{"symbol":"XBTUSD","id":8799000000,"side":"Sell","size":100,"price":10000}]}';

    const result = _test_parseLine(line, ALL_TABLES);

    expect(result).not.toBeNull();
    expect(result!.table).toBe('orderBookL2');
    expect(result!.msg.action).toBe('insert');
    expect(result!.msg.data).toHaveLength(1);
  });

  it('truncates nanosecond timestamp to 3 decimal places', () => {
    const line = '2019-04-01T00:00:02.6803580Z {"table":"orderBookL2","action":"insert","data":[]}';

    const result = _test_parseLine(line, ALL_TABLES);

    expect(result!.msg.date).toBe('2019-04-01T00:00:02.680Z');
  });

  it('handles already-millisecond timestamps unchanged', () => {
    const line = '2019-04-01T00:00:02.123Z {"table":"instrument","action":"partial","data":[]}';

    const result = _test_parseLine(line, ALL_TABLES);

    expect(result!.msg.date).toBe('2019-04-01T00:00:02.123Z');
  });

  it('returns null for a blank line', () => {
    expect(_test_parseLine('', ALL_TABLES)).toBeNull();
    expect(_test_parseLine('   ', ALL_TABLES)).toBeNull();
  });

  it('returns null when there is no space separator', () => {
    expect(_test_parseLine('2019-04-01T00:00:00.000Z', ALL_TABLES)).toBeNull();
  });

  it('returns null when the JSON is malformed', () => {
    const line = '2019-04-01T00:00:00.000Z {not valid json}';

    expect(_test_parseLine(line, ALL_TABLES)).toBeNull();
  });

  it('returns null when the message is missing the table field', () => {
    const line = '2019-04-01T00:00:00.000Z {"action":"insert","data":[]}';

    expect(_test_parseLine(line, ALL_TABLES)).toBeNull();
  });

  it('returns null when the message is missing the action field', () => {
    const line = '2019-04-01T00:00:00.000Z {"table":"orderBookL2","data":[]}';

    expect(_test_parseLine(line, ALL_TABLES)).toBeNull();
  });

  it('returns null when the message is missing the data field', () => {
    const line = '2019-04-01T00:00:00.000Z {"table":"orderBookL2","action":"insert"}';

    expect(_test_parseLine(line, ALL_TABLES)).toBeNull();
  });

  it('returns null when data is not an array', () => {
    const line = '2019-04-01T00:00:00.000Z {"table":"orderBookL2","action":"insert","data":"wrong"}';

    expect(_test_parseLine(line, ALL_TABLES)).toBeNull();
  });

  it('returns null when the table is not in the requested set', () => {
    const line = '2019-04-01T00:00:00.000Z {"table":"trade","action":"insert","data":[]}';

    expect(_test_parseLine(line, ['orderBookL2'])).toBeNull();
  });

  it('passes through insert, update and delete actions unchanged', () => {
    for (const action of ['insert', 'update', 'delete']) {
      const line = `2019-04-01T00:00:00.000Z {"table":"liquidation","action":"${action}","data":[]}`;
      const result = _test_parseLine(line, ALL_TABLES);

      expect(result!.msg.action).toBe(action);
    }
  });

  it('encodes a symbol filter as partial:<symbol> on partial messages', () => {
    const line = '2019-04-01T00:00:00.000Z {"table":"orderBookL2","action":"partial","filter":{"symbol":"XBTUSD"},"keys":["symbol","id","side"],"types":{},"data":[]}';
    const result = _test_parseLine(line, ALL_TABLES);

    expect(result!.msg.action).toBe('partial:XBTUSD');
  });

  it('leaves partial action unchanged when filter has no symbol', () => {
    const line = '2019-04-01T00:00:00.000Z {"table":"instrument","action":"partial","filter":{},"data":[]}';
    const result = _test_parseLine(line, ALL_TABLES);

    expect(result!.msg.action).toBe('partial');
  });

  it('leaves partial action unchanged when filter is absent', () => {
    const line = '2019-04-01T00:00:00.000Z {"table":"announcement","action":"partial","data":[]}';
    const result = _test_parseLine(line, ALL_TABLES);

    expect(result!.msg.action).toBe('partial');
  });

  it('passes data rows through without modification', () => {
    const row  = { symbol: 'XBTUSD', id: 8799000000, side: 'Sell', size: 100, price: 10000 };
    const line = `2019-04-01T00:00:00.000Z {"table":"orderBookL2","action":"insert","data":[${JSON.stringify(row)}]}`;

    const result = _test_parseLine(line, ALL_TABLES);

    expect(result!.msg.data[0]).toEqual(row);
  });
});

// ── parseMinute ───────────────────────────────────────────────────────────────

// Builds a Response whose body yields the given string chunks one per read(),
// so we can exercise the line-splitting and carry-over logic deterministically.
const responseFromChunks = (chunks: string[]): Response => {
  const encoder = new TextEncoder();
  const body    = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

  return new Response(body);
};

const collect = async <T>(gen: AsyncGenerator<T>): Promise<T[]> => {
  const out: T[] = [];

  for await (const item of gen) out.push(item);

  return out;
};

describe('tardis — parseMinute', () => {
  it('yields nothing for a response with no body', async () => {
    const res: Response = { body: null } as unknown as Response;

    const items = await collect(_test_parseMinute(res, ALL_TABLES));

    expect(items).toEqual([]);
  });

  it('parses multiple complete lines in a single chunk', async () => {
    const res = responseFromChunks([
      '2019-04-01T00:00:00.000Z {"table":"orderBookL2","action":"insert","data":[{"id":1}]}\n' +
      '2019-04-01T00:00:01.000Z {"table":"instrument","action":"partial","data":[{"symbol":"XBTUSD"}]}\n',
    ]);

    const items = await collect(_test_parseMinute(res, ALL_TABLES));

    expect(items).toHaveLength(2);
    expect(items[0]!.table).toBe('orderBookL2');
    expect(items[1]!.table).toBe('instrument');
  });

  it('reassembles lines split across chunk boundaries', async () => {
    // Split a single line mid-JSON.
    const res = responseFromChunks([
      '2019-04-01T00:00:00.000Z {"table":"orderBookL2","action":"ins',
      'ert","data":[{"id":42}]}\n',
    ]);

    const items = await collect(_test_parseMinute(res, ALL_TABLES));

    expect(items).toHaveLength(1);
    expect(items[0]!.msg.action).toBe('insert');
    expect(items[0]!.msg.data[0]).toEqual({ id: 42 });
  });

  it('emits the final line when the stream ends without a trailing newline', async () => {
    const res = responseFromChunks([
      '2019-04-01T00:00:00.000Z {"table":"orderBookL2","action":"insert","data":[]}',
    ]);

    const items = await collect(_test_parseMinute(res, ALL_TABLES));

    expect(items).toHaveLength(1);
  });

  it('handles a chunk that contains exactly a newline at the boundary', async () => {
    const res = responseFromChunks([
      '2019-04-01T00:00:00.000Z {"table":"orderBookL2","action":"insert","data":[]}',
      '\n',
      '2019-04-01T00:00:01.000Z {"table":"instrument","action":"partial","data":[]}\n',
    ]);

    const items = await collect(_test_parseMinute(res, ALL_TABLES));

    expect(items).toHaveLength(2);
  });

  it('skips blank lines in the stream', async () => {
    const res = responseFromChunks([
      '2019-04-01T00:00:00.000Z {"table":"orderBookL2","action":"insert","data":[]}\n' +
      '\n' +
      '2019-04-01T00:00:01.000Z {"table":"instrument","action":"partial","data":[]}\n',
    ]);

    const items = await collect(_test_parseMinute(res, ALL_TABLES));

    expect(items).toHaveLength(2);
  });

  it('filters out lines for tables not in the requested set', async () => {
    const res = responseFromChunks([
      '2019-04-01T00:00:00.000Z {"table":"trade","action":"insert","data":[]}\n' +
      '2019-04-01T00:00:01.000Z {"table":"orderBookL2","action":"insert","data":[]}\n',
    ]);

    const items = await collect(_test_parseMinute(res, ['orderBookL2']));

    expect(items).toHaveLength(1);
    expect(items[0]!.table).toBe('orderBookL2');
  });
});

// ── streamMinute ──────────────────────────────────────────────────────────────

describe('tardis — streamMinute', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  it('issues exactly one fetch per call and yields all parsed messages', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(responseFromChunks([
      '2019-04-01T00:00:00.000Z {"table":"orderBookL2","action":"insert","data":[]}\n',
    ])));

    const items = await collect(streamMinute('20190401', 0, ['orderBookL2']));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(items).toHaveLength(1);
  });

  it('builds URLs with from, offset, and encoded multi-channel filter', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(responseFromChunks([''])));

    await collect(streamMinute('20190401', 0, ['orderBookL2', 'instrument', 'liquidation']));

    const url = mockFetch.mock.calls[0]![0] as string;

    expect(url).toContain('from=2019-04-01');
    expect(url).toContain('offset=0');

    const filterParam = new URL(url).searchParams.get('filters')!;
    const parsed      = JSON.parse(filterParam);

    expect(parsed).toEqual([
      { channel: 'orderBookL2' },
      { channel: 'instrument' },
      { channel: 'liquidation' },
    ]);
  });

  it('passes the requested offset through to the URL', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(responseFromChunks([''])));

    await collect(streamMinute('20190401', 720, ['orderBookL2']));

    const url    = mockFetch.mock.calls[0]![0] as string;
    const offset = new URL(url).searchParams.get('offset');

    expect(offset).toBe('720');
  });
});
