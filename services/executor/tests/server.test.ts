import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { startServer } from '../src/server';
import type { WsPool } from '../src/ws';
import type { RestClient } from '../src/rest';
import type { Config, LiveOrder } from '../src/types';

const CONFIG: Config = {
  bouncerUrl:   'http://bouncer',
  bouncerToken: 'test-token',
  httpPort:     3001,
};

function makeLive(overrides: Partial<LiveOrder> = {}): LiveOrder {
  return {
    orderID:   'oid-1',
    clOrdID:   'tb_XBTUSD_000001',
    symbol:    'XBTUSD',
    side:      'Buy',
    ordType:   'Limit',
    ordStatus: 'New',
    price:     50000,
    leavesQty: 100,
    cumQty:    0,
    ...overrides,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeWs(overrides: Partial<{ isReady: boolean; orders: LiveOrder[] }> = {}): WsPool {
  const state = {
    isReady:   () => overrides.isReady ?? true,
    getOrders: () => overrides.orders ?? [],
    close:     vi.fn(),
  };

  return {
    getOrCreate: vi.fn().mockResolvedValue(state),
    closeAll:    vi.fn(),
  };
}

function makeRest(): RestClient & {
  createOrder:  ReturnType<typeof vi.fn>;
  amendOrder:   ReturnType<typeof vi.fn>;
  cancelOrders: ReturnType<typeof vi.fn>;
} {
  return {
    createOrder:  vi.fn().mockResolvedValue({}),
    amendOrder:   vi.fn().mockResolvedValue({}),
    cancelOrders: vi.fn().mockResolvedValue({}),
  };
}

async function listen(ws: WsPool, rest: RestClient): Promise<{ server: http.Server; baseUrl: string }> {
  const server = startServer(ws, rest, { ...CONFIG, httpPort: 0 });

  await new Promise<void>((resolve) => {
    server.once('listening', resolve);
  });

  const addr    = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return { server, baseUrl };
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function plan(path: string, body: unknown, baseUrl: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
}

const VALID_PLAN = {
  accountId: 'acc-1',
  symbol:    'XBTUSD',
  orders:    [{ side: 'Buy', ordType: 'Limit', orderQty: 100, price: 50000 }],
  timestamp: '2026-01-01T00:00:00.000Z',
};

// ── Validation ────────────────────────────────────────────────────────────────

describe('POST /plan — validation', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await listen(makeWs(), makeRest()));
  });

  afterAll(() => close(server));

  it('returns 400 when accountId is missing', async () => {
    const { accountId: _, ...body } = VALID_PLAN;
    const res = await plan('/plan', body, baseUrl);

    expect(res.status).toBe(400);
  });

  it('returns 400 when symbol is missing', async () => {
    const res = await plan('/plan', { ...VALID_PLAN, symbol: '' }, baseUrl);

    expect(res.status).toBe(400);
  });

  it('returns 400 when orders is not an array', async () => {
    const res = await plan('/plan', { ...VALID_PLAN, orders: null }, baseUrl);

    expect(res.status).toBe(400);
  });

  it('returns 400 when order side is invalid', async () => {
    const res = await plan('/plan', {
      ...VALID_PLAN,
      orders: [{ side: 'Invalid', ordType: 'Limit' }],
    }, baseUrl);

    expect(res.status).toBe(400);
  });

  it('returns 400 when ordType is invalid', async () => {
    const res = await plan('/plan', {
      ...VALID_PLAN,
      orders: [{ side: 'Buy', ordType: 'Unknown' }],
    }, baseUrl);

    expect(res.status).toBe(400);
  });

  it('returns 400 when timestamp is missing', async () => {
    const { timestamp: _, ...body } = VALID_PLAN;
    const res = await plan('/plan', body, baseUrl);

    expect(res.status).toBe(400);
  });

  it('error body has an error string', async () => {
    const res  = await plan('/plan', {}, baseUrl);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(typeof body['error']).toBe('string');
  });
});

// ── WS not ready ──────────────────────────────────────────────────────────────

describe('POST /plan — WS not ready', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await listen(makeWs({ isReady: false }), makeRest()));
  });

  afterAll(() => close(server));

  it('returns 503 when WS order state is not yet initialised', async () => {
    const res = await plan('/plan', VALID_PLAN, baseUrl);

    expect(res.status).toBe(503);
  });
});

// ── WS connection failure ─────────────────────────────────────────────────────

describe('POST /plan — WS connection failure', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const ws: WsPool = {
      getOrCreate: vi.fn().mockRejectedValue(new Error('Bouncer returned 404')),
      closeAll:    vi.fn(),
    };

    ({ server, baseUrl } = await listen(ws, makeRest()));
  });

  afterAll(() => close(server));

  it('returns 500 when getOrCreate throws', async () => {
    const res = await plan('/plan', VALID_PLAN, baseUrl);

    expect(res.status).toBe(500);
  });
});

// ── Create ────────────────────────────────────────────────────────────────────

describe('POST /plan — creates', () => {
  let server: http.Server;
  let baseUrl: string;
  let rest: ReturnType<typeof makeRest>;

  beforeAll(async () => {
    rest = makeRest();
    ({ server, baseUrl } = await listen(makeWs({ orders: [] }), rest));
  });

  afterAll(() => close(server));

  it('creates all desired orders when live is empty', async () => {
    const body = {
      ...VALID_PLAN,
      orders: [
        { side: 'Buy',  ordType: 'Limit', orderQty: 100, price: 50000 },
        { side: 'Sell', ordType: 'Limit', orderQty: 100, price: 50010 },
      ],
    };

    const res  = await plan('/plan', body, baseUrl);
    const json = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(rest.createOrder).toHaveBeenCalledTimes(2);
    expect(json['creates']).toBe(2);
    expect(json['amends']).toBe(0);
    expect(json['cancels']).toBe(0);
  });
});

// ── Amend ─────────────────────────────────────────────────────────────────────

describe('POST /plan — amends', () => {
  let server: http.Server;
  let baseUrl: string;
  let rest: ReturnType<typeof makeRest>;

  beforeAll(async () => {
    rest = makeRest();
    const liveOrders = [
      makeLive({ orderID: 'oid-1', price: 50000, leavesQty: 100 }),
    ];

    ({ server, baseUrl } = await listen(makeWs({ orders: liveOrders }), rest));
  });

  afterAll(() => close(server));

  it('amends when price change exceeds threshold', async () => {
    const body = {
      ...VALID_PLAN,
      orders:         [{ side: 'Buy', ordType: 'Limit', orderQty: 100, price: 50005 }],
      amendThreshold: 1,
    };

    const res  = await plan('/plan', body, baseUrl);
    const json = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(rest.amendOrder).toHaveBeenCalledOnce();
    expect(json['amends']).toBe(1);
    expect(json['creates']).toBe(0);
  });

  it('does not amend when price change is within threshold', async () => {
    rest.amendOrder.mockClear();

    const body = {
      ...VALID_PLAN,
      orders:         [{ side: 'Buy', ordType: 'Limit', orderQty: 100, price: 50000.1 }],
      amendThreshold: 1,
    };

    const res  = await plan('/plan', body, baseUrl);
    const json = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(rest.amendOrder).not.toHaveBeenCalled();
    expect(json['amends']).toBe(0);
  });
});

// ── Cancel ────────────────────────────────────────────────────────────────────

describe('POST /plan — cancels', () => {
  let server: http.Server;
  let baseUrl: string;
  let rest: ReturnType<typeof makeRest>;

  beforeAll(async () => {
    rest = makeRest();
    const liveOrders = [
      makeLive({ orderID: 'oid-1', price: 50000 }),
      makeLive({ orderID: 'oid-2', price: 49990, clOrdID: 'tb_XBTUSD_000002' }),
    ];

    ({ server, baseUrl } = await listen(makeWs({ orders: liveOrders }), rest));
  });

  afterAll(() => close(server));

  it('cancels excess live orders when desired list is shorter', async () => {
    const body = { ...VALID_PLAN, orders: [] };
    const res  = await plan('/plan', body, baseUrl);
    const json = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(rest.cancelOrders).toHaveBeenCalledOnce();
    expect(json['cancels']).toBe(2);
    expect(json['creates']).toBe(0);
    expect(json['amends']).toBe(0);
  });
});

// ── Stale fallback ────────────────────────────────────────────────────────────

describe('POST /plan — stale fallback', () => {
  let server: http.Server;
  let baseUrl: string;
  let rest: ReturnType<typeof makeRest>;

  beforeAll(async () => {
    rest = makeRest();
    rest.amendOrder.mockResolvedValue({ stale: true });

    const liveOrders = [
      makeLive({ orderID: 'oid-1', price: 50000, leavesQty: 100 }),
    ];

    ({ server, baseUrl } = await listen(makeWs({ orders: liveOrders }), rest));
  });

  afterAll(() => close(server));

  it('creates a new order when amend returns stale', async () => {
    const body = {
      ...VALID_PLAN,
      orders: [{ side: 'Buy', ordType: 'Limit', orderQty: 100, price: 50005 }],
    };

    const res  = await plan('/plan', body, baseUrl);
    const json = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(rest.amendOrder).toHaveBeenCalledOnce();
    expect(rest.createOrder).toHaveBeenCalledOnce();
    expect(json['staleFallback']).toBe(1);
    expect(json['creates']).toBe(1);
    expect(json['amends']).toBe(0);
  });
});

// ── Response shape ────────────────────────────────────────────────────────────

describe('POST /plan — response shape', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await listen(makeWs({ orders: [] }), makeRest()));
  });

  afterAll(() => close(server));

  it('response includes accountId, symbol, and timestamp from plan', async () => {
    const res  = await plan('/plan', VALID_PLAN, baseUrl);
    const json = await res.json() as Record<string, unknown>;

    expect(json['accountId']).toBe(VALID_PLAN.accountId);
    expect(json['symbol']).toBe(VALID_PLAN.symbol);
    expect(json['timestamp']).toBe(VALID_PLAN.timestamp);
  });

  it('response always includes amends, creates, cancels, staleFallback', async () => {
    const res  = await plan('/plan', VALID_PLAN, baseUrl);
    const json = await res.json() as Record<string, unknown>;

    expect(typeof json['amends']).toBe('number');
    expect(typeof json['creates']).toBe('number');
    expect(typeof json['cancels']).toBe('number');
    expect(typeof json['staleFallback']).toBe('number');
  });
});
