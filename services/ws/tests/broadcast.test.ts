import { describe, it, expect } from 'vitest';
import { WebSocket } from 'ws';
import { createBus } from '../src/events';
import { ClientRegistry } from '../src/subs/clients';
import { createServer } from '../src/server/websocket';
import { setup } from '../src/subs/subscription';
import { processDelta } from '../src/subs/deltas';
import type { BitmexWsMessage } from '../src/types';
import { startSnapshotServer, stopServer, listen, closeWss, connect, waitFor } from './helpers';

const createTestService = (snapshotsUrl: string) => {
  const bus      = createBus();
  const registry = new ClientRegistry();
  const wss      = createServer(0, bus, registry);
  setup(bus, registry, snapshotsUrl);
  return { wss, push: (delta: BitmexWsMessage, counter: number, accountId?: string) => processDelta(delta, counter, bus, accountId) };
};

const makeMsg = (table: string, action: string): BitmexWsMessage => ({
  table,
  action,
  keys: ['id'],
  data: [{ id: 1 }],
});

const makeSnapshot = (table: string, counter: number) => ({
  table,
  action: 'partial',
  keys:   ['id'],
  data:   [{ id: 1 }],
  counter,
});

const partials = (messages: unknown[]): unknown[] =>
  messages.filter(m => (m as BitmexWsMessage).action === 'partial');

// ---- Tests -----------------------------------------------------------------

describe('live delta broadcast', () => {
  it('sends delta to active subscriber', async () => {
    const table           = 'trade_live';
    const snapshotCounter = 5;

    const { server, url } = await startSnapshotServer({ [table]: makeSnapshot(table, snapshotCounter) });
    const { wss, push }   = createTestService(url);

    push(makeMsg(table, 'insert'), 10);

    const port                 = await listen(wss);
    const { client, messages } = await connect(port);

    client.send(JSON.stringify({ op: 'subscribe', args: [table] }));
    await waitFor(messages, msgs => partials(msgs).length >= 1);

    // Live delta arrives — active subscriber should receive it
    push(makeMsg(table, 'update'), 15);

    await waitFor(messages, msgs =>
      msgs.some(m => (m as BitmexWsMessage).action === 'update'));

    const updates = messages.filter(m => (m as BitmexWsMessage).action === 'update');
    expect(updates).toHaveLength(1);
    expect((updates[0] as BitmexWsMessage).table).toBe(table);

    client.close();
    await closeWss(wss);
    await stopServer(server);
  });

  it('sends delta to multiple subscribers on same table', async () => {
    const table = 'trade_multi';

    const { server, url } = await startSnapshotServer({ [table]: makeSnapshot(table, 1) });
    const { wss, push }   = createTestService(url);

    push(makeMsg(table, 'insert'), 10);

    const port = await listen(wss);
    const { client: client1, messages: msgs1 } = await connect(port);
    const { client: client2, messages: msgs2 } = await connect(port);

    client1.send(JSON.stringify({ op: 'subscribe', args: [table] }));
    client2.send(JSON.stringify({ op: 'subscribe', args: [table] }));

    await waitFor(msgs1, m => partials(m).length >= 1);
    await waitFor(msgs2, m => partials(m).length >= 1);

    // Live delta — both should receive
    push(makeMsg(table, 'update'), 15);

    await waitFor(msgs1, m => m.some(x => (x as BitmexWsMessage).action === 'update'));
    await waitFor(msgs2, m => m.some(x => (x as BitmexWsMessage).action === 'update'));

    const updates1 = msgs1.filter(m => (m as BitmexWsMessage).action === 'update');
    const updates2 = msgs2.filter(m => (m as BitmexWsMessage).action === 'update');

    expect(updates1).toHaveLength(1);
    expect(updates2).toHaveLength(1);

    client1.close();
    client2.close();
    await closeWss(wss);
    await stopServer(server);
  });

  it('does not send delta to inactive (not subscribed) clients', async () => {
    const table1 = 'trade_sub1';
    const table2 = 'trade_unsub';

    const { server, url } = await startSnapshotServer({
      [table1]: makeSnapshot(table1, 1),
      [table2]: makeSnapshot(table2, 1),
    });
    const { wss, push } = createTestService(url);

    push(makeMsg(table1, 'insert'), 10);
    push(makeMsg(table2, 'insert'), 10);

    const port = await listen(wss);
    const { client: client1, messages: msgs1 } = await connect(port);
    const { client: client2, messages: msgs2 } = await connect(port);

    // client1 subscribes to table1 only
    client1.send(JSON.stringify({ op: 'subscribe', args: [table1] }));
    // client2 subscribes to table2 only
    client2.send(JSON.stringify({ op: 'subscribe', args: [table2] }));

    await waitFor(msgs1, m => partials(m).length >= 1);
    await waitFor(msgs2, m => partials(m).length >= 1);
    msgs1.splice(0);
    msgs2.splice(0);

    // Delta to table1 — only client1 should receive
    push(makeMsg(table1, 'update'), 15);

    await waitFor(msgs1, m => m.some(x => (x as BitmexWsMessage).action === 'update'));
    await new Promise(r => setTimeout(r, 100));

    expect(msgs1.some(m => (m as BitmexWsMessage).action === 'update')).toBe(true);
    expect(msgs2.some(m => (m as BitmexWsMessage).action === 'update')).toBe(false);

    client1.close();
    client2.close();
    await closeWss(wss);
    await stopServer(server);
  });

  it('sends deltas only to clients subscribed to that symbol', async () => {
    const table = 'orderBook_symbols';

    const { server, url } = await startSnapshotServer({ [table]: makeSnapshot(table, 1) });
    const { wss, push }   = createTestService(url);

    const port = await listen(wss);
    const { client: client1, messages: msgs1 } = await connect(port);
    const { client: client2, messages: msgs2 } = await connect(port);

    // client1 subscribes to XBTUSD, client2 to ETHUSD
    client1.send(JSON.stringify({ op: 'subscribe', args: [`${table}:XBTUSD`] }));
    client2.send(JSON.stringify({ op: 'subscribe', args: [`${table}:ETHUSD`] }));

    await waitFor(msgs1, m => partials(m).length >= 1);
    await waitFor(msgs2, m => partials(m).length >= 1);
    msgs1.splice(0);
    msgs2.splice(0);

    // Delta for XBTUSD — only client1 should receive
    const xbtUpdate: BitmexWsMessage = {
      table,
      action: 'update',
      keys: ['symbol'],
      data: [{ symbol: 'XBTUSD' }],
    };

    push(xbtUpdate, 10);

    await waitFor(msgs1, m => m.some(x => (x as BitmexWsMessage).action === 'update'));
    await new Promise(r => setTimeout(r, 100));

    expect(msgs1.some(m => (m as BitmexWsMessage).action === 'update')).toBe(true);
    expect(msgs2.some(m => (m as BitmexWsMessage).action === 'update')).toBe(false);

    client1.close();
    client2.close();
    await closeWss(wss);
    await stopServer(server);
  });

  it('allows multiple clients to subscribe to same symbol', async () => {
    const table = 'trade_same_symbol';

    const { server, url } = await startSnapshotServer({ [table]: makeSnapshot(table, 1) });
    const { wss, push }   = createTestService(url);

    const port = await listen(wss);
    const { client: client1, messages: msgs1 } = await connect(port);
    const { client: client2, messages: msgs2 } = await connect(port);

    // Both subscribe to same symbol
    client1.send(JSON.stringify({ op: 'subscribe', args: [`${table}:XBTUSD`] }));
    client2.send(JSON.stringify({ op: 'subscribe', args: [`${table}:XBTUSD`] }));

    await waitFor(msgs1, m => partials(m).length >= 1);
    await waitFor(msgs2, m => partials(m).length >= 1);
    msgs1.splice(0);
    msgs2.splice(0);

    // Delta arrives — both should receive
    const update: BitmexWsMessage = {
      table,
      action: 'update',
      keys: ['symbol'],
      data: [{ symbol: 'XBTUSD' }],
    };

    push(update, 10);

    await waitFor(msgs1, m => m.some(x => (x as BitmexWsMessage).action === 'update'));
    await waitFor(msgs2, m => m.some(x => (x as BitmexWsMessage).action === 'update'));

    expect(msgs1.filter(m => (m as BitmexWsMessage).action === 'update')).toHaveLength(1);
    expect(msgs2.filter(m => (m as BitmexWsMessage).action === 'update')).toHaveLength(1);

    client1.close();
    client2.close();
    await closeWss(wss);
    await stopServer(server);
  });
});

// ---- Private table routing ---------------------------------------------------

describe('private table delta routing', () => {
  const makePrivateSnapshot = (table: string, counter: number) => ({
    table,
    action:  'partial',
    keys:    ['id'],
    types:   { id: 'integer', account: 'long' },
    data:    [],
    counter,
  });

  it('delivers private deltas only to the matching account', async () => {
    const table = 'order';

    const { server, url } = await startSnapshotServer({ [table]: makePrivateSnapshot(table, 0) });
    const { wss, push }   = createTestService(url);

    const port = await listen(wss);
    const { client: clientA, messages: msgsA } = await connect(port, 'account-A');
    const { client: clientB, messages: msgsB } = await connect(port, 'account-B');

    clientA.send(JSON.stringify({ op: 'subscribe', args: [table] }));
    clientB.send(JSON.stringify({ op: 'subscribe', args: [table] }));

    await waitFor(msgsA, m => partials(m).length >= 1);
    await waitFor(msgsB, m => partials(m).length >= 1);
    msgsA.splice(0);
    msgsB.splice(0);

    // Delta tagged to account-A — only clientA should receive it
    push(makeMsg(table, 'update'), 10, 'account-A');

    await waitFor(msgsA, m => m.some(x => (x as BitmexWsMessage).action === 'update'));
    await new Promise(r => setTimeout(r, 150));

    expect(msgsA.some(m => (m as BitmexWsMessage).action === 'update')).toBe(true);
    expect(msgsB.some(m => (m as BitmexWsMessage).action === 'update')).toBe(false);

    clientA.close();
    clientB.close();
    await closeWss(wss);
    await stopServer(server);
  });
});
