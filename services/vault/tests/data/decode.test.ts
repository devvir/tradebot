import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decodeFile } from '../../src/data/decode';

// Mock the fs layer — decode.ts calls streamLines internally.
vi.mock('../../src/fs/reader', () => ({
  streamLines: vi.fn(),
}));

import { streamLines } from '../../src/fs/reader';

/** Helper: make an async generator from an array of strings. */
async function* fromLines(lines: string[]) {
  for (const l of lines) yield l;
}

const mockLines = (lines: string[]) =>
  vi.mocked(streamLines).mockReturnValue(fromLines(lines) as ReturnType<typeof streamLines>);

beforeEach(() => vi.clearAllMocks());

// ── REST files ────────────────────────────────────────────────────────────────

describe('REST file decoding', () => {
  it('emits one JSON object per data row', async () => {
    mockLines([
      'symbol,count,total',
      'XBTUSD,10,5000',
      'ETHUSD,3,1500',
    ]);

    const out: string[] = [];

    for await (const line of decodeFile('funding', '2023-02-01')) {
      out.push(line);
    }

    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0]!)).toEqual({ symbol: 'XBTUSD', count: '10', total: '5000' });
    expect(JSON.parse(out[1]!)).toEqual({ symbol: 'ETHUSD', count: '3',  total: '1500' });
  });

  it('skips the first N rows when skip > 0', async () => {
    mockLines([
      'symbol,price',
      'XBTUSD,30000',
      'ETHUSD,2000',
      'XRPUSD,0.5',
    ]);

    const out: string[] = [];

    for await (const line of decodeFile('funding', '2023-02-01', 1)) {
      out.push(line);
    }

    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0]!)).toMatchObject({ symbol: 'ETHUSD' });
  });

  it('returns nothing for a header-only file', async () => {
    mockLines(['symbol,price']);

    const out: string[] = [];

    for await (const line of decodeFile('funding', '2023-02-01')) {
      out.push(line);
    }

    expect(out).toHaveLength(0);
  });
});

// ── WS files ─────────────────────────────────────────────────────────────────

describe('WS file decoding', () => {
  it('groups rows into message envelopes', async () => {
    mockLines([
      '_date_,_action_,symbol,price',
      '2023-02-01T00:00:00.000Z,partial,XBTUSD,30000',
      ',,,',
      '2023-02-01T00:01:00.000Z,update,XBTUSD,30100',
    ]);

    const out: string[] = [];

    for await (const line of decodeFile('quote', '2023-02-01')) {
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

  it('skips continuation rows belonging to skipped messages', async () => {
    mockLines([
      '_date_,_action_,symbol,price',
      '2023-02-01T00:00:00.000Z,partial,XBTUSD,30000',
      ',,,',
      ',,,',
      '2023-02-01T00:01:00.000Z,update,XBTUSD,30100',
    ]);

    const out: string[] = [];

    for await (const line of decodeFile('quote', '2023-02-01', 1)) {
      out.push(line);
    }

    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!).action).toBe('update');
  });

  it('handles a quoted field containing a comma', async () => {
    mockLines([
      '_date_,_action_,symbol,note',
      '2023-02-01T00:00:00.000Z,partial,XBTUSD,"hello, world"',
    ]);

    const out: string[] = [];

    for await (const line of decodeFile('quote', '2023-02-01')) {
      out.push(line);
    }

    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!).data[0]).toMatchObject({ note: 'hello, world' });
  });
});
