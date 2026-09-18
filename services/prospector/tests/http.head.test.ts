import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchHead } from '../src/http';
import { _test_paces } from '../src/pace';
import type { Server } from 'node:http';
import type { Adapter } from '../src/types';

/**
 * A probe reuses its connection.
 *
 * **The case this exists for:** probes through `fetch` opened a new connection
 * for every `HEAD`, which against a bucket ~260 ms away cost a TLS handshake per
 * probe and capped this machine at ~200 probes a second. The server here counts
 * the connections it is opened, which is exactly what a venue would see.
 */

let server:      Server;
let url:         string;
let connections: number;

const venue = (): Adapter => ({
  name: 'fake', base: url, keyRoot: '', pacing: { perSecond: 1000, concurrency: 10 },
} as unknown as Adapter);

beforeEach(async () => {
  connections = 0;
  _test_paces.clear();

  server = createServer((req, res) => {
    const missing = req.url?.includes('missing');

    res.writeHead(missing ? 404 : 200, missing ? {} : { etag: '"abc"', 'content-length': '1234' });
    res.end();
  });

  server.on('connection', () => { connections++; });

  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));

  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  server.closeAllConnections();

  await new Promise(done => server.close(done));
});

describe('probing', () => {
  it('asks over one connection, probe after probe', async () => {
    for (const key of ['a.zip', 'b.zip', 'c.zip']) await fetchHead(venue(), `${url}/${key}`);

    expect(connections).toBe(1);
  });

  it('carries the headers a probe settles on', async () => {
    const probed = await fetchHead(venue(), `${url}/a.zip`);

    expect(probed.status).toBe(200);
    expect(probed.headers.get('etag')).toBe('"abc"');
    expect(probed.headers.get('content-length')).toBe('1234');
  });

  /** Absence is an answer, returned rather than retried. */
  it('returns a 404 as it came', async () => {
    const probed = await fetchHead(venue(), `${url}/missing.zip`);

    expect(probed.status).toBe(404);
  });
});
