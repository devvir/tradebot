import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'fs';
import { gunzipSync, gzipSync } from 'zlib';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import request from 'supertest';

// Bucket lifecycle through the real routes, buffers, ticker and writer over a
// temp data dir.

// Read through a hoisted holder: the mocked module is evaluated before this
// file's top-level `let`s are initialised.
const data = vi.hoisted(() => ({ dir: '/nonexistent-vault-test-dir' }));

vi.mock('../src/fs/paths', () => {
  const dataDir    = () => data.dir;
  const tableDir   = (table: string) => path.join(dataDir(), table);
  const yearDir    = (table: string, filename: string) => path.join(tableDir(table), filename.slice(0, 4));
  const openPath   = (table: string, filename: string) => path.join(yearDir(table, filename), `${filename}.csv.gz.tmp`);
  const closedPath = (table: string, filename: string) => path.join(yearDir(table, filename), `${filename}.csv.gz`);

  return { get DATA_DIR() { return dataDir(); }, tableDir, yearDir, openPath, closedPath };
});

vi.mock('../src/fs/health', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/fs/health')>();

  return { ...actual, recordFailure: vi.fn(actual.recordFailure) };
});

import { buffers, _test_reset as resetBuffers } from '../src/data/buffers';
import { discardBucket, acceptsRows, _test_reset as resetBucket } from '../src/data/bucket';
import { _test_tick } from '../src/data/ticker';
import { drainAll, _test_reset as resetWriter } from '../src/fs/writer';
import { recordFailure, _test_reset as resetHealth } from '../src/fs/health';
import { registerRoutes } from '../src/server/routes';
import { openPath, closedPath } from '../src/fs/paths';
import { fileState } from '../src/fs/reader';
import { TABLE_HEADERS } from '../src/data/headers';

const HEADER = TABLE_HEADERS['tick']!.join(',');

const decode = (file: string): string[] => gunzipSync(readFileSync(file)).toString('utf8').split('\n').slice(0, -1);
const rows   = (n: number): string[] => Array.from({ length: n }, (_, i) => `row-${i}`);

const app = express();
app.use(express.json());
registerRoutes(app);

let tmpDir: string;

beforeEach(() => {
  tmpDir = data.dir = mkdirSync(path.join(os.tmpdir(), `vault-lifecycle-test-${Date.now()}-${Math.random()}`), { recursive: true }) as string;
  resetBuffers();
  resetBucket();
  resetWriter();
  resetHealth();
  vi.clearAllMocks();
});

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('tick with an unwritable table', () => {
  it('writes the other tables and records the failure instead of throwing', async () => {
    writeFileSync(path.join(tmpDir, 'funding'), 'not a directory');

    buffers.get('funding', '20240101').pushMany(rows(10_000));
    buffers.get('tick',    '20240101').pushMany(rows(10_000));

    expect(() => _test_tick()).not.toThrow();

    await drainAll();

    expect(decode(openPath('tick', '20240101'))).toEqual([HEADER, ...rows(10_000)]);
    await vi.waitFor(() => expect(recordFailure).toHaveBeenCalledTimes(1));
    expect(vi.mocked(recordFailure).mock.calls[0]![0]).toMatch(/funding\/20240101/);
  });
});

describe('close after a failed seal', () => {
  const row = { timestamp: '2024-01-01T00:00:00.000Z', symbol: 'XBTUSD', price: 1, tickDirection: 'PlusTick' };

  it('accepts rows again and a second close seals the file', async () => {
    expect((await request(app).post('/files/tick/20240101/rows').send(row)).status).toBe(202);

    // Get the bucket onto disk with a live writer, then remove its open file
    // so the seal fails.
    buffers.get('tick', '20240101').pushMany(rows(10_000));
    _test_tick();
    await drainAll();
    rmSync(openPath('tick', '20240101'));

    expect((await request(app).post('/files/tick/20240101/close')).status).toBe(202);
    await drainAll();

    expect(existsSync(closedPath('tick', '20240101'))).toBe(false);

    const again = await request(app).post('/files/tick/20240101/rows').send(row);
    expect(again.status).toBe(202);

    expect((await request(app).post('/files/tick/20240101/close')).status).toBe(202);
    await drainAll();

    const lines = decode(closedPath('tick', '20240101'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(HEADER);
    expect(lines[1]).toMatch(/^2024-01-01T00:00:00.000Z,XBTUSD,/);

    const rejected = await request(app).post('/files/tick/20240101/rows').send(row);
    expect(rejected.status).toBe(409);
  });
});

describe('discarding a bucket with members still queued', () => {
  it('DELETE right after a tick leaves no open file behind', async () => {
    buffers.get('tick', '20240101').pushMany(rows(10_000));
    _test_tick();

    expect((await request(app).delete('/files/tick/20240101')).status).toBe(204);
    await drainAll();

    expect(fileState('tick', '20240101')).toBe('none');
  });

  it('a bucket written after the discard keeps its new file, header first', async () => {
    buffers.get('tick', '20240101').pushMany(rows(10_000));
    _test_tick();

    const discarded = discardBucket('tick', '20240101');

    expect(acceptsRows('tick', '20240101')).toBe(false);

    await discarded;

    buffers.get('tick', '20240101').pushMany(rows(10_000));
    _test_tick();
    await drainAll();

    expect(decode(openPath('tick', '20240101'))).toEqual([HEADER, ...rows(10_000)]);
  });
});

describe('PUT', () => {
  const body = gzipSync(`${HEADER}\n2024-01-01T00:00:00.000Z,XBTUSD,1,PlusTick\n`);
  const put  = (bytes: Buffer) => request(app)
    .put('/files/tick/20240101')
    .set('Content-Type', 'application/octet-stream')
    .send(bytes);

  it('stores a valid gzip body that then reads back', async () => {
    expect((await put(body)).status).toBe(204);

    const res = await request(app).get('/files/tick/20240101');

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/XBTUSD/);
  });

  it.each([
    ['an empty body',    Buffer.alloc(0)],
    ['a non-gzip body',  Buffer.from('this is not gzip')],
  ])('answers 400 for %s and stores nothing', async (_name, bytes) => {
    expect((await put(bytes)).status).toBe(400);

    expect(fileState('tick', '20240101')).toBe('none');
    expect(readdirSync(path.join(tmpDir, 'tick', '2024'))).toEqual([]);

    // A correct upload afterwards succeeds.
    expect((await put(body)).status).toBe(204);
  });

  it('over an open file with members queued, stores exactly the uploaded bytes', async () => {
    buffers.get('tick', '20240101').pushMany(rows(10_000));
    _test_tick();

    expect((await put(body)).status).toBe(204);
    await drainAll();

    expect(readFileSync(closedPath('tick', '20240101'))).toEqual(body);
    expect(existsSync(openPath('tick', '20240101'))).toBe(false);
  });

  it('answers 409 over an existing closed file and leaves it as it was', async () => {
    expect((await put(body)).status).toBe(204);
    expect((await put(gzipSync('other\n'))).status).toBe(409);

    expect(readFileSync(closedPath('tick', '20240101'))).toEqual(body);
  });
});
