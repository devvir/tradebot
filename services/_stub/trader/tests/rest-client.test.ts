/**
 * REST client tests.
 *
 * Mocks the global `fetch` and asserts the high-level contract:
 *   - Every request carries BitMEX-compatible auth headers
 *   - Stale amends (404 / 400 "Not Found") return null instead of throwing
 *   - Bulk cancel encoding is correct for one ID vs many
 *   - getOrders falls back to [] on errors
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HttpRestClient } from '../src/rest';
import type { OrderPlan } from '../src/planner/types';

const BASE  = 'http://rest';
const CREDS = { apiKey: 'KEY', apiSecret: 'SECRET' };

const PLAN: OrderPlan = {
  symbol:   'XBTUSD',
  side:     'Buy',
  ordType:  'Limit',
  price:    50000,
  orderQty: 100,
};

function mockResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const status  = init.status ?? 200;
  const headers = new Headers({
    'content-type':          'application/json',
    'x-ratelimit-remaining': '999',
    ...init.headers,
  });

  const text = typeof body === 'string' ? body : JSON.stringify(body);

  return new Response(text, { status, headers });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createOrder', () => {
  it('POSTs to /api/v1/order with the body shape BitMEX expects', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ orderID: 'oid-1', clOrdID: 'tb_XBTUSD_000001' }));

    const client = new HttpRestClient(BASE, CREDS);
    await client.createOrder(PLAN, 'tb_XBTUSD_000001');

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]!;

    expect(url).toBe('http://rest/api/v1/order');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      symbol:   'XBTUSD',
      side:     'Buy',
      ordType:  'Limit',
      clOrdID:  'tb_XBTUSD_000001',
      orderQty: 100,
      price:    50000,
    });
  });

  it('signs every request with BitMEX-compatible headers', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ orderID: 'oid-1' }));

    const client = new HttpRestClient(BASE, CREDS);
    await client.createOrder(PLAN, 'tb_XBTUSD_000001');

    const [, init]    = fetchMock.mock.calls[0]!;
    const headers     = init.headers as Record<string, string>;

    expect(headers['api-key']).toBe('KEY');
    expect(headers['api-expires']).toMatch(/^\d+$/);
    expect(headers['api-signature']).toMatch(/^[a-f0-9]{64}$/);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('strips a trailing slash from the base URL', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ orderID: 'oid-1' }));

    const client = new HttpRestClient('http://rest/', CREDS);
    await client.createOrder(PLAN, 'tb_XBTUSD_000001');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://rest/api/v1/order');
  });
});

describe('amendOrder', () => {
  it('PUTs to /api/v1/order with orderID + amend fields', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ orderID: 'oid-1', price: 50100 }));

    const client = new HttpRestClient(BASE, CREDS);
    await client.amendOrder('oid-1', { price: 50100, leavesQty: 200 });

    const [url, init] = fetchMock.mock.calls[0]!;

    expect(url).toBe('http://rest/api/v1/order');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({
      orderID:   'oid-1',
      price:     50100,
      leavesQty: 200,
    });
  });

  it('returns null on 404 (order vanished)', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse('', { status: 404 }));

    const client = new HttpRestClient(BASE, CREDS);
    const result = await client.amendOrder('oid-1', { price: 50100 });

    expect(result).toBeNull();
  });

  it('returns null on 400 with "Not Found" body (BitMEX quirk)', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse('Order Not Found', { status: 400 }));

    const client = new HttpRestClient(BASE, CREDS);
    const result = await client.amendOrder('oid-1', { price: 50100 });

    expect(result).toBeNull();
  });

  it('returns null on a network error rather than throwing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connection refused'));

    const client = new HttpRestClient(BASE, CREDS);
    const result = await client.amendOrder('oid-1', { price: 50100 });

    expect(result).toBeNull();
  });

  it('returns the amended order on a 200', async () => {
    const amended = { orderID: 'oid-1', price: 50100, leavesQty: 100, ordStatus: 'New' };
    fetchMock.mockResolvedValueOnce(mockResponse(amended));

    const client = new HttpRestClient(BASE, CREDS);
    const result = await client.amendOrder('oid-1', { price: 50100 });

    expect(result?.price).toBe(50100);
  });
});

describe('cancelOrders', () => {
  it('sends a single ID as a string, not JSON-encoded', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse([{ orderID: 'oid-1' }]));

    const client = new HttpRestClient(BASE, CREDS);
    await client.cancelOrders(['oid-1']);

    const [, init] = fetchMock.mock.calls[0]!;

    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body)).toEqual({ orderID: 'oid-1' });
  });

  it('sends multiple IDs as a JSON-encoded array (BitMEX bulk cancel)', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse([]));

    const client = new HttpRestClient(BASE, CREDS);
    await client.cancelOrders(['oid-1', 'oid-2', 'oid-3']);

    const [, init] = fetchMock.mock.calls[0]!;
    const body     = JSON.parse(init.body);

    expect(body.orderID).toBe(JSON.stringify(['oid-1', 'oid-2', 'oid-3']));
  });

  it('is a no-op on an empty list', async () => {
    const client = new HttpRestClient(BASE, CREDS);
    await client.cancelOrders([]);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getOrders', () => {
  it('GETs /api/v1/order with the symbol filter', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse([{ orderID: 'oid-1', symbol: 'XBTUSD' }]));

    const client = new HttpRestClient(BASE, CREDS);
    const orders = await client.getOrders('XBTUSD');

    const [url, init] = fetchMock.mock.calls[0]!;

    expect(init.method).toBe('GET');
    expect(url).toContain('/api/v1/order');
    expect(url).toContain(encodeURIComponent(JSON.stringify({ symbol: 'XBTUSD' })));
    expect(orders).toHaveLength(1);
    expect(orders[0]?.orderID).toBe('oid-1');
  });

  it('returns [] when fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));

    const client = new HttpRestClient(BASE, CREDS);
    const orders = await client.getOrders('XBTUSD');

    expect(orders).toEqual([]);
  });

  it('returns [] when the response is non-2xx', async () => {
    fetchMock.mockResolvedValue(mockResponse('Server unavailable', { status: 503 }));

    const client = new HttpRestClient(BASE, CREDS);
    const orders = await client.getOrders('XBTUSD');

    expect(orders).toEqual([]);
  });
});
