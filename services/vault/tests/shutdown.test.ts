import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { gunzipSync } from 'zlib';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import request from 'supertest';

// Real buffers, bucket state and writer over a temp data dir.

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

import { shutdownVault, isShuttingDown, _test_reset as resetShutdown } from '../src/shutdown';
import { buffers, _test_reset as resetBuffers } from '../src/data/buffers';
import { _test_reset as resetBucket } from '../src/data/bucket';
import { _test_tick } from '../src/data/ticker';
import { closeBucket } from '../src/data/close';
import { _test_reset as resetWriter } from '../src/fs/writer';
import { _test_reset as resetHealth } from '../src/fs/health';
import { registerRoutes } from '../src/server/routes';
import { openPath, closedPath } from '../src/fs/paths';
import { TABLE_HEADERS } from '../src/data/headers';

const HEADER   = TABLE_HEADERS['trade']!.join(',');
const noServer = { close: async () => {} };

const decode = (file: string): string[] => gunzipSync(readFileSync(file)).toString('utf8').split('\n').slice(0, -1);
const rows   = (n: number, tag = 'row'): string[] => Array.from({ length: n }, (_, i) => `${tag}-${i}`);

let tmpDir: string;

beforeEach(() => {
  tmpDir = data.dir = mkdirSync(path.join(os.tmpdir(), `vault-shutdown-test-${Date.now()}-${Math.random()}`), { recursive: true }) as string;
  resetShutdown();
  resetBuffers();
  resetBucket();
  resetWriter();
  resetHealth();
});

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('shutdownVault', () => {
  it('waits for batches the ticker already handed to writers', async () => {
    buffers.get('trade', '20230201').pushMany(rows(10_000, 'a'));
    buffers.get('tick',  '20230201').pushMany(rows(10_000, 'b'));

    _test_tick();

    await shutdownVault(noServer);

    expect(decode(openPath('trade', '20230201'))).toEqual([HEADER, ...rows(10_000, 'a')]);
    expect(decode(openPath('tick',  '20230201'))).toEqual([TABLE_HEADERS['tick']!.join(','), ...rows(10_000, 'b')]);
  });

  it('writes buffers that never reached the batch size, without sealing them', async () => {
    buffers.get('trade', '20230201').pushMany(rows(3));

    await shutdownVault(noServer);

    expect(existsSync(closedPath('trade', '20230201'))).toBe(false);
    expect(decode(openPath('trade', '20230201'))).toEqual([HEADER, ...rows(3)]);
  });

  it('waits for a seal in progress, including its rename', async () => {
    buffers.get('trade', '20230201').pushMany(rows(50_000));

    const closed = closeBucket('trade', '20230201');

    await shutdownVault(noServer);

    expect(existsSync(openPath('trade', '20230201'))).toBe(false);
    expect(decode(closedPath('trade', '20230201'))).toEqual([HEADER, ...rows(50_000)]);
    await closed;
  });

  it('writes rows buffered while the HTTP server was still closing', async () => {
    const http = {
      close: () => new Promise<void>((resolve) => {
        setTimeout(() => {
          buffers.get('trade', '20230201').pushMany(rows(5, 'late'));
          resolve();
        }, 20);
      }),
    };

    await shutdownVault(http);

    expect(decode(openPath('trade', '20230201'))).toEqual([HEADER, ...rows(5, 'late')]);
  });

  it('does not touch buffers until the HTTP server has closed', async () => {
    buffers.get('trade', '20230201').pushMany(rows(2));

    let seenDuringClose: boolean | undefined;

    const http = {
      close: async () => { seenDuringClose = existsSync(openPath('trade', '20230201')); },
    };

    await shutdownVault(http);

    expect(seenDuringClose).toBe(false);
    expect(decode(openPath('trade', '20230201'))).toEqual([HEADER, ...rows(2)]);
  });

  it('still drains when the HTTP close fails', async () => {
    buffers.get('trade', '20230201').pushMany(rows(2));

    await shutdownVault({ close: () => Promise.reject(new Error('close failed')) });

    expect(decode(openPath('trade', '20230201'))).toEqual([HEADER, ...rows(2)]);
  });

  it('drains the other buckets when one cannot be written', async () => {
    // A regular file where the table directory should be.
    writeFileSync(path.join(tmpDir, 'funding'), '');

    buffers.get('funding', '20230201').pushMany(rows(2));
    buffers.get('trade',   '20230201').pushMany(rows(2));

    await expect(shutdownVault(noServer)).resolves.toBeUndefined();

    expect(decode(openPath('trade', '20230201'))).toEqual([HEADER, ...rows(2)]);
  });
});

describe('write routes during shutdown', () => {
  const app = express();
  app.use(express.json());
  registerRoutes(app);

  it('answer 503 and buffer nothing once shutdown has started', async () => {
    await shutdownVault(noServer);

    expect(isShuttingDown()).toBe(true);

    const post = await request(app).post('/files/trade/20230201/rows').send({ timestamp: 't', symbol: 'X' });
    const close = await request(app).post('/files/trade/20230201/close').send();
    const put = await request(app)
      .put('/files/trade/20230201')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('bytes'));
    const del = await request(app).delete('/files/trade/20230201');

    expect([post.status, close.status, put.status, del.status]).toEqual([503, 503, 503, 503]);
    expect(buffers.flushAll()).toEqual([]);
    expect(existsSync(path.join(tmpDir, 'trade'))).toBe(false);
  });

  it('still serve reads', async () => {
    await shutdownVault(noServer);

    const res = await request(app).get('/tables');

    expect(res.status).toBe(200);
  });
});
