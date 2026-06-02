import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Application } from 'express';
import request from 'supertest';
import * as clock from '../src/core/clock';
import { parseParams } from '../src/rest/params';
import { buildRestRouter } from '../src/rest/server';
import type { Provider } from '../src/provider';

beforeEach(() => clock._test_reset());

// ── params: the clock ceiling + depth ─────────────────────────────────────────

describe('parseParams', () => {
  it('caps a future endTime to the clock', () => {
    clock.set(2000);
    expect(parseParams({ endTime: '5000' }).endTime).toBe(2000);
  });

  it('defaults endTime to the clock when absent', () => {
    clock.set(2000);
    expect(parseParams({}).endTime).toBe(2000);
  });

  it('keeps an endTime at-or-before the clock', () => {
    clock.set(2000);
    expect(parseParams({ endTime: '1500' }).endTime).toBe(1500);
  });

  it('clamps count, parses depth/flags/columns', () => {
    clock.set(2000);
    const p = parseParams({ count: '999', depth: '10', reverse: 'true', columns: 'price, size', symbol: 'XBTUSD' });

    expect(p.count).toBe(500);
    expect(p.depth).toBe(10);
    expect(p.reverse).toBe(true);
    expect(p.columns).toEqual(['price', 'size']);
    expect(p.symbol).toBe('XBTUSD');
  });
});

// ── server: pure pass-through to the provider ─────────────────────────────────

const makeApp = (records = vi.fn(async () => [{ x: 1 }])) => {
  const provider = { records } as unknown as Provider;
  const app: Application = express().use(buildRestRouter(provider));

  return { app, records };
};

describe('REST server — pass-through', () => {
  beforeEach(() => clock.set(1_700_000_000_000));

  it('forwards /trade with resolved params (endTime = clock)', async () => {
    const { app, records } = makeApp();

    await request(app).get('/trade').query({ count: 3, symbol: 'XBTUSD' });

    expect(records).toHaveBeenCalledWith('trade',
      expect.objectContaining({ symbol: 'XBTUSD', count: 3, endTime: 1_700_000_000_000 }));
  });

  it('maps /trade/bucketed to the bin table', async () => {
    const { app, records } = makeApp();

    await request(app).get('/trade/bucketed').query({ binSize: '5m' });

    expect(records).toHaveBeenCalledWith('tradeBin5m', expect.anything());
  });

  it('rejects /orderBook/L2 without symbol', async () => {
    const { app, records } = makeApp();

    const res = await request(app).get('/orderBook/L2');

    expect(res.status).toBe(400);
    expect(records).not.toHaveBeenCalled();
  });

  it('forwards /orderBook/L2 with symbol + depth', async () => {
    const { app, records } = makeApp();

    await request(app).get('/orderBook/L2').query({ symbol: 'XBTUSD', depth: 10 });

    expect(records).toHaveBeenCalledWith('orderBookL2',
      expect.objectContaining({ symbol: 'XBTUSD', depth: 10 }));
  });

  it('400 on an invalid binSize', async () => {
    const { app } = makeApp();

    expect((await request(app).get('/trade/bucketed').query({ binSize: '2m' })).status).toBe(400);
  });

  it('500 when the provider throws', async () => {
    const { app } = makeApp(vi.fn(async () => { throw new Error('provider down'); }));

    const res = await request(app).get('/trade');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('provider down');
  });
});
