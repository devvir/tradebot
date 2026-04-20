/**
 * Conformance tests — WS server protocol behaviour against an in-process server
 * with an in-memory snapshots instance primed from BitMEX-shaped fixtures.
 * No external services required.
 *
 * Reference: docs/BitMEX/WS_TABLES.md, docs/services/WS_DEVIATIONS.md
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server as HttpServer }                 from 'node:http';
import { WebSocket, type WebSocketServer }           from 'ws';
import { createBus }                                 from '../src/events';
import { ClientRegistry }                            from '../src/subs/clients';
import { createServer }                              from '../src/server/websocket';
import { setup }                                     from '../src/subs/subscription';
import { createSnapshots }                           from '../src/subs/snapshots';
import {
  primeSnapshots,
  startBroadcastRejector,
  stopServer,
  listen,
  closeWss,
  type SnapshotFixture,
} from './helpers';
import { snapshotStore } from './fixtures';

// ── Shared server setup ───────────────────────────────────────────────────────

let wss:              WebSocketServer;
let wssPort:          number;
let broadcastServer:  HttpServer;

beforeAll(async () => {
  const bus       = createBus();
  const registry  = new ClientRegistry();
  const snapshots = createSnapshots();

  primeSnapshots(snapshots, snapshotStore as Record<string, SnapshotFixture>);

  // Unknown tables (not primed) trigger a broadcast "resubscribe" signal. A
  // rejector that always returns 400 maps any unknown table straight to an
  // `Unknown table` client error, matching the conformance expectations.
  const { server, url } = await startBroadcastRejector();
  broadcastServer = server;

  wss     = createServer(bus, registry, 0);
  setup(bus, { broadcastUrl: url }, registry, snapshots);
  wssPort = await listen(wss);
});

afterAll(async () => {
  await closeWss(wss);
  await stopServer(broadcastServer);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

interface Client {
  ws:    WebSocket;
  msgs:  unknown[];
  next:  (timeout?: number) => Promise<unknown>;
  send:  (m: unknown) => void;
  close: () => void;
}

function makeClient(apiKey?: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const buf: unknown[]   = [];
    const waiters: Array<(m: unknown) => void> = [];

    const push = (m: unknown) => {
      if (waiters.length) { waiters.shift()!(m); }
      else                { buf.push(m); }
    };

    const next = (timeout = 2000): Promise<unknown> =>
      new Promise((res, rej) => {
        if (buf.length) return res(buf.shift());
        const t = setTimeout(() => {
          const i = waiters.indexOf(res);
          if (i !== -1) waiters.splice(i, 1);
          rej(new Error('timeout'));
        }, timeout);
        waiters.push((m) => { clearTimeout(t); res(m); });
      });

    const url = apiKey
      ? `ws://localhost:${wssPort}?api-key=${encodeURIComponent(apiKey)}`
      : `ws://localhost:${wssPort}`;

    const ws = new WebSocket(url);

    ws.on('message', (raw) => {
      try { push(JSON.parse(raw.toString())); }
      catch { push(raw.toString()); }
    });

    ws.on('open',  () => resolve({ ws, msgs: buf, next, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() }));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 1000);
  });
}

async function collectUntil(
  client: Client,
  pred:   (msgs: unknown[]) => boolean,
  timeout = 2000,
): Promise<unknown[]> {
  const msgs: unknown[] = [];
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      const m = await client.next(Math.max(100, deadline - Date.now()));
      msgs.push(m);
      if (pred(msgs)) break;
    } catch { break; }
  }

  return msgs;
}

type Msg = Record<string, unknown>;

const isAck     = (m: unknown): m is Msg => typeof m === 'object' && m !== null && (m as Msg).success === true && 'subscribe' in (m as Msg);
const isPartial = (m: unknown): m is Msg => typeof m === 'object' && m !== null && (m as Msg).action === 'partial';
const isError   = (m: unknown): m is Msg => typeof m === 'object' && m !== null && typeof (m as Msg).status === 'number' && (m as Msg).status >= 400;

// ── Welcome ───────────────────────────────────────────────────────────────────

describe('welcome message', () => {
  it('contains required fields', async () => {
    const c = await makeClient();
    const w = await c.next() as Msg;
    c.close();

    expect(w).toHaveProperty('info', 'Welcome to the BitMEX Realtime API.');
    expect(w).toHaveProperty('version');
    expect(w).toHaveProperty('timestamp');
    expect(w).toHaveProperty('docs');
    expect(w).toHaveProperty('heartbeatEnabled', false);
    expect(w).toHaveProperty('limit');
    expect(w).toHaveProperty('appName', 'TradeBOT');
  });

  it('limit has remaining field', async () => {
    const c = await makeClient();
    const w = await c.next() as Msg;
    c.close();

    expect(w.limit).toHaveProperty('remaining');
    expect(typeof (w.limit as Msg).remaining).toBe('number');
  });

  it('timestamp is ISO 8601', async () => {
    const c = await makeClient();
    const w = await c.next() as Msg;
    c.close();

    expect(typeof w.timestamp).toBe('string');
    expect(() => new Date(w.timestamp as string)).not.toThrow();
    expect(new Date(w.timestamp as string).toISOString()).toBe(w.timestamp);
  });
});

// ── ping/pong ─────────────────────────────────────────────────────────────────

describe('ping/pong', () => {
  it('responds to text ping with text pong', async () => {
    const c = await makeClient();
    await c.next(); // welcome

    c.ws.send('ping');
    const r = await c.next();
    c.close();

    expect(r).toBe('pong');
  });
});

// ── Protocol error handling ───────────────────────────────────────────────────

describe('protocol error handling', () => {
  it('invalid JSON → 400 with empty request echo', async () => {
    const c = await makeClient();
    await c.next(); // welcome

    c.ws.send('not json');
    const r = await c.next() as Msg;
    c.close();

    expect(r.status).toBe(400);
    expect(r.request).toEqual({});
    expect(typeof r.error).toBe('string');
  });

  it('valid JSON no op with unknown keys → 400, request echoes only known fields', async () => {
    const c = await makeClient();
    await c.next();

    c.send({ foo: 'bar' });
    const r = await c.next() as Msg;
    c.close();

    expect(r.status).toBe(400);
    expect(r.request).toEqual({});
  });

  it('valid JSON no op with args → 400, request echoes args', async () => {
    const c = await makeClient();
    await c.next();

    c.send({ args: ['x'] });
    const r = await c.next() as Msg;
    c.close();

    expect(r.status).toBe(400);
    expect(r.request).toEqual({ args: ['x'] });
  });

  it('unknown op → 400, op replaced with UNKNOWN in echo', async () => {
    const c = await makeClient();
    await c.next();

    c.send({ op: 'foobar', args: ['x'] });
    const r = await c.next() as Msg;
    c.close();

    expect(r.status).toBe(400);
    expect((r.request as Msg).op).toBe('UNKNOWN');
    expect((r.request as Msg).args).toEqual(['x']);
  });

  it('subscribe with no args → silent (no response)', async () => {
    const c = await makeClient();
    await c.next();

    c.send({ op: 'subscribe' });
    const r = await c.next(500).catch(() => 'SILENT');
    c.close();

    expect(r).toBe('SILENT');
  });

  it('subscribe with null args → silent', async () => {
    const c = await makeClient();
    await c.next();

    c.send({ op: 'subscribe', args: null });
    const r = await c.next(500).catch(() => 'SILENT');
    c.close();

    expect(r).toBe('SILENT');
  });

  it('subscribe with empty array args → silent', async () => {
    const c = await makeClient();
    await c.next();

    c.send({ op: 'subscribe', args: [] });
    const r = await c.next(500).catch(() => 'SILENT');
    c.close();

    expect(r).toBe('SILENT');
  });
});

// ── Subscribe / unsubscribe ───────────────────────────────────────────────────

describe('subscribe / unsubscribe mechanics', () => {
  it('string args treated as single-item array', async () => {
    const c = await makeClient();
    await c.next();

    c.send({ op: 'subscribe', args: 'trade:XBTUSD' });
    const msgs = await collectUntil(c, ms => ms.some(isAck));
    const ack = msgs.find(isAck) as Msg;
    c.close();

    expect(ack.subscribe).toBe('trade:XBTUSD');
    expect((ack.request as Msg).args).toBe('trade:XBTUSD');
  });

  it('subscribe to unknown table → ack then 400 unknown table', async () => {
    const c = await makeClient();
    await c.next();

    c.send({ op: 'subscribe', args: ['bogusTable'] });
    const msgs = await collectUntil(c, ms => ms.some(isError));
    const err  = msgs.find(isError) as Msg;
    c.close();

    expect(err.status).toBe(400);
    expect(err.error as string).toMatch(/Unknown table.*bogusTable/);
    expect((err.request as Msg).op).toBe('subscribe');
  });

  it('unsubscribe when not subscribed → success ack', async () => {
    const c = await makeClient();
    await c.next();

    c.send({ op: 'unsubscribe', args: ['trade:XBTUSD'] });
    const r = await c.next() as Msg;
    c.close();

    expect(r.success).toBe(true);
    expect(r.unsubscribe).toBe('trade:XBTUSD');
    expect((r.request as Msg).op).toBe('unsubscribe');
    expect((r.request as Msg).args).toEqual(['trade:XBTUSD']);
  });

  it('duplicate subscribe with symbol → ack echoes original arg (no :_ suffix)', async () => {
    const c = await makeClient();
    await c.next();

    c.send({ op: 'subscribe', args: ['trade:XBTUSD'] });
    await collectUntil(c, ms => ms.some(isPartial));

    c.send({ op: 'subscribe', args: ['trade:XBTUSD'] });
    const r = await c.next() as Msg;
    c.close();

    expect(r.status).toBe(400);
    expect(r.error as string).toMatch(/already subscribed.*trade:XBTUSD/);
    expect(r.error as string).not.toContain(':_');
  });

  it('duplicate subscribe without symbol → error does not leak :_ sentinel', async () => {
    const c = await makeClient();
    await c.next();

    c.send({ op: 'subscribe', args: ['trade'] });
    await collectUntil(c, ms => ms.some(isPartial));

    c.send({ op: 'subscribe', args: ['trade'] });
    const r = await c.next() as Msg;
    c.close();

    expect(r.status).toBe(400);
    expect(r.error as string).toMatch(/already subscribed.*trade/);
    expect(r.error as string).not.toContain(':_');
  });
});

// ── Partial message format ────────────────────────────────────────────────────

describe('partial message format', () => {
  it('partial has action: "partial"', async () => {
    const c = await makeClient();
    await c.next();

    c.send({ op: 'subscribe', args: ['trade:XBTUSD'] });
    const msgs    = await collectUntil(c, ms => ms.some(isPartial));
    const partial = msgs.find(isPartial) as Msg;
    c.close();

    expect(partial.action).toBe('partial');
  });

  it('partial does not contain counter field', async () => {
    const c = await makeClient();
    await c.next();

    c.send({ op: 'subscribe', args: ['trade:XBTUSD'] });
    const msgs    = await collectUntil(c, ms => ms.some(isPartial));
    const partial = msgs.find(isPartial) as Msg;
    c.close();

    expect(partial).not.toHaveProperty('counter');
  });

  it('partial has table, keys, types, data, filter fields', async () => {
    const c = await makeClient();
    await c.next();

    c.send({ op: 'subscribe', args: ['trade:XBTUSD'] });
    const msgs    = await collectUntil(c, ms => ms.some(isPartial));
    const partial = msgs.find(isPartial) as Msg;
    c.close();

    expect(partial).toHaveProperty('table', 'trade');
    expect(partial).toHaveProperty('keys');
    expect(partial).toHaveProperty('types');
    expect(partial).toHaveProperty('data');
    expect(partial).toHaveProperty('filter');
    expect(Array.isArray(partial.keys)).toBe(true);
    expect(Array.isArray(partial.data)).toBe(true);
  });

  it('partial filter is {} when subscribed without symbol', async () => {
    const c = await makeClient();
    await c.next();

    c.send({ op: 'subscribe', args: ['trade'] });
    const msgs    = await collectUntil(c, ms => ms.some(isPartial));
    const partial = msgs.find(isPartial) as Msg;
    c.close();

    expect(partial?.filter).toEqual({});
  });

  it('partial filter includes symbol when subscribed with symbol', async () => {
    const c = await makeClient();
    await c.next();

    c.send({ op: 'subscribe', args: ['trade:XBTUSD'] });
    const msgs    = await collectUntil(c, ms => ms.some(isPartial));
    const partial = msgs.find(isPartial) as Msg;
    c.close();

    expect((partial?.filter as Msg)?.symbol).toBe('XBTUSD');
  });
});

// ── Table availability ────────────────────────────────────────────────────────

const AVAILABLE_PUBLIC_TABLES = [
  'orderBook10',
  'orderBookL2_25',
  'orderBookL2',
  'quote',
  'quoteBin1m', 'quoteBin5m', 'quoteBin1h', 'quoteBin1d',
  'trade',
  'tradeBin1m', 'tradeBin5m', 'tradeBin1h', 'tradeBin1d',
  'liquidation',
  'instrument',
  'funding',
  'settlement',
  'insurance',
  'announcement',
  'chat',
  'connected',
  'publicNotifications',
];

describe('table availability — available tables', () => {
  for (const table of AVAILABLE_PUBLIC_TABLES) {
    it(`${table} is subscribable and returns a partial`, async () => {
      const c = await makeClient();
      await c.next();

      c.send({ op: 'subscribe', args: [table] });
      const msgs = await collectUntil(c, ms => ms.some(isPartial) || ms.some(isError));
      c.close();

      const partial = msgs.find(isPartial) as Msg | undefined;
      const err     = msgs.find(isError);

      expect(err,     `unexpected error for ${table}: ${JSON.stringify(err)}`).toBeUndefined();
      expect(partial, `no partial received for ${table}`).toBeDefined();
      expect(partial?.action).toBe('partial');
      expect(partial?.table).toBe(table);
      expect(partial).not.toHaveProperty('counter');
    });
  }
});

// ── Symbol filter behaviour ───────────────────────────────────────────────────

const SYMBOL_OPTIONAL_TABLES = [
  'orderBook10',
  'orderBookL2_25',
  'orderBookL2',
  'quote',
  'quoteBin1m', 'quoteBin5m', 'quoteBin1h', 'quoteBin1d',
  'trade',
  'tradeBin1m', 'tradeBin5m', 'tradeBin1h', 'tradeBin1d',
  'liquidation',
  'instrument',
  'funding',
  'settlement',
];

const SYMBOL_NA_TABLES = [
  'insurance',
  'announcement',
  'chat',
  'connected',
  'publicNotifications',
];

describe('symbol filter — optional tables return {symbol} in partial filter', () => {
  for (const table of SYMBOL_OPTIONAL_TABLES) {
    it(`${table}:XBTUSD partial filter contains symbol`, async () => {
      const c = await makeClient();
      await c.next();

      c.send({ op: 'subscribe', args: [`${table}:XBTUSD`] });
      const msgs    = await collectUntil(c, ms => ms.some(isPartial) || ms.some(isError));
      const partial = msgs.find(isPartial) as Msg | undefined;
      c.close();

      expect(partial, `no partial for ${table}:XBTUSD`).toBeDefined();
      expect((partial?.filter as Msg)?.symbol).toBe('XBTUSD');
    });
  }
});

describe('symbol filter — N/A tables always return {} in partial filter', () => {
  for (const table of SYMBOL_NA_TABLES) {
    it(`${table} partial filter is always {}`, async () => {
      const c = await makeClient();
      await c.next();

      c.send({ op: 'subscribe', args: [table] });
      const msgs    = await collectUntil(c, ms => ms.some(isPartial) || ms.some(isError));
      const partial = msgs.find(isPartial) as Msg | undefined;
      c.close();

      expect(partial, `no partial for ${table}`).toBeDefined();
      expect(partial?.filter).toEqual({});
    });
  }
});

// ── Authentication ────────────────────────────────────────────────────────────

const PRIVATE_TABLES = ['execution', 'order', 'position', 'margin', 'wallet', 'transact', 'affiliate'];

describe('authentication', () => {
  it('?api-key= in URL sets account identity', async () => {
    const c = await makeClient('test-account');
    await c.next(); // welcome

    c.send({ op: 'subscribe', args: ['order'] });
    const msgs    = await collectUntil(c, ms => ms.some(isPartial));
    const partial = msgs.find(isPartial) as Msg | undefined;
    c.close();

    expect((partial?.filter as Msg)?.account).toBe('test-account');
  });

  it('unknown op is still 400 after connecting with apiKey', async () => {
    const c = await makeClient('test-account');
    await c.next();

    c.send({ op: 'foobar' });
    const r = await c.next() as Msg;
    c.close();

    expect(r.status).toBe(400);
  });
});

// ── Private tables require auth ───────────────────────────────────────────────

describe('private tables — unauthenticated', () => {
  for (const table of PRIVATE_TABLES) {
    it(`${table} — unauthenticated subscribe returns 403`, async () => {
      const c = await makeClient();
      await c.next();

      c.send({ op: 'subscribe', args: [table] });
      const msgs = await collectUntil(c, ms => ms.some(isPartial) || ms.some(isError));
      c.close();

      expect(msgs.find(isPartial)).toBeUndefined();

      const err = msgs.find(isError) as Msg | undefined;
      expect(err, `expected error for ${table}`).toBeDefined();
      expect(err?.status).toBe(403);
    });
  }
});

describe('private tables — authenticated', () => {
  for (const table of PRIVATE_TABLES) {
    it(`${table} — authenticated subscribe returns partial`, async () => {
      const c = await makeClient('test-account');
      await c.next(); // welcome

      c.send({ op: 'subscribe', args: [table] });
      const msgs    = await collectUntil(c, ms => ms.some(isPartial) || ms.some(isError));
      const partial = msgs.find(isPartial) as Msg | undefined;
      c.close();

      expect(msgs.find(isError), `unexpected error for ${table}`).toBeUndefined();
      expect(partial, `no partial for ${table}`).toBeDefined();
      expect(partial?.action).toBe('partial');
      expect(partial?.table).toBe(table);
      expect(partial).not.toHaveProperty('counter');
    });
  }

  it('partial filter contains account', async () => {
    const c = await makeClient('test-account');
    await c.next();

    c.send({ op: 'subscribe', args: ['order'] });
    const msgs    = await collectUntil(c, ms => ms.some(isPartial));
    const partial = msgs.find(isPartial) as Msg | undefined;
    c.close();

    expect((partial?.filter as Msg)?.account).toBe('test-account');
  });

  it('order:XBTUSD — filter contains both account and symbol', async () => {
    const c = await makeClient('test-account');
    await c.next();

    c.send({ op: 'subscribe', args: ['order:XBTUSD'] });
    const msgs    = await collectUntil(c, ms => ms.some(isPartial));
    const partial = msgs.find(isPartial) as Msg | undefined;
    c.close();

    expect((partial?.filter as Msg)?.account).toBe('test-account');
    expect((partial?.filter as Msg)?.symbol).toBe('XBTUSD');
  });

  it('margin — filter contains account only (no symbol field)', async () => {
    const c = await makeClient('test-account');
    await c.next();

    c.send({ op: 'subscribe', args: ['margin'] });
    const msgs    = await collectUntil(c, ms => ms.some(isPartial));
    const partial = msgs.find(isPartial) as Msg | undefined;
    c.close();

    expect((partial?.filter as Msg)?.account).toBe('test-account');
    expect((partial?.filter as Msg)?.symbol).toBeUndefined();
  });
});
