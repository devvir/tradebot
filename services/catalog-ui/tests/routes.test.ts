import express from 'express';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupRoutes } from '../src/api/routes';
import type { Upstreams } from '../src/api/routes';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The proxy, over HTTP, between a client and stand-in upstreams on ephemeral
 * ports: what is forwarded, what is refused before it leaves, and what comes
 * back.
 */

interface Seen { method: string; url: string; headers: IncomingHttpHeaders; body: string }

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** A stand-in service recording every request; answers `{ ok: true }` unless a handler takes the path. */
const stub = async (handlers: Record<string, Handler> = {}) => {
  const seen: Seen[] = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers,
        body: Buffer.concat(chunks).toString() });

      const handler = handlers[(req.url ?? '').split('?')[0] ?? ''];

      if (handler) return handler(req, res);

      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });

  return { server, seen, url: `http://127.0.0.1:${await listen(server)}` };
};

const listen = (server: Server): Promise<number> =>
  new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

const close = (server: Server): Promise<void> =>
  new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

interface Answer { status: number; headers: IncomingHttpHeaders; body: Buffer }

/** A request to the proxy with exactly the headers given (plus `Host`), which `fetch` would not allow. */
const call = (method: string, path: string, init: { headers?: Record<string, string>; body?: string } = {}) =>
  new Promise<Answer>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: uiPort, method, path, headers: init.headers ?? {} }, res => {
      const chunks: Buffer[] = [];

      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });

    req.on('error', reject);
    req.end(init.body);
  });

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  headers: { 'content-type': 'application/json', ...headers },
  body:    JSON.stringify(body),
});

let catalog:    Awaited<ReturnType<typeof stub>>;
let prospector: Awaited<ReturnType<typeof stub>>;
let ui:         Server;
let uiPort:     number;

const start = async (over: Partial<Upstreams> = {}, handlers: Record<string, Handler> = {}): Promise<void> => {
  catalog    = await stub(handlers);
  prospector = await stub(handlers);

  const app = express();

  app.use(express.json());
  setupRoutes(app, {
    catalogApi:        catalog.url,
    prospectorApi:     prospector.url,
    catalogToken:      'sekret',
    allowedHosts:      [],
    upstreamTimeoutMs: 5_000,
    ...over,
  });

  ui     = createServer(app);
  uiPort = await listen(ui);
};

afterEach(async () => {
  await Promise.all([ui, catalog?.server, prospector?.server].filter(Boolean).map(one => close(one as Server)));
});

describe('what is forwarded', () => {
  beforeEach(() => start());

  it.each([
    ['GET',    '/api/catalog/venues'],
    ['GET',    '/api/catalog/venues/binance'],
    ['GET',    '/api/catalog/venues/binance/symbols'],
    ['GET',    '/api/catalog/venues/binance/markets/spot'],
    ['GET',    '/api/catalog/venues/binance/markets/spot/symbols'],
    ['GET',    '/api/catalog/lenses'],
    ['GET',    '/api/catalog/lenses/options'],
    ['GET',    '/api/catalog/lenses/mine/size'],
    ['HEAD',   '/api/catalog/venues'],
    ['DELETE', '/api/catalog/lenses/mine'],
    ['GET',    '/api/prospector/status'],
  ])('%s %s', async (method, path) => {
    const { status } = await call(method, path);
    const upstream   = path.startsWith('/api/catalog') ? catalog : prospector;

    expect(status).toBe(200);
    expect(upstream.seen).toHaveLength(1);
    expect(upstream.seen[0]?.method).toBe(method);
    expect(upstream.seen[0]?.headers['x-catalog-token']).toBe('sekret');
  });

  it.each([
    ['POST', '/api/catalog/lenses'],
    ['PUT',  '/api/catalog/lenses/mine'],
    ['POST', '/api/prospector/surveys'],
    ['POST', '/api/prospector/surveys/pause'],
    ['POST', '/api/prospector/venues/binance/surveys'],
  ])('%s %s, as JSON', async (method, path) => {
    const { status } = await call(method, path, json({ venue: 'binance' }));
    const upstream   = path.startsWith('/api/catalog') ? catalog : prospector;

    expect(status).toBe(200);
    expect(upstream.seen[0]).toMatchObject({
      method,
      body:    '{"venue":"binance"}',
      headers: { 'content-type': 'application/json', 'x-catalog-token': 'sekret' },
    });
  });

  it('keeps the path below the mount and the query string', async () => {
    await call('GET', '/api/catalog/venues/binance/symbols?market=spot&q=a%20b');

    expect(catalog.seen[0]?.url).toBe('/venues/binance/symbols?market=spot&q=a%20b');
  });

  it('forwards an encoded slash as one segment', async () => {
    const { status } = await call('GET', '/api/catalog/venues/a%2Fb');

    expect(status).toBe(200);
    expect(catalog.seen[0]?.url).toBe('/venues/a%2Fb');
  });

  it('passes x-catalog-lens and Accept, and defaults Accept to JSON', async () => {
    await call('GET', '/api/catalog/venues', { headers: { 'x-catalog-lens': 'mine', accept: 'text/plain' } });
    await call('GET', '/api/catalog/venues');

    expect(catalog.seen[0]?.headers).toMatchObject({ 'x-catalog-lens': 'mine', accept: 'text/plain' });
    expect(catalog.seen[1]?.headers.accept).toBe('application/json');
  });

  it('sends a GET and a bodiless DELETE with no body and no content type', async () => {
    await call('GET', '/api/catalog/venues');
    await call('DELETE', '/api/catalog/lenses/mine');

    for (const one of catalog.seen) {
      expect(one.body).toBe('');
      expect(one.headers['content-type']).toBeUndefined();
    }
  });

  it('answers /api/where itself', async () => {
    const { status, body } = await call('GET', '/api/where');

    expect(status).toBe(200);
    expect(JSON.parse(body.toString())).toEqual({ catalog: catalog.url });
  });
});

describe('without a token', () => {
  beforeEach(() => start({ catalogToken: '' }));

  it('sends none', async () => {
    await call('GET', '/api/catalog/venues');

    expect(catalog.seen[0]?.headers['x-catalog-token']).toBeUndefined();
  });
});

describe('what is not forwarded', () => {
  beforeEach(() => start());

  it.each([
    ['POST',   '/api/prospector/reports'],
    ['POST',   '/api/prospector/lenses'],
    ['PUT',    '/api/prospector/lenses/x'],
    ['DELETE', '/api/prospector/lenses/x'],
    ['GET',    '/api/prospector/venues/binance/surveys'],
    ['POST',   '/api/catalog/listings/report'],
    ['POST',   '/api/catalog/lenses/resolve'],
    ['POST',   '/api/catalog/lenses/size'],
    ['GET',    '/api/catalog/listings'],
    ['GET',    '/api/catalog/venues/binance/partitions'],
    ['GET',    '/api/catalog/lenses/mine'],
    ['DELETE', '/api/catalog/venues'],
    ['PATCH',  '/api/catalog/lenses/mine'],
    ['GET',    '/api/catalog/venues/%2e%2e'],
    ['GET',    '/api/catalog/venues/binance/markets/%2e%2e/symbols'],
    ['GET',    '/api/catalog'],
  ])('%s %s answers 404 and never reaches upstream', async (method, path) => {
    const { status, body } = await call(method, path, json({ downloaded: [1, 2, 3] }));

    expect(status).toBe(404);
    expect(JSON.parse(body.toString())).toEqual({ error: 'Not forwarded' });
    expect(catalog.seen).toHaveLength(0);
    expect(prospector.seen).toHaveLength(0);
  });

  it('never sends an absolute-form request target to the host it names', async () => {
    const foreign = await stub();

    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(uiPort, '127.0.0.1', () => {
          socket.write(`GET ${foreign.url}/api/catalog/venues HTTP/1.1\r\nHost: 127.0.0.1:${uiPort}\r\n`
            + 'Connection: close\r\n\r\n');
        });

        socket.on('data', () => undefined);
        socket.on('end', () => resolve());
        socket.on('error', reject);
      });

      expect(foreign.seen).toHaveLength(0);
    } finally {
      await close(foreign.server);
    }
  });
});

describe('what another site cannot make a browser send', () => {
  beforeEach(() => start());

  it.each([
    ['text/plain',                        'x'],
    ['application/x-www-form-urlencoded', 'a=1'],
    ['multipart/form-data; boundary=b',   '--b--'],
  ])('a %s POST answers 415', async (type, body) => {
    const { status } = await call('POST', '/api/prospector/surveys/pause', { headers: { 'content-type': type }, body });

    expect(status).toBe(415);
    expect(prospector.seen).toHaveLength(0);
  });

  it('a POST with no body answers 415', async () => {
    const { status } = await call('POST', '/api/prospector/surveys');

    expect(status).toBe(415);
    expect(prospector.seen).toHaveLength(0);
  });

  it('a JSON POST from another origin answers 403', async () => {
    const { status } = await call('POST', '/api/prospector/surveys',
      json({}, { origin: 'http://evil.example' }));

    expect(status).toBe(403);
    expect(prospector.seen).toHaveLength(0);
  });

  it.each(['cross-site', 'same-site'])('Sec-Fetch-Site: %s answers 403', async site => {
    const { status } = await call('GET', '/api/catalog/venues', { headers: { 'sec-fetch-site': site } });

    expect(status).toBe(403);
    expect(catalog.seen).toHaveLength(0);
  });

  it('a same-origin JSON POST is forwarded with the token', async () => {
    const { status } = await call('POST', '/api/prospector/surveys/pause',
      json({ venue: 'okx' }, { origin: `http://127.0.0.1:${uiPort}`, 'sec-fetch-site': 'same-origin' }));

    expect(status).toBe(200);
    expect(prospector.seen[0]).toMatchObject({ body: '{"venue":"okx"}', headers: { 'x-catalog-token': 'sekret' } });
  });

  it('a request typed into the address bar is forwarded', async () => {
    const { status } = await call('GET', '/api/catalog/venues', { headers: { 'sec-fetch-site': 'none' } });

    expect(status).toBe(200);
  });

  it('any Host is served while no list is set', async () => {
    const { status } = await call('GET', '/api/catalog/venues', { headers: { host: 'evil.example' } });

    expect(status).toBe(200);
  });
});

describe('with CATALOG_UI_HOSTS set', () => {
  beforeEach(() => start({ allowedHosts: ['ui.local', 'other.local:9020'] }));

  it('refuses a Host not listed', async () => {
    const { status } = await call('GET', '/api/catalog/venues', { headers: { host: 'evil.example' } });

    expect(status).toBe(403);
    expect(catalog.seen).toHaveLength(0);
  });

  it.each(['ui.local', 'UI.local:9020', 'other.local:9020'])('serves %s', async host => {
    const { status } = await call('GET', '/api/catalog/venues', { headers: { host } });

    expect(status).toBe(200);
  });

  it('refuses a listed name on a port not listed for it', async () => {
    const { status } = await call('GET', '/api/catalog/venues', { headers: { host: 'other.local:1' } });

    expect(status).toBe(403);
  });
});

describe('what comes back', () => {
  beforeEach(() => start({}, {
    '/lenses/missing': (_req, res) => {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain');
      res.end('Cannot PUT /lenses/missing');
    },
    '/venues/binary': (_req, res) => {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    },
    '/lenses/refused': (_req, res) => {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end('{"problems":[{"at":"x"}]}');
    },
    '/lenses/gone': (_req, res) => {
      res.statusCode = 204;
      res.end();
    },
    '/venues/moved': (_req, res) => {
      res.statusCode = 308;
      res.setHeader('location', '/venues/elsewhere');
      res.end();
    },
  }));

  it('keeps the status, the content type and the body of a non-JSON answer', async () => {
    const { status, headers, body } = await call('PUT', '/api/catalog/lenses/missing', json({}));

    expect(status).toBe(404);
    expect(headers['content-type']).toBe('text/plain');
    expect(body.toString()).toBe('Cannot PUT /lenses/missing');
  });

  it('keeps binary bytes as they are', async () => {
    const { headers, body } = await call('GET', '/api/catalog/venues/binary');

    expect(headers['content-type']).toBe('application/octet-stream');
    expect([...body]).toEqual([0xff, 0xfe, 0x00, 0x41]);
  });

  it('passes a refusal through', async () => {
    const { status, body } = await call('PUT', '/api/catalog/lenses/refused', json({}));

    expect(status).toBe(400);
    expect(JSON.parse(body.toString())).toEqual({ problems: [{ at: 'x' }] });
  });

  it('passes an empty 204 through', async () => {
    const { status, body } = await call('DELETE', '/api/catalog/lenses/gone');

    expect(status).toBe(204);
    expect(body).toHaveLength(0);
  });

  it('relays a redirect with its Location rather than following it', async () => {
    const { status, headers } = await call('GET', '/api/catalog/venues/moved');

    expect(status).toBe(308);
    expect(headers.location).toBe('/venues/elsewhere');
    expect(catalog.seen.map(one => one.url)).toEqual(['/venues/moved']);
  });
});

describe('when upstream is away, slow or abandoned', () => {
  it('answers 502 where upstream cannot be reached', async () => {
    const dead = createServer();
    const port = await listen(dead);

    await close(dead);
    await start({ catalogApi: `http://127.0.0.1:${port}` });

    const { status } = await call('GET', '/api/catalog/venues');

    expect(status).toBe(502);
  });

  it('answers 504 where upstream does not answer in time', async () => {
    await start({ upstreamTimeoutMs: 200 }, { '/venues': () => undefined });

    const { status, body } = await call('GET', '/api/catalog/venues');

    expect(status).toBe(504);
    expect(JSON.parse(body.toString()).error).toMatch(/No answer from the catalog/);
  });

  it('closes the upstream request when the client goes away', async () => {
    let closed: (at: number) => void = () => undefined;

    const upstreamClosed = new Promise<number>(resolve => { closed = resolve; });
    let answered = false;

    await start({}, {
      '/venues': (req, res) => {
        req.socket.on('close', () => closed(Date.now()));
        setTimeout(() => {
          if (res.destroyed) return;

          answered = true;
          res.end('{}');
        }, 1_000);
      },
    });

    const began  = Date.now();
    const client = request({ host: '127.0.0.1', port: uiPort, path: '/api/catalog/venues' });

    client.on('error', () => undefined);
    client.end();
    setTimeout(() => client.destroy(), 100);

    const at = await upstreamClosed;

    expect(at - began).toBeLessThan(1_000);
    expect(answered).toBe(false);
  });
});
