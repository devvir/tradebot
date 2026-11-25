import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@devvir/service-kit';
import { openScratch, putVenue } from './fixture';
import { mount } from '../src/api';
import type { Application } from 'express';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The API's edge, through the real `mount`: the token, the bodies it reads, a
 * path nothing answers, a fault in a route, and a request whose client is gone.
 */

const TOKEN = 'secret';

let dir:    string;
let db:     DatabaseSync;
let server: ReturnType<Application['listen']>;
let port:   number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'api-'));
  db  = openScratch(join(dir, 'catalog.db'));

  putVenue(db, 'binance', 'https://data.binance.vision', 'data/');

  const app = express();

  mount(app, db, TOKEN);

  server = app.listen(0);
  port   = (server.address() as { port: number }).port;

  vi.mocked(logger.error).mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  if (db.isOpen) db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Answer { status: number; type: string; text: string }

/**
 * One request over a connection of its own, its body sent as given. An answer
 * that comes before the body has all been sent is read all the same.
 */
const ask = (method: string, path: string, { body, headers = {} }: { body?: string | Buffer; headers?: Record<string, string> } = {}): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, agent: false, headers: {
      'content-type': 'application/json',
      ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
      ...headers,
    } }, res => {
      let text = '';

      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type'] ?? ''), text }));
    });

    // The server may answer and close before taking the whole body: what it answered is what is looked at.
    req.on('error', err => { if (! (err as NodeJS.ErrnoException).code?.startsWith('E')) reject(err); });
    req.end(body);
  });

const WITH_TOKEN = { 'x-catalog-token': TOKEN };

/** A JSON body of about `bytes`, a lens write whose note fills it. */
const lensOf = (bytes: number): string => JSON.stringify({ slug: 'big', note: 'x'.repeat(bytes) });

/** A report of `count` keys no file has, each long enough that the report is about `bytes`. */
const reportOf = (count: number, bytes: number): string => {
  const pad = 'k'.repeat(Math.max(1, Math.floor(bytes / count) - 10));

  return JSON.stringify({ failed: Array.from({ length: count }, (_, n) => `${pad}${n}`) });
};

describe('the token', () => {
  it('is required: without it a request is a 401', async () => {
    const { status, text } = await ask('GET', '/venues');

    expect(status).toBe(401);
    expect(JSON.parse(text)).toEqual({ error: 'Unauthorized' });
  });

  it('must be the one configured, whatever its length', async () => {
    for (const given of ['wrong', 'secreT', 'secret2', ''])
      expect((await ask('GET', '/venues', { headers: { 'x-catalog-token': given } })).status).toBe(401);
  });

  it('lets a request that carries it through', async () => {
    const { status, text } = await ask('GET', '/venues', { headers: WITH_TOKEN });

    expect(status).toBe(200);
    expect(JSON.parse(text).items.map((one: { venue: string }) => one.venue)).toEqual(['binance']);
  });

  it('is checked before a path is looked up', async () => {
    expect((await ask('GET', '/nope')).status).toBe(401);
  });

  it('is not asked for where none is configured', async () => {
    const open = express();

    mount(open, db, '');

    const other = open.listen(0);

    try {
      const res = await fetch(`http://127.0.0.1:${(other.address() as { port: number }).port}/venues`);

      expect(res.status).toBe(200);
    } finally {
      other.close();
    }
  });
});

describe('a body', () => {
  it('is not read for a request without the token', async () => {
    const { status, text } = await ask('POST', '/lenses', { body: `{${'x'.repeat(1_500_000)}` });

    expect(status).toBe(401);
    expect(JSON.parse(text)).toEqual({ error: 'Unauthorized' });
  });

  it('that is not JSON is a 400, with what the parser said', async () => {
    const { status, text } = await ask('POST', '/lenses', { body: '{"slug":', headers: WITH_TOKEN });

    expect(status).toBe(400);
    expect(JSON.parse(text).error).toMatch(/JSON/);
  });

  it('is taken up to 256 kB, and is a 413 beyond', async () => {
    const fits = await ask('POST', '/lenses/check', { body: JSON.stringify({ format: 1, venues: {}, pad: 'x'.repeat(200_000) }), headers: WITH_TOKEN });

    expect(fits.status).toBe(200);

    const { status, text } = await ask('POST', '/lenses', { body: lensOf(300_000), headers: WITH_TOKEN });

    expect(status).toBe(413);
    expect(JSON.parse(text)).toEqual({ error: 'request entity too large' });
  });

  it('is taken up to 5 MB for a report, and is a 413 beyond', async () => {
    const fits = await ask('POST', '/listings/report', { body: reportOf(10_000, 3_000_000), headers: { ...WITH_TOKEN, accept: 'application/json' } });

    // No key names a file: every one is answered as not settled, and the report itself is taken.
    expect(fits.status).toBe(207);
    expect(JSON.parse(fits.text).Error).toHaveLength(10_000);

    expect((await ask('POST', '/listings/report', { body: reportOf(10_000, 6_000_000), headers: WITH_TOKEN })).status).toBe(413);
  });
});

describe('a path no route answers', () => {
  it('is a JSON 404', async () => {
    for (const [method, path] of [['GET', '/nope'], ['DELETE', '/venues'], ['POST', '/venues/binance']] as const) {
      const { status, type, text } = await ask(method, path, { headers: WITH_TOKEN });

      expect(status).toBe(404);
      expect(type).toMatch(/^application\/json/);
      expect(JSON.parse(text)).toEqual({ error: 'Not found' });
    }
  });

  it('is S3\'s NoSuchKey under the listings', async () => {
    const { status, type, text } = await ask('GET', '/listings/x', { headers: WITH_TOKEN });

    expect(status).toBe(404);
    expect(type).toMatch(/^application\/xml/);
    expect(text).toContain('<Code>NoSuchKey</Code>');
  });
});

describe('a fault in a route', () => {
  it('is a 500 that says nothing of it, logged once', async () => {
    // A database closed under the API: the route's first read throws.
    db.close();

    const { status, text } = await ask('GET', '/venues', { headers: WITH_TOKEN });

    expect(status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: 'Internal error' });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('a request whose client has gone', () => {
  /**
   * Whether a request sent over a raw connection, reset as soon as it is
   * written, reached a route: the reset is in by the time the request has been
   * read, which is the disconnect a yield can notice.
   */
  const sentAndGone = async (): Promise<{ arrived: boolean; ran: boolean }> => {
    const prepare = vi.spyOn(db, 'prepare');
    let arrived   = false;

    server.once('request', () => { arrived = true; });

    await new Promise<void>(done => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(`GET /venues HTTP/1.1\r\nHost: x\r\nX-Catalog-Token: ${TOKEN}\r\n\r\n`);
        socket.resetAndDestroy();
      });

      socket.on('error', () => undefined);
      socket.on('close', () => done());
    });

    await new Promise(settled => setTimeout(settled, 100));

    return { arrived, ran: prepare.mock.calls.length > 0 };
  };

  it('is never worked on', async () => {
    expect(await sentAndGone()).toEqual({ arrived: true, ran: false });
  });

  it('is, where the client waits for the answer', async () => {
    const prepare = vi.spyOn(db, 'prepare');

    expect((await ask('GET', '/venues', { headers: WITH_TOKEN })).status).toBe(200);
    expect(prepare).toHaveBeenCalled();
  });
});
