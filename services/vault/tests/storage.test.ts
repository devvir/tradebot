import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  existsSync, mkdirSync, statSync,
  createReadStream, createWriteStream,
  unlinkSync, readdirSync, renameSync,
} from 'fs';
import { createGunzip, createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import {
  insertRow, storeFile, closeFile, dropFile,
  streamRows, readHeaders, listFiles, fileExists,
  NotFoundError, DATA_DIR,
} from '../src/storage';
import { _test_flushAll } from '../src/storage/queue';
import { createGroupTransform } from '../src/storage/read';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('fs', () => ({
  existsSync:        vi.fn(),
  mkdirSync:         vi.fn(),
  createReadStream:  vi.fn(),
  createWriteStream: vi.fn(),
  unlinkSync:        vi.fn(),
  readdirSync:       vi.fn(),
  renameSync:        vi.fn(),
  statSync:          vi.fn(),
}));

vi.mock('zlib', () => ({
  createGunzip: vi.fn(),
  createGzip:   vi.fn(),
  constants:    { Z_SYNC_FLUSH: 2 },
}));

vi.mock('stream/promises', () => ({
  pipeline: vi.fn().mockResolvedValue(undefined),
  finished: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:readline', () => ({ createInterface: vi.fn() }));

// ── DATA_DIR ──────────────────────────────────────────────────────────────────

describe('storage — DATA_DIR', () => {
  it('defaults to /data/vault', () => {
    expect(DATA_DIR).toBe('/data/vault');
  });
});

// ── Mock helpers ──────────────────────────────────────────────────────────────

const mockGzip = () => {
  const written: string[] = [];
  const handle = {
    write: vi.fn((data: string) => { written.push(data); }),
    end:   vi.fn(),
    flush: vi.fn(),
    on:    vi.fn(),
    pipe:  vi.fn().mockReturnThis(),
  };
  return { handle, written };
};

const mockFileStream = () => {
  const handle = {
    write: vi.fn(),
    end:   vi.fn(),
    on:    vi.fn(),
  };
  return { handle };
};

// ── insertRow ─────────────────────────────────────────────────────────────────

describe('storage — insertRow', () => {
  let written: string[];

  beforeEach(() => {
    const gz = mockGzip();
    written = gz.written;
    vi.mocked(createGzip).mockReturnValue(gz.handle as never);
    vi.mocked(createWriteStream).mockReturnValue(mockFileStream().handle as never);
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it('writes header and data on first insert', () => {
    insertRow('test_write', '20250201', { timestamp: '2025-02-01T00:00:00Z', symbol: 'XBTUSD', price: 50000 });
    _test_flushAll();

    expect(written.join('')).toBe(
      'timestamp,symbol,price\n2025-02-01T00:00:00Z,XBTUSD,50000\n',
    );
  });

  it('does not repeat the header on subsequent inserts for the same file', () => {
    insertRow('test_repeat', '20250203', { timestamp: '2025-02-03T00:00:00Z', symbol: 'XBTUSD', price: 50000 });
    insertRow('test_repeat', '20250203', { timestamp: '2025-02-03T00:01:00Z', symbol: 'XBTUSD', price: 50001 });
    _test_flushAll();

    const combined    = written.join('');
    const headerCount = combined.match(/timestamp,symbol,price\n/g)?.length ?? 0;

    expect(headerCount).toBe(1);
    expect(combined).toContain('2025-02-03T00:00:00Z,XBTUSD,50000\n');
    expect(combined).toContain('2025-02-03T00:01:00Z,XBTUSD,50001\n');
  });

  it('creates the table directory', () => {
    insertRow('test_dir', '20250204', { a: 1 });

    expect(mkdirSync).toHaveBeenCalledWith(`${DATA_DIR}/test_dir/2025`, { recursive: true });
  });

  it('opens the underlying file at the .csv.gz.tmp path in append mode', () => {
    insertRow('test_path', '20250204', { a: 1 });

    expect(createWriteStream).toHaveBeenCalledWith(
      `${DATA_DIR}/test_path/2025/20250204.csv.gz.tmp`,
      { flags: 'a' },
    );
  });

  it('skips the header when the .csv.gz.tmp already exists (resuming after handle loss or restart)', () => {
    // File already present → getOrCreateHandle appends a new gz member, no header.
    vi.mocked(existsSync).mockReturnValue(true);

    insertRow('test_resume', '20250204', { a: 1, b: 2 });
    _test_flushAll();

    expect(written.join('')).toBe('1,2\n');
  });

  it('preserves insertion order across concurrent calls', () => {
    insertRow('test_order', '20250205', { line: 'line-1' });
    insertRow('test_order', '20250205', { line: 'line-2' });
    insertRow('test_order', '20250205', { line: 'line-3' });
    _test_flushAll();

    const combined = written.join('');

    expect(combined.indexOf('line-1\n')).toBeLessThan(combined.indexOf('line-2\n'));
    expect(combined.indexOf('line-2\n')).toBeLessThan(combined.indexOf('line-3\n'));
  });

  it('quotes values that contain commas', () => {
    insertRow('test_csv', '20250206', { note: 'hello, world', price: 1 });
    _test_flushAll();

    expect(written.join('')).toContain('"hello, world",1\n');
  });

  it('quotes values that contain double quotes and escapes them by doubling', () => {
    insertRow('test_csv_q', '20250206', { note: 'she said "hi"', price: 1 });
    _test_flushAll();

    expect(written.join('')).toContain('"she said ""hi""",1\n');
  });

  it('quotes values that contain newlines and preserves them byte-for-byte', () => {
    insertRow('test_csv_nl', '20250206', { note: 'line1\nline2', price: 1 });
    _test_flushAll();

    expect(written.join('')).toContain('"line1\nline2",1\n');
  });

  it('preserves consecutive newlines inside a quoted field', () => {
    // Regression: consecutive `\n\n` must survive round-trip unchanged — no
    // blank-line collapsing. A reader that splits on `\n` before CSV parsing
    // would corrupt this value.
    insertRow('test_csv_nn', '20250206', { note: 'para1\n\npara2', price: 1 });
    _test_flushAll();

    expect(written.join('')).toContain('"para1\n\npara2",1\n');
  });

  it('does not quote fields that need no quoting', () => {
    insertRow('test_csv_plain', '20250206', { note: 'plain-value', price: 1 });
    _test_flushAll();

    expect(written.join('')).toContain('plain-value,1\n');
  });

  it('serializes object values as JSON and quotes them when they contain commas', () => {
    insertRow('test_csv_obj', '20250206', { data: { a: 1, b: 2 }, price: 1 });
    _test_flushAll();

    expect(written.join('')).toContain('"{""a"":1,""b"":2}",1\n');
  });

  it('batches many rows into a single gz.write call', () => {
    for (let i = 0; i < 1000; i++) {
      insertRow('test_batch', '20250207', { i });
    }
    _test_flushAll();

    // 1 header + 1000 data lines, all delivered in one gz.write.
    expect(written.length).toBe(1);
    expect(written[0]!.split('\n').filter(Boolean).length).toBe(1001);
  });

  it('flushes automatically when the row threshold is reached', () => {
    // Threshold is 10_000 rows; pushing that many should trigger a flush
    // without waiting for the timer.
    for (let i = 0; i < 10_000; i++) {
      insertRow('test_threshold', '20250208', { i });
    }

    expect(written.length).toBeGreaterThanOrEqual(1);
    // No manual flush — the threshold did the job.
    expect(written.join('').split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(10_000);
  });
});

// ── storeFile ─────────────────────────────────────────────────────────────────

describe('storage — storeFile', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(pipeline).mockResolvedValue(undefined);
    vi.mocked(createWriteStream).mockReturnValue({} as never);
  });

  it('pipes the source to the tmp path then renames', async () => {
    const source = Readable.from(['bytes']);

    await storeFile('trade', '20250101', source);

    expect(pipeline).toHaveBeenCalledWith(source, expect.anything());
    expect(renameSync).toHaveBeenCalledWith(
      `${DATA_DIR}/trade/2025/20250101.csv.gz.tmp`,
      `${DATA_DIR}/trade/2025/20250101.csv.gz`,
    );
  });

  it('removes the tmp file if pipeline throws', async () => {
    vi.mocked(pipeline).mockRejectedValue(new Error('network error'));
    vi.mocked(existsSync).mockImplementation((p) => (p as string).endsWith('.tmp'));

    await expect(storeFile('trade', '20250101', Readable.from([]))).rejects.toThrow();

    expect(unlinkSync).toHaveBeenCalledWith(`${DATA_DIR}/trade/2025/20250101.csv.gz.tmp`);
  });
});

// ── closeFile ─────────────────────────────────────────────────────────────────

describe('storage — closeFile', () => {
  beforeEach(() => {
    vi.mocked(renameSync).mockReset();
    vi.mocked(createGzip).mockReturnValue(mockGzip().handle as never);
    vi.mocked(createWriteStream).mockReturnValue(mockFileStream().handle as never);
  });

  it('throws NotFoundError when no open file exists', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    await expect(closeFile('trade', '20250101')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('renames the .csv.gz.tmp to .csv.gz', async () => {
    vi.mocked(existsSync).mockImplementation((p) => (p as string).endsWith('.csv.gz.tmp'));

    await closeFile('trade_close', '20250101');

    expect(renameSync).toHaveBeenCalledWith(
      `${DATA_DIR}/trade_close/2025/20250101.csv.gz.tmp`,
      `${DATA_DIR}/trade_close/2025/20250101.csv.gz`,
    );
  });

  it('treats already-closed file as success', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = p as string;
      return s.endsWith('.csv.gz') && ! s.endsWith('.tmp');
    });

    await closeFile('sealed', '20250101');

    expect(renameSync).not.toHaveBeenCalled();
  });
});

// ── dropFile ──────────────────────────────────────────────────────────────────

describe('storage — dropFile', () => {
  beforeEach(() => {
    vi.mocked(createGzip).mockReturnValue(mockGzip().handle as never);
    vi.mocked(createWriteStream).mockReturnValue(mockFileStream().handle as never);
  });

  it('deletes the open file', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    await dropFile('trade', '20250101');

    expect(unlinkSync).toHaveBeenCalledWith(`${DATA_DIR}/trade/2025/20250101.csv.gz.tmp`);
  });

  it('throws NotFoundError when no open file exists', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    await expect(dropFile('trade', '20250101')).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── streamRows ────────────────────────────────────────────────────────────────

describe('storage — streamRows', () => {
  it('throws NotFoundError when neither open nor closed file exists', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    expect(() => streamRows('trade', '20250101')).toThrow(NotFoundError);
  });

  it('uses the closed file when both exist', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const mockStream = Object.assign(new EventEmitter(), { pipe: vi.fn().mockReturnThis() });
    vi.mocked(createReadStream).mockReturnValue(mockStream as never);

    streamRows('trade', '20250101');

    const lastCall = vi.mocked(createReadStream).mock.calls.at(-1)![0] as string;
    expect(lastCall).toMatch(/\.csv\.gz$/);
    expect(lastCall).not.toMatch(/\.tmp$/);
  });

  it('falls back to the open .csv.gz.tmp file when no closed file exists', () => {
    vi.mocked(existsSync)
      .mockReturnValueOnce(false)  // closed path
      .mockReturnValueOnce(true);  // open path

    const mockStream = Object.assign(new EventEmitter(), { pipe: vi.fn().mockReturnThis() });
    vi.mocked(createReadStream).mockReturnValue(mockStream as never);

    streamRows('trade', '20250101');

    const lastCall = vi.mocked(createReadStream).mock.calls.at(-1)![0] as string;
    expect(lastCall).toMatch(/\.csv\.gz\.tmp$/);
  });
});

// ── createGroupTransform ──────────────────────────────────────────────────────

async function collect(t: ReturnType<typeof createGroupTransform>, rows: Record<string, unknown>[]): Promise<unknown[]> {
  const results: unknown[] = [];

  t.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      results.push(JSON.parse(line));
    }
  });

  for (const row of rows) t.write(row);
  await new Promise<void>(resolve => t.end(resolve));

  return results;
}

describe('createGroupTransform — REST rows (no _action_ column)', () => {
  it('emits each row as a plain object', async () => {
    const t = createGroupTransform({});
    const out = await collect(t, [{ symbol: 'XBTUSD', price: '50000' }]);
    expect(out).toEqual([{ symbol: 'XBTUSD', price: '50000' }]);
  });

  it('emits multiple rows independently', async () => {
    const t = createGroupTransform({});
    const out = await collect(t, [
      { symbol: 'XBTUSD', price: '100' },
      { symbol: 'ETHUSD', price: '200' },
    ]);
    expect(out).toEqual([
      { symbol: 'XBTUSD', price: '100' },
      { symbol: 'ETHUSD', price: '200' },
    ]);
  });

  it('applies casts to plain rows', async () => {
    const t = createGroupTransform({ price: 'number' });
    const out = await collect(t, [{ symbol: 'XBTUSD', price: '50000' }]);
    expect(out).toEqual([{ symbol: 'XBTUSD', price: 50000 }]);
  });
});

describe('createGroupTransform — WS rows (with _action_ column)', () => {
  it('single-row message: emits { action, date, data: [row] }', async () => {
    const t = createGroupTransform({});
    const out = await collect(t, [
      { _date_: '2025-01-01T00:00:00.000Z', _action_: 'partial', id: '1', msg: 'a' },
    ]);
    expect(out).toEqual([{
      action: 'partial',
      date:   '2025-01-01T00:00:00.000Z',
      data:   [{ id: '1', msg: 'a' }],
    }]);
  });

  it('multi-row message: groups all rows under one { action, date, data }', async () => {
    const t = createGroupTransform({});
    const out = await collect(t, [
      { _date_: '2025-01-01T00:00:00.000Z', _action_: 'insert', id: '1', msg: 'a' },
      { _date_: '',                          _action_: '',        id: '2', msg: 'b' },
      { _date_: '',                          _action_: '',        id: '3', msg: 'c' },
    ]);
    expect(out).toEqual([{
      action: 'insert',
      date:   '2025-01-01T00:00:00.000Z',
      data:   [{ id: '1', msg: 'a' }, { id: '2', msg: 'b' }, { id: '3', msg: 'c' }],
    }]);
  });

  it('multiple messages: each flushed independently', async () => {
    const t = createGroupTransform({});
    const out = await collect(t, [
      { _date_: '2025-01-01T00:00:00.000Z', _action_: 'partial', id: '1' },
      { _date_: '',                          _action_: '',        id: '2' },
      { _date_: '2025-01-01T00:01:00.000Z', _action_: 'insert',  id: '3' },
    ]);
    expect(out).toEqual([
      { action: 'partial', date: '2025-01-01T00:00:00.000Z', data: [{ id: '1' }, { id: '2' }] },
      { action: 'insert',  date: '2025-01-01T00:01:00.000Z', data: [{ id: '3' }] },
    ]);
  });

  it('strips _date_ and _action_ from the emitted data rows', async () => {
    const t = createGroupTransform({});
    const out = await collect(t, [
      { _date_: '2025-01-01T00:00:00.000Z', _action_: 'partial', symbol: 'XBTUSD', price: '100' },
      { _date_: '',                          _action_: '',        symbol: 'ETHUSD', price: '200' },
    ]) as Array<{ data: unknown[] }>;
    expect(out[0]!.data).toEqual([
      { symbol: 'XBTUSD', price: '100' },
      { symbol: 'ETHUSD', price: '200' },
    ]);
  });

  it('applies casts to data row fields', async () => {
    const t = createGroupTransform({ price: 'number' });
    const out = await collect(t, [
      { _date_: '2025-01-01T00:00:00.000Z', _action_: 'insert', symbol: 'XBTUSD', price: '100' },
    ]) as Array<{ data: unknown[] }>;
    expect(out[0]!.data).toEqual([{ symbol: 'XBTUSD', price: 100 }]);
  });

  it('orphan continuation with no open group: emits as plain object', async () => {
    const t = createGroupTransform({});
    const out = await collect(t, [
      { _date_: '', _action_: '', id: '1' },
    ]);
    expect(out).toEqual([{ id: '1' }]);
  });

  it('drops empty string fields from data rows', async () => {
    const t = createGroupTransform({});
    const out = await collect(t, [
      { _date_: '2025-01-01T00:00:00.000Z', _action_: 'insert', symbol: 'XBTUSD', price: '' },
    ]) as Array<{ data: unknown[] }>;
    // empty price string is dropped by applyRow
    expect(out[0]!.data).toEqual([{ symbol: 'XBTUSD' }]);
  });
});

// ── listFiles ─────────────────────────────────────────────────────────────────

describe('storage — listFiles', () => {
  it('returns open for .csv.gz.tmp files and closed for .csv.gz files', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as never);
    vi.mocked(readdirSync)
      .mockReturnValueOnce(['2025'] as never)
      .mockReturnValueOnce(['20250101.csv.gz', '20250102.csv.gz.tmp', '20250103.csv.gz'] as never);

    expect(listFiles('trade')).toEqual({
      '20250101': 'closed',
      '20250102': 'open',
      '20250103': 'closed',
    });
  });

  it('excludes non-csv files', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as never);
    vi.mocked(readdirSync)
      .mockReturnValueOnce(['2025'] as never)
      .mockReturnValueOnce(['20250101.csv.gz', '.health-canary', 'other.txt'] as never);

    expect(listFiles('trade')).toEqual({ '20250101': 'closed' });
  });

  it('collects files across multiple year directories', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as never);
    vi.mocked(readdirSync)
      .mockReturnValueOnce(['2024', '2025'] as never)
      .mockReturnValueOnce(['20241231.csv.gz'] as never)
      .mockReturnValueOnce(['20250101.csv.gz'] as never);

    expect(listFiles('trade')).toEqual({
      '20241231': 'closed',
      '20250101': 'closed',
    });
  });

  it('returns empty object when directory does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    expect(listFiles('trade')).toEqual({});
  });
});

// ── readHeaders ──────────────────────────────────────────────────────────────

describe('storage — readHeaders', () => {
  it('returns headers from memory without a disk read for an open file', async () => {
    vi.mocked(createReadStream).mockClear();

    vi.mocked(createGzip).mockReturnValue(mockGzip().handle as never);
    vi.mocked(createWriteStream).mockReturnValue(mockFileStream().handle as never);
    vi.mocked(existsSync).mockReturnValue(false);

    insertRow('test_headers', '20260101', { symbol: 'XBTUSD', price: 1, qty: 2 });

    const cols = await readHeaders('test_headers', '20260101');

    expect(cols).toEqual(['symbol', 'price', 'qty']);
    expect(createReadStream).not.toHaveBeenCalled();
  });

  it('reads the first line from an open .csv.gz.tmp file on disk (decompressed)', async () => {
    vi.mocked(existsSync).mockImplementation((p) => (p as string).endsWith('.csv.gz.tmp'));

    const fakeGunzip = {};
    vi.mocked(createGunzip).mockReturnValue(fakeGunzip as never);

    const fakeStream = { pipe: vi.fn().mockReturnValue(fakeGunzip), destroy: vi.fn() };
    vi.mocked(createReadStream).mockReturnValue(fakeStream as never);

    const rl = Object.assign(new EventEmitter(), { close: vi.fn() });
    vi.mocked(createInterface).mockReturnValue(rl as never);

    const promise = readHeaders('trade', '20260201');
    rl.emit('line', 'timestamp,symbol,price');

    expect(await promise).toEqual(['timestamp', 'symbol', 'price']);
    expect(createReadStream).toHaveBeenCalledWith(`${DATA_DIR}/trade/2026/20260201.csv.gz.tmp`);
  });

  it('reads the first line from a closed .csv.gz file on disk', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = p as string;
      return s.endsWith('.csv.gz') && ! s.endsWith('.tmp');
    });

    const fakeGunzip = {};
    vi.mocked(createGunzip).mockReturnValue(fakeGunzip as never);

    const fakeStream = { pipe: vi.fn().mockReturnValue(fakeGunzip), destroy: vi.fn() };
    vi.mocked(createReadStream).mockReturnValue(fakeStream as never);

    const rl = Object.assign(new EventEmitter(), { close: vi.fn() });
    vi.mocked(createInterface).mockReturnValue(rl as never);

    const promise = readHeaders('trade', '20260301');
    rl.emit('line', 'a,b,c');

    expect(await promise).toEqual(['a', 'b', 'c']);
    expect(createReadStream).toHaveBeenCalledWith(`${DATA_DIR}/trade/2026/20260301.csv.gz`);
  });

  it('throws NotFoundError when neither file exists', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    await expect(readHeaders('trade', '20260401')).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── fileExists ────────────────────────────────────────────────────────────────

describe('storage — fileExists', () => {
  it('returns true when the closed file exists', () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = p as string;
      return s.endsWith('.csv.gz') && ! s.endsWith('.tmp');
    });

    expect(fileExists('trade', '20250101')).toBe(true);
  });

  it('returns true when an open .csv.gz.tmp file exists', () => {
    vi.mocked(existsSync).mockImplementation((p) => (p as string).endsWith('.csv.gz.tmp'));

    expect(fileExists('trade', '20250101')).toBe(true);
  });

  it('returns false when neither file exists', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    expect(fileExists('trade', '20250101')).toBe(false);
  });
});
