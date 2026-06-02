import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WsServerHandle, WsServerClient } from '@devvir/service-kit';
import * as clock from '../src/core/clock';
import { Pacer } from '../src/ws/pacer';
import { fanout } from '../src/ws/egress';
import { Hub } from '../src/ws/subscriptions';
import type { Reader } from '../src/reader';
import type { Config } from '../src/types';
import type { StreamItem, WsMessage } from '../src/core/types';

// ── Fakes ─────────────────────────────────────────────────────────────────────

const makeSocket = (bufferedAmount = 0) => ({
  bufferedAmount,
  readyState: 1,
  sent: [] as string[],
  send(d: string) { this.sent.push(d); },
});

const makeClient = (id: string, socket: ReturnType<typeof makeSocket>, channels: string[] = []): WsServerClient =>
  ({ id, socket, data: { subs: new Set(channels) } } as unknown as WsServerClient);

const makeServer = (clients: WsServerClient[]): WsServerHandle =>
  ({ clients: () => clients } as unknown as WsServerHandle);

const fakeReader = () => ({
  activate:   vi.fn(async (t: string) => ({ table: t, action: 'partial', data: [] } as WsMessage)),
  promote:    vi.fn(),
  deactivate: vi.fn(),
  partialFor: vi.fn((t: string) => ({ table: t, action: 'partial', data: [] } as WsMessage)),
});

// ── Pacer ─────────────────────────────────────────────────────────────────────

describe('Pacer — slowest-client hysteresis', () => {
  it('gates above high-water, stays gated until below low-water', () => {
    const sock   = makeSocket(0);
    const server = makeServer([makeClient('a', sock)]);
    const pacer  = new Pacer(server, { bpHigh: 100, bpLow: 50 } as Config);

    expect(pacer.mayEmit()).toBe(true);

    sock.bufferedAmount = 150; expect(pacer.mayEmit()).toBe(false);   // over high → gated
    sock.bufferedAmount = 75;  expect(pacer.mayEmit()).toBe(false);   // between → still gated
    sock.bufferedAmount = 40;  expect(pacer.mayEmit()).toBe(true);    // under low → released
  });

  it('paused mode never emits', () => {
    const pacer = new Pacer(makeServer([]), { bpHigh: 100, bpLow: 50 } as Config);
    pacer.mode = 'paused';
    expect(pacer.mayEmit()).toBe(false);
  });
});

// ── Egress ────────────────────────────────────────────────────────────────────

describe('egress — fan-out', () => {
  it('sends the full frame to bare subscribers and a symbol-filtered frame to scoped', () => {
    const full   = makeClient('full',   makeSocket(), ['trade']);
    const scoped = makeClient('scoped', makeSocket(), ['trade:XBTUSD']);
    const other  = makeClient('other',  makeSocket(), ['quote']);
    const server = makeServer([full, scoped, other]);

    const item: StreamItem = {
      ts: 1,
      msg: { table: 'trade', action: 'insert', data: [{ symbol: 'XBTUSD', p: 1 }, { symbol: 'ETHUSD', p: 2 }] },
    };

    fanout(server, item);

    expect(JSON.parse((full.socket as never as { sent: string[] }).sent[0]!).data).toHaveLength(2);
    expect(JSON.parse((scoped.socket as never as { sent: string[] }).sent[0]!).data).toEqual([{ symbol: 'XBTUSD', p: 1 }]);
    expect((other.socket as never as { sent: string[] }).sent).toHaveLength(0);
  });
});

// ── Hub ───────────────────────────────────────────────────────────────────────

describe('Hub — subscriptions', () => {
  beforeEach(() => clock._test_reset());

  it('cold subscribe activates, promotes, sends the partial, registers', async () => {
    clock.set(1000);
    const reader = fakeReader();
    const c = makeClient('a', makeSocket());
    const hub = new Hub(makeServer([c]), reader as unknown as Reader);

    await hub.subscribe(c, 'trade');

    expect(reader.activate).toHaveBeenCalledWith('trade', 1000);
    expect(reader.promote).toHaveBeenCalledWith('trade');
    expect((c.data.subs as Set<string>).has('trade')).toBe(true);
    expect((c.socket as never as { sent: string[] }).sent).toHaveLength(1);
  });

  it('a second subscriber is warm — no re-activation', async () => {
    clock.set(1000);
    const reader = fakeReader();
    const a = makeClient('a', makeSocket());
    const b = makeClient('b', makeSocket());
    const hub = new Hub(makeServer([a, b]), reader as unknown as Reader);

    await hub.subscribe(a, 'trade');
    await hub.subscribe(b, 'trade');

    expect(reader.activate).toHaveBeenCalledTimes(1);
    expect(reader.partialFor).toHaveBeenCalledWith('trade');
    expect((b.socket as never as { sent: string[] }).sent).toHaveLength(1);
  });

  it('ref-counts: deactivates only on the last unsubscribe', async () => {
    clock.set(1000);
    const reader = fakeReader();
    const a = makeClient('a', makeSocket());
    const b = makeClient('b', makeSocket());
    const hub = new Hub(makeServer([a, b]), reader as unknown as Reader);

    await hub.subscribe(a, 'trade');
    await hub.subscribe(b, 'trade');

    hub.unsubscribe(a, 'trade');
    expect(reader.deactivate).not.toHaveBeenCalled();

    hub.unsubscribe(b, 'trade');
    expect(reader.deactivate).toHaveBeenCalledWith('trade');
  });

  it('disconnect drops all of a client’s subscriptions', async () => {
    clock.set(1000);
    const reader = fakeReader();
    const c = makeClient('a', makeSocket());
    const hub = new Hub(makeServer([c]), reader as unknown as Reader);

    await hub.subscribe(c, 'trade');
    await hub.subscribe(c, 'quote');

    hub.disconnect(c);

    expect(reader.deactivate).toHaveBeenCalledWith('trade');
    expect(reader.deactivate).toHaveBeenCalledWith('quote');
    expect((c.data.subs as Set<string>).size).toBe(0);
  });

  it('errors when the clock is unset, without activating', async () => {
    const reader = fakeReader();
    const c = makeClient('a', makeSocket());
    const hub = new Hub(makeServer([c]), reader as unknown as Reader);

    await hub.subscribe(c, 'trade');

    expect(reader.activate).not.toHaveBeenCalled();
    expect(JSON.parse((c.socket as never as { sent: string[] }).sent[0]!).error).toContain('clock');
  });
});
