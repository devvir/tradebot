import { createServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server, Socket } from 'node:net';

/**
 * A request bounded while its connection is being made, apart from how long
 * the connection may then be silent. See `http.ts`.
 */

const { get, _test_connectWithin } = await import('../src/http');

/** A server that takes every connection and says nothing on it: TCP made, no TLS handshake, no answer. */
let server:  Server;
let sockets: Socket[];
let port:    number;

beforeEach(async () => {
  sockets = [];
  server  = createServer(socket => { sockets.push(socket); });

  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));

  port = (server.address() as { port: number }).port;

  _test_connectWithin(200);
});

afterEach(async () => {
  _test_connectWithin(10_000);

  for (const socket of sockets) socket.destroy();

  await new Promise(done => server.close(done));
});

describe('a connection', () => {
  it('not made in time fails the request', async () => {
    const since = Date.now();

    await expect(get(`https://127.0.0.1:${port}/file`, new AbortController().signal)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(Date.now() - since).toBeLessThan(2_000);
  });

  it('made, and then waiting for its answer, is not held to the time to connect', async () => {
    const asked = new AbortController();
    let settled = false;

    void get(`http://127.0.0.1:${port}/file`, asked.signal).then(() => { settled = true; }, () => { settled = true; });

    await new Promise(done => setTimeout(done, 600));

    expect(sockets).toHaveLength(1);
    expect(settled).toBe(false);

    asked.abort();
  });
});
