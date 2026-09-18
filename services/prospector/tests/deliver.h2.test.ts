import { readFileSync } from 'node:fs';
import { createServer as createHttps } from 'node:https';
import { createSecureServer } from 'node:http2';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliver } from '../src/deliver';
import type { Server as HttpsServer } from 'node:https';
import type { Http2SecureServer, ServerHttp2Session } from 'node:http2';

/**
 * Probing over HTTP/2 where a host offers it. See `head` in `deliver.ts`.
 *
 * **The case this exists for:** a missing key answered with neither a length
 * nor chunking, which Node's HTTP/1.1 client answers by closing the connection.
 * The server below replies exactly that way and counts the connections it is
 * opened.
 */

const tls = {
  key:  readFileSync(join(__dirname, 'fixtures/tls/key.pem')),
  cert: readFileSync(join(__dirname, 'fixtures/tls/cert.pem')),
};

let h2server:    Http2SecureServer;
let h1server:    HttpsServer;
let h2url:       string;
let h1url:       string;
let connections: number;
let trusted:     string | undefined;

const sessions: ServerHttp2Session[] = [];

beforeAll(async () => {
  trusted = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  connections = 0;

  h2server = createSecureServer({ ...tls, allowHTTP1: true }, (req, res) => {
    if (req.url.includes('missing')) {
      res.writeHead(403, { server: 'AmazonS3' });
      res.end();

      return;
    }

    res.writeHead(200, { etag: '"abc"', 'content-length': '1234' });
    res.end();
  });

  h2server.on('secureConnection', () => { connections++; });
  h2server.on('session', session => sessions.push(session));

  h1server = createHttps(tls, (_req, res) => {
    res.writeHead(200, { etag: '"old"' });
    res.end();
  });

  await new Promise<void>(ready => h2server.listen(0, '127.0.0.1', ready));
  await new Promise<void>(ready => h1server.listen(0, '127.0.0.1', ready));

  h2url = `https://localhost:${(h2server.address() as { port: number }).port}`;
  h1url = `https://localhost:${(h1server.address() as { port: number }).port}`;
});

afterAll(async () => {
  if (trusted === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = trusted;

  // The client keeps its connection by design, so the server ends it.
  for (const session of sessions) session.destroy();

  h1server.closeAllConnections();

  await new Promise(done => h2server.close(done));
  await new Promise(done => h1server.close(done));
});

describe('a host that speaks HTTP/2', () => {
  it('answers a probe with its status and headers', async () => {
    const carried = await deliver(`${h2url}/a.zip`, null);

    expect(carried.status).toBe(200);
    expect(carried.headers.etag).toBe('"abc"');
    expect(carried.headers['content-length']).toBe('1234');
    expect(Object.keys(carried.headers).some(name => name.startsWith(':'))).toBe(false);
  });

  /** One handshake to learn the protocol, one connection for every probe after it. */
  it('keeps its connection through missing keys', async () => {
    const before = connections;

    for (let i = 0; i < 5; i++)
      expect((await deliver(`${h2url}/missing-${i}.zip`, null)).status).toBe(403);

    expect(connections - before).toBe(0);
  });
});

describe('a host that does not', () => {
  it('is probed over HTTP/1.1', async () => {
    const carried = await deliver(`${h1url}/a.zip`, null);

    expect(carried.status).toBe(200);
    expect(carried.headers.etag).toBe('"old"');
  });
});
