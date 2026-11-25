import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { gzipSync } from 'zlib';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import request from 'supertest';

// The read routes over real closed files in a temp data dir: real parser,
// decoder and batching.

const data = vi.hoisted(() => ({ dir: '/nonexistent-vault-test-dir' }));

vi.mock('../../src/fs/paths', () => {
  const dataDir    = () => data.dir;
  const tableDir   = (table: string) => path.join(dataDir(), table);
  const yearDir    = (table: string, filename: string) => path.join(tableDir(table), filename.slice(0, 4));
  const openPath   = (table: string, filename: string) => path.join(yearDir(table, filename), `${filename}.csv.gz.tmp`);
  const closedPath = (table: string, filename: string) => path.join(yearDir(table, filename), `${filename}.csv.gz`);

  return { get DATA_DIR() { return dataDir(); }, tableDir, yearDir, openPath, closedPath };
});

import { registerRoutes } from '../../src/server/routes';

const app = express();
registerRoutes(app);

const DATE = '20230201';

const writeClosed = (table: string, bytes: Buffer): void => {
  const dir = path.join(data.dir, table, DATE.slice(0, 4));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${DATE}.csv.gz`), bytes);
};

const chatCsv = (n: number): string => {
  const lines = ['_date_,_action_,id,message'];

  for (let i = 0; i < n; i++) lines.push(`2023-02-01T00:00:${String(i % 60).padStart(2, '0')}Z,insert,${i},"message, number ${i}"`);

  return lines.join('\n') + '\n';
};

const chatNdjson = (n: number): string => {
  let out = '';

  for (let i = 0; i < n; i++) {
    out += JSON.stringify({
      action: 'insert',
      date:   `2023-02-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
      data:   [{ id: i, message: `message, number ${i}` }],
    }) + '\n';
  }

  return out;
};

// A gzip whose tail is cut inside the deflate data.
const truncated = (text: string): Buffer => {
  const gz = gzipSync(text);
  return gz.subarray(0, gz.length - 10);
};

const NOT_GZIP = Buffer.from('this is not gzip\n'.repeat(10));

beforeEach(() => {
  data.dir = mkdirSync(path.join(os.tmpdir(), `vault-read-test-${Date.now()}-${Math.random()}`), { recursive: true }) as string;
});

afterEach(() => {
  rmSync(data.dir, { recursive: true, force: true });
});

describe('GET /files/:table/:date', () => {
  it('streams a file larger than one chunk as the complete NDJSON body', async () => {
    const n = 5_000;
    writeClosed('chat', gzipSync(chatCsv(n)));

    const res = await request(app).get(`/files/chat/${DATE}`);

    expect(res.status).toBe(200);
    expect(res.text.length).toBeGreaterThan(64 * 1024);
    expect(res.text).toBe(chatNdjson(n));
  });

  it('answers 500 for a small truncated free-text file', async () => {
    writeClosed('chat', truncated(chatCsv(10)));

    const res = await request(app).get(`/files/chat/${DATE}`);

    expect(res.status).toBe(500);
  });

  it('answers 500 for a free-text file that is not gzip', async () => {
    writeClosed('chat', NOT_GZIP);

    const res = await request(app).get(`/files/chat/${DATE}`);

    expect(res.status).toBe(500);
  });

  it('cuts the response when a large free-text file turns out truncated', async () => {
    writeClosed('chat', truncated(chatCsv(20_000)));

    const outcome = await request(app).get(`/files/chat/${DATE}`).then(
      res => ({ status: res.status }),
      err => ({ error: (err as Error).message }),
    );

    // Either the body was cut (a client error) or nothing was sent yet (500).
    expect('error' in outcome || outcome.status === 500).toBe(true);
  });
});

describe('GET /files/:table/:date/headers', () => {
  it('answers 500 for a free-text file that is not gzip', async () => {
    writeClosed('chat', NOT_GZIP);

    const res = await request(app).get(`/files/chat/${DATE}/headers`);

    expect(res.status).toBe(500);
  });

  it('returns the columns of a readable free-text file', async () => {
    writeClosed('chat', gzipSync(chatCsv(3)));

    const res = await request(app).get(`/files/chat/${DATE}/headers`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ columns: ['_date_', '_action_', 'id', 'message'] });
  });
});
