import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer as createHttpServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { buildRouter } from '../src/routes';

// ── Mock data backend ─────────────────────────────────────────────────────────

let lastBackendRequest: {
  method: string;
  url:    string;
  headers: Record<string, string | string[] | undefined>;
  body:   string;
};

let backendHandler: (req: IncomingMessage, res: ServerResponse) => void;

function mockData(data: unknown, status = 200): void {
  backendHandler = (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };
}

// ── HTTP request helper ───────────────────────────────────────────────────────

function request(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url   = new URL(path, base);
    const allHeaders: Record<string, string> = { ...headers };
    if (body) allHeaders['content-length'] = String(Buffer.byteLength(body));

    const req = http.request({
      hostname: url.hostname,
      port:     Number(url.port),
      path:     url.pathname + url.search,
      method,
      headers:  allHeaders,
    }, (res: IncomingMessage) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body: data }));
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let base: string;
let server: Server;
let backendServer: Server;

beforeAll(() => new Promise<void>((resolve) => {
  // Start mock data backend first
  backendServer = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk; });
    req.on('end', () => {
      lastBackendRequest = {
        method:  req.method!,
        url:     req.url!,
        headers: req.headers,
        body,
      };
      backendHandler(req, res);
    });
  });

  backendServer.listen(0, () => {
    const backendPort = (backendServer.address() as AddressInfo).port;
    const dataUrl = `http://127.0.0.1:${backendPort}`;

    // Start REST server pointing at mock backend
    const app = express().use(buildRouter({ dataUrl }));
    server = createHttpServer(app);
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}));

afterAll(() => new Promise<void>((resolve) => {
  server.close(() => backendServer.close(() => resolve()));
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('REST API', () => {
  describe('Request forwarding', () => {
    it('forwards GET to data backend', async () => {
      mockData([{ symbol: 'XBTUSD' }]);
      const res = await request('GET', '/api/v1/instrument');
      expect(res.status).toBe(200);
      expect(lastBackendRequest.method).toBe('GET');
      expect(lastBackendRequest.url).toBe('/instrument');
    });

    it('forwards query string to data backend', async () => {
      mockData([]);
      await request('GET', '/api/v1/instrument?symbol=XBTUSD&count=10');
      expect(lastBackendRequest.url).toBe('/instrument?symbol=XBTUSD&count=10');
    });

    it('passes data backend status through unchanged', async () => {
      mockData({ error: 'not found' }, 404);
      const res = await request('GET', '/api/v1/order?clOrdID=unknown');
      expect(res.status).toBe(404);
    });

    it('passes all headers through to data backend', async () => {
      mockData({ result: 'ok' });
      await request('GET', '/api/v1/order', { 'api-key': 'my-account', 'x-custom': 'value' });
      expect(lastBackendRequest.url).toBe('/order');
      expect(lastBackendRequest.headers['api-key']).toBe('my-account');
      expect(lastBackendRequest.headers['x-custom']).toBe('value');
    });

    it('forwards without api-key when not provided', async () => {
      mockData([]);
      await request('GET', '/api/v1/instrument');
      expect(lastBackendRequest.headers['api-key']).toBeUndefined();
    });

    it('forwards POST body to data backend', async () => {
      mockData({ orderID: 'abc' });
      const body = JSON.stringify({ symbol: 'XBTUSD', side: 'Buy', orderQty: 100 });
      const res = await request('POST', '/api/v1/order', { 'content-type': 'application/json' }, body);
      expect(res.status).toBe(200);
      expect(lastBackendRequest.body).toBe(body);
    });

    it('passes content-type header through to data backend', async () => {
      mockData([]);
      await request('GET', '/api/v1/instrument', { 'content-type': 'application/json' });
      expect(lastBackendRequest.headers['content-type']).toBe('application/json');
    });
  });
});

