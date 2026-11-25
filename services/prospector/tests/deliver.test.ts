import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BODY_CEILING, BODY_TOO_LARGE, REDIRECT_REFUSED, _test_readAll, declined, deliver } from '../src/deliver';
import { fault, faultLine } from '../src/faults';
import { _test_rebuilt, _test_workersFor } from '../src/transport';
import type { Server } from 'node:http';
import type { Server as HttpsServer } from 'node:https';

/**
 * The transfer, on its own: what a request comes back with, and when it counts
 * as over. See `deliver.ts`.
 */

let server: Server;
let url:    string;

beforeEach(async () => {
  server = createServer((req, res) => {
    if (req.url?.includes('refused')) {
      res.writeHead(403, { server: 'CloudFront', 'x-cache': 'Error from cloudfront' });
      res.end('<html>go away</html>');

      return;
    }

    res.writeHead(200, { etag: '"abc"' });
    res.write('<ListBucketResult><IsTruncated>');
    res.end('false</IsTruncated></ListBucketResult>');
  });

  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));

  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  vi.useRealTimers();
  server.closeAllConnections();

  await new Promise(done => server.close(done));
});

describe('a listing', () => {
  it('comes back with its page read', async () => {
    const carried = await deliver(`${url}/?prefix=spot/`, { format: 's3', prefix: '' });

    expect(carried.status).toBe(200);
    expect(carried.page).toEqual({ listed: [], prefixes: [], next: null });
    expect(carried.headers.etag).toBe('"abc"');
  });

  /** Nobody reads a refusal's body; its headers are what say whose refusal it is. */
  it('comes back from a refusal with headers and no page', async () => {
    const carried = await deliver(`${url}/refused`, { format: 's3', prefix: '' });

    expect(carried.status).toBe(403);
    expect(carried.page).toBeNull();
    expect(carried.headers['x-cache']).toBe('Error from cloudfront');
  });

  /** A body that stops arriving fails on the read, rather than waiting on a socket forever. */
  it('fails once the body goes silent', async () => {
    vi.useFakeTimers();

    const silent  = new Response(new ReadableStream({ start: c => c.enqueue(new TextEncoder().encode('<List')) }));
    const control = new AbortController();
    const reading = _test_readAll(silent, control, 1024);

    reading.catch(() => {});

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(reading).rejects.toThrow(/went silent/);
    expect(control.signal.aborted).toBe(true);
  });
});

describe('a probe', () => {
  it('comes back with status and headers, and no page', async () => {
    const carried = await deliver(`${url}/a.zip`, null);

    expect(carried).toEqual({ status: 200, headers: expect.objectContaining({ etag: '"abc"' }), page: null });
  });
});

/** A failure that crossed from a worker reads in the log as it did where it happened. */
describe('a failure carried back', () => {
  it('reads the same once rebuilt', () => {
    const original = new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });

    expect(faultLine(_test_rebuilt(fault(original)))).toBe(faultLine(original));
  });
});

/** Raising the machine's ceiling brings the workers to carry it. */
describe('how many workers carry the requests', () => {
  it('is one up to a thousand in flight', () => {
    expect([1, 200, 1000].map(_test_workersFor)).toEqual([1, 1, 1]);
  });

  it('is one more for every thousand beyond', () => {
    expect([1001, 2000, 2500].map(_test_workersFor)).toEqual([2, 2, 3]);
  });
});

/**
 * A listing follows a redirect only to `https` on the host it asked, and reads
 * a body only up to its format's ceiling. See `followed` and `readAll`.
 */
describe('a listing redirected', () => {
  const tls = {
    key:  readFileSync(join(__dirname, 'fixtures/tls/key.pem')),
    cert: readFileSync(join(__dirname, 'fixtures/tls/cert.pem')),
  };

  let secure:  HttpsServer;
  let port:    number;
  let trusted: string | undefined;

  beforeAll(async () => {
    trusted = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    secure = createHttps(tls, (req, res) => {
      if (req.url === '/loop') {
        res.writeHead(307, { location: '/loop' });
        res.end();

        return;
      }

      const to = new URL(req.url ?? '/', 'https://x').searchParams.get('to');

      if (to !== null) {
        res.writeHead(302, { location: to.replace('PORT', String(port)) });
        res.end('moved');

        return;
      }

      res.writeHead(200);
      res.end('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>');
    });

    await new Promise<void>(ready => secure.listen(0, '127.0.0.1', ready));

    port = (secure.address() as { port: number }).port;
  });

  afterAll(async () => {
    if (trusted === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = trusted;

    secure.closeAllConnections();

    await new Promise(done => secure.close(done));
  });

  const refusedFor = async (listingUrl: string): Promise<Error> => {
    const failure = await deliver(listingUrl, { format: 's3', prefix: '' }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(Error);
    expect(declined(failure)).toBe(REDIRECT_REFUSED);

    return failure as Error;
  };

  it('is followed to https on the same host', async () => {
    const carried = await deliver(`https://localhost:${port}/?to=/listing`, { format: 's3', prefix: '' });

    expect(carried.status).toBe(200);
    expect(carried.page).toEqual({ listed: [], prefixes: [], next: null });
  });

  it('is refused to another host, naming it', async () => {
    const failure = await refusedFor(`https://localhost:${port}/?to=https://127.0.0.1:PORT/listing`);

    expect(failure.message).toContain(`127.0.0.1:${port}`);
  });

  it('is refused to plain http, even on the same host', async () => {
    await refusedFor(`https://localhost:${port}/?to=http://localhost:PORT/listing`);
  });

  it('is refused past a handful of hops', async () => {
    const failure = await refusedFor(`https://localhost:${port}/?to=/?to=/loop`);

    expect(failure.message).toMatch(/more than \d+ times/);
  });

  /** A plain-http listing has nowhere to be redirected: `https` is the only place a redirect may lead. */
  it('is refused from plain http', async () => {
    const plain = createServer((_req, res) => {
      res.writeHead(301, { location: '/elsewhere' });
      res.end();
    });

    await new Promise<void>(ready => plain.listen(0, '127.0.0.1', ready));

    try {
      await refusedFor(`http://127.0.0.1:${(plain.address() as { port: number }).port}/`);
    } finally {
      plain.closeAllConnections();
      await new Promise(done => plain.close(done));
    }
  });
});

describe('a listing body', () => {
  it('is refused once it passes its ceiling', async () => {
    const endless = new Response(new ReadableStream({
      pull: c => c.enqueue(new Uint8Array(1024)),
    }));

    const control = new AbortController();
    const failure = await _test_readAll(endless, control, 64 * 1024).catch((err: unknown) => err);

    expect(declined(failure)).toBe(BODY_TOO_LARGE);
    expect(control.signal.aborted).toBe(true);
  });

  it('is read in full up to it', async () => {
    const text = await _test_readAll(new Response('x'.repeat(1024)), new AbortController(), 1024);

    expect(text).toHaveLength(1024);
  });

  it('has a ceiling for every format a listing is read in', () => {
    expect(Object.keys(BODY_CEILING).sort()).toEqual(['index', 's3']);
  });
});
