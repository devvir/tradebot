import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/server/server';
import { MockedService } from './mocks';

describe('REST API', () => {
  let server: Server;
  let base: string;

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

  const get = (path: string) => fetch(`${base}${path}`);
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  describe('Public endpoints', () => {
    it('GET /instrument returns array', async () => {
      const res = await get('/instrument');
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    });

    it('GET /orderBook/L2 returns array', async () => {
      const res = await get('/orderBook/L2?symbol=XBTUSD');
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    });

    it('GET /trade returns array', async () => {
      const res = await get('/trade');
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    });

    it('GET /quote returns array', async () => {
      const res = await get('/quote');
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    });
  });

  describe('Query validation', () => {
    it('rejects invalid query parameters', async () => {
      const res = await get('/instrument?count=not-a-number');
      expect(res.status).toBe(400);
      expect((await res.json() as any).error).toBe('Invalid request');
    });

    it('accepts valid query parameters', async () => {
      const res = await get('/instrument?count=10&symbol=XBTUSD');
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    });
  });

  describe('Account endpoints (stubs)', () => {
    it('GET /position returns stub response', async () => {
      const res = await get('/position');
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    });

    it('GET /user/margin returns stub response', async () => {
      const res = await get('/user/margin');
      expect(res.status).toBe(200);
      expect(typeof (await res.json())).toBe('object');
    });
  });

  describe('Order endpoints (stubs)', () => {
    it('POST /order returns stub response', async () => {
      const res = await post('/order', {
        symbol: 'XBTUSD',
        side: 'Buy',
        orderQty: 100,
        price: 43000,
      });
      expect(res.status).toBe(200);
      expect(typeof (await res.json())).toBe('object');
    });
  });

  describe('404 handling', () => {
    it('returns 404 for unknown endpoints', async () => {
      const res = await get('/unknown/endpoint');
      expect(res.status).toBe(404);
      expect((await res.json() as any).error).toBe('Endpoint not found');
    });
  });
});
