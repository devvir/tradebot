import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _test_readAll, _test_wires, connectionsAtMost, deliver } from '../src/deliver';
import { fault, faultLine } from '../src/faults';
import { _test_rebuilt, _test_workersFor } from '../src/transport';
import type { Server } from 'node:http';

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
    res.write('<ListBucketResult>');
    res.end('</ListBucketResult>');
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
    const reading = _test_readAll(silent, control);

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
 * A network that caps the connections one device holds tears down the open ones
 * when crossed, so HTTP/1.1 requests past the limit wait instead of connecting.
 */
describe('a cap on connections', () => {
  afterEach(() => connectionsAtMost(Infinity));

  it('never has more requests open than it allows, and loses none', async () => {
    let open = 0;
    let most = 0;

    const slow = createServer((_req, res) => {
      most = Math.max(most, ++open);

      setTimeout(() => {
        open--;
        res.writeHead(200, { 'content-length': '0' });
        res.end();
      }, 50);
    });

    await new Promise<void>(ready => slow.listen(0, '127.0.0.1', ready));

    const at = `http://127.0.0.1:${(slow.address() as { port: number }).port}`;

    connectionsAtMost(2);

    const answers = await Promise.all(Array.from({ length: 6 }, (_, i) => deliver(`${at}/${i}.zip`, null)));

    expect(answers.map(one => one.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(most).toBe(2);
    expect(_test_wires.taken).toBe(0);

    slow.closeAllConnections();

    await new Promise(done => slow.close(done));
  });
});
