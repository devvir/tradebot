import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer as createHttpServer, type Server, type IncomingMessage } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/server';
import { MockedService } from './mocks';

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Use node:http directly so global fetch mock only intercepts the server's outgoing calls
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

let base: string;

describe('REST API', () => {
  let server: Server;

  beforeAll(() => new Promise<void>(resolve => {
    const service = new MockedService();
    const app = createServer(service as any);
    server = createHttpServer(app);
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      base = `http://localhost:${port}`;
      resolve();
    });
  }));

  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  const mockFetch = () => fetch as ReturnType<typeof vi.fn>;
  const mockData  = (data: unknown, status = 200) => mockFetch().mockResolvedValueOnce(makeResponse(data, status));

  describe('Request forwarding', () => {
    it('forwards GET to data backend', async () => {
      mockData([{ symbol: 'XBTUSD' }]);
      const res = await request('GET', '/instrument');
      expect(res.status).toBe(200);
      expect(mockFetch()).toHaveBeenCalledOnce();
      const [url] = mockFetch().mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://test-data/instrument');
    });

    it('forwards query string to data backend', async () => {
      mockData([]);
      await request('GET', '/instrument?symbol=XBTUSD&count=10');
      const [url] = mockFetch().mock.calls[0] as [string, unknown];
      expect(url).toBe('http://test-data/instrument?symbol=XBTUSD&count=10');
    });

    it('passes data backend status through unchanged', async () => {
      mockData({ error: 'not found' }, 404);
      const res = await request('GET', '/order?clOrdID=unknown');
      expect(res.status).toBe(404);
    });

    it('passes all headers through to data backend', async () => {
      mockData({ result: 'ok' });
      await request('GET', '/order', { 'api-key': 'my-account', 'x-custom': 'value' });
      expect(mockFetch()).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch().mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
      expect(url).toBe('http://test-data/order');
      expect(opts.headers['api-key']).toBe('my-account');
      expect(opts.headers['x-custom']).toBe('value');
    });

    it('forwards without api-key when not provided', async () => {
      mockData([]);
      await request('GET', '/instrument');
      const [, opts] = mockFetch().mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
      expect(opts.headers['api-key']).toBeUndefined();
    });

    it('forwards POST body to data backend', async () => {
      mockData({ orderID: 'abc' });
      const body = JSON.stringify({ symbol: 'XBTUSD', side: 'Buy', orderQty: 100 });
      const res = await request('POST', '/order', { 'content-type': 'application/json' }, body);
      expect(res.status).toBe(200);
    });

    it('passes content-type header through to data backend', async () => {
      mockData([]);
      await request('GET', '/instrument', { 'content-type': 'application/json' });
      const [, opts] = mockFetch().mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
      expect(opts.headers['content-type']).toBe('application/json');
    });
  });
});

