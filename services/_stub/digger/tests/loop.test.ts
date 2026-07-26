import { describe, it, expect, beforeEach } from 'vitest';
import type { WsServerHandle } from '@devvir/service-kit';
import * as clock from '../src/core/clock';
import * as snapshot from '../src/core/snapshot';
import { Loop } from '../src/ws/loop';
import type { Reader } from '../src/reader';
import type { Pacer } from '../src/ws/pacer';
import type { StreamItem } from '../src/core/types';

const item = (ts: number): StreamItem =>
  ({ ts, msg: { table: 'trade', action: 'insert', data: [{ symbol: 'XBTUSD' }] } });

const makeSocket = () => ({ bufferedAmount: 0, readyState: 1, sent: [] as string[], send(d: string) { this.sent.push(d); } });

const server = (sock: ReturnType<typeof makeSocket>): WsServerHandle =>
  ({ clients: () => [{ id: 'a', socket: sock, data: { subs: new Set(['trade']) } }] } as unknown as WsServerHandle);

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

beforeEach(() => {
  clock._test_reset();
  snapshot._test_reset();
});

describe('Loop — batched drain', () => {
  it('drains queued messages to the subscribed client and advances the clock', async () => {
    const queue = [item(1000), item(1001), item(1002)];
    const reader = { anyActive: () => true, next: () => queue.shift() ?? null, refill: () => {} } as unknown as Reader;
    const pacer  = { mayEmit: () => true } as unknown as Pacer;
    const sock   = makeSocket();

    const loop = new Loop(server(sock), reader, pacer, 256);
    loop.start();
    await sleep(40);
    loop.stop();

    expect(sock.sent).toHaveLength(3);
    expect(clock.fetch()).toBe(1002);
  });

  it('emits nothing while the pacer is gated', async () => {
    const queue  = [item(1000)];
    const reader = { anyActive: () => true, next: () => queue.shift() ?? null, refill: () => {} } as unknown as Reader;
    const pacer  = { mayEmit: () => false } as unknown as Pacer;
    const sock   = makeSocket();

    const loop = new Loop(server(sock), reader, pacer, 256);
    loop.start();
    await sleep(20);
    loop.stop();

    expect(sock.sent).toHaveLength(0);
    expect(queue).toHaveLength(1);
  });

  it('idles (no crash) when nothing is active', async () => {
    const reader = { anyActive: () => false, next: () => null, refill: () => {} } as unknown as Reader;
    const pacer  = { mayEmit: () => true } as unknown as Pacer;
    const sock   = makeSocket();

    const loop = new Loop(server(sock), reader, pacer, 256);
    loop.start();
    await sleep(20);
    loop.stop();

    expect(sock.sent).toHaveLength(0);
  });
});
