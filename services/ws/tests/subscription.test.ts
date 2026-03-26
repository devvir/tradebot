import { describe, it, expect } from 'vitest';
import { createBus } from '../src/events';
import { ClientRegistry } from '../src/subs/clients';
import { createServer } from '../src/server/websocket';
import { setup } from '../src/subs/subscription';
import { processDelta } from '../src/subs/deltas';
import type { BitmexWsMessage } from '../src/types';
import { testHelpers } from './helpers';

const { startSnapshotServer, stopServer, listen, closeWss, connect, waitFor } = testHelpers;

const createTestService = (snapshotsUrl: string) => {
  const bus      = createBus();
  const registry = new ClientRegistry();
  const wss      = createServer(bus, registry);
  setup(bus, { snapshotsUrl, broadcastUrl: '' }, registry);
  return { wss, bus, registry, push: (delta: BitmexWsMessage, counter: number) => processDelta(delta, counter, bus) };
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

const hasAck = (messages: unknown[]): boolean =>
  messages.some(m => (m as { success?: boolean }).success === true);

// ---- Tests -----------------------------------------------------------------

describe('subscribe: snapshot activation', () => {
  it('activates immediately when buffer has newer counter', async () => {
    const table           = 'instrument_imm';
    const snapshotCounter = 5;
    const deltaCounter    = 10;

    const { server, url } = await startSnapshotServer({ [table]: makeSnapshot(table, snapshotCounter) });
    const { wss, push }   = createTestService(url);

    push(makeMsg(table, 'insert'), deltaCounter);

    const port           = await listen(wss);
    const { client, messages } = await connect(port);

    client.send(JSON.stringify({ op: 'subscribe', args: [table] }));
    await waitFor(messages, msgs => partials(msgs).length >= 1);

    expect(partials(messages)).toHaveLength(1);
    expect((partials(messages)[0] as BitmexWsMessage).table).toBe(table);

    client.close();
    await closeWss(wss);
    await stopServer(server);
  });

  it('activates after qualifying delta even when old deltas were buffered', async () => {
    const table           = 'orderBook_def';
    const snapshotCounter = 10;
    const olderCounter    = 5;

    const { server, url } = await startSnapshotServer({ [table]: makeSnapshot(table, snapshotCounter) });
    const { wss, push }   = createTestService(url);

    // Pre-buffer an old delta (older than snapshot) — should be dropped
    push(makeMsg(table, 'insert'), olderCounter);

    const port           = await listen(wss);
    const { client, messages } = await connect(port);

    client.send(JSON.stringify({ op: 'subscribe', args: [table] }));

    // Qualifying delta triggers activation
    push(makeMsg(table, 'update'), 20);
    await waitFor(messages, msgs => partials(msgs).length >= 1);

    expect(partials(messages)).toHaveLength(1);
    expect((partials(messages)[0] as BitmexWsMessage).table).toBe(table);

    // Old delta (counter 5) must not appear — only deltas newer than snapshot are valid
    const inserts = messages.filter(m => (m as BitmexWsMessage).action === 'insert');
    expect(inserts).toHaveLength(0);

    client.close();
    await closeWss(wss);
    await stopServer(server);
  });
});

describe('subscribe: snapshot fetch errors', () => {
  it('returns 404 error when snapshot not found', async () => {
    const { server, url } = await startSnapshotServer({});
    const { wss }         = createTestService(url);

    const port           = await listen(wss);
    const { client, messages } = await connect(port);

    client.send(JSON.stringify({ op: 'subscribe', args: ['noSuchTable'] }));

    await waitFor(messages, msgs =>
      msgs.some(m => (m as { status?: number }).status === 400));

    const err = messages.find(m => (m as { status?: number }).status === 400) as { error: string };
    expect(err.error).toMatch(/Unknown table/);

    client.close();
    await closeWss(wss);
    await stopServer(server);
  });
});

describe('subscribe: duplicate and multiple subscriptions', () => {
  it('rejects duplicate subscribe to same table', async () => {
    const table = 'trade_dup';

    const { server, url } = await startSnapshotServer({ [table]: makeSnapshot(table, 1) });
    const { wss, push }   = createTestService(url);

    push(makeMsg(table, 'insert'), 10);

    const port           = await listen(wss);
    const { client, messages } = await connect(port);

    client.send(JSON.stringify({ op: 'subscribe', args: [table] }));
    await waitFor(messages, hasAck);

    client.send(JSON.stringify({ op: 'subscribe', args: [table] }));
    await waitFor(messages, msgs =>
      msgs.some(m => (m as { status?: number }).status === 400));

    const err = messages.find(m => (m as { status?: number }).status === 400) as { error: string };
    expect(err.error).toMatch(/already subscribed/);

    client.close();
    await closeWss(wss);
    await stopServer(server);
  });

  it('allows subscribing to multiple tables in single op', async () => {
    const table1 = 'instrument_multi1';
    const table2 = 'instrument_multi2';

    const { server, url } = await startSnapshotServer({
      [table1]: makeSnapshot(table1, 1),
      [table2]: makeSnapshot(table2, 1),
    });
    const { wss, push } = createTestService(url);

    push(makeMsg(table1, 'insert'), 10);
    push(makeMsg(table2, 'insert'), 10);

    const port           = await listen(wss);
    const { client, messages } = await connect(port);

    client.send(JSON.stringify({ op: 'subscribe', args: [table1, table2] }));
    await waitFor(messages, msgs => partials(msgs).length >= 2);

    const tables = partials(messages).map(m => (m as BitmexWsMessage).table);
    expect(tables).toContain(table1);
    expect(tables).toContain(table2);

    client.close();
    await closeWss(wss);
    await stopServer(server);
  });
});

describe('unsubscribe', () => {
  it('unsubscribes from table and stops receiving deltas', async () => {
    const table = 'trade_unsub';

    const { server, url } = await startSnapshotServer({ [table]: makeSnapshot(table, 5) });
    const { wss, push }   = createTestService(url);

    push(makeMsg(table, 'insert'), 10);

    const port           = await listen(wss);
    const { client, messages } = await connect(port);

    client.send(JSON.stringify({ op: 'subscribe', args: [table] }));
    await waitFor(messages, msgs => partials(msgs).length >= 1);

    // Clear all previous messages (snapshot, acks, etc)
    messages.splice(0);

    client.send(JSON.stringify({ op: 'unsubscribe', args: [table] }));
    await waitFor(messages, msgs =>
      msgs.some(m => (m as { success?: boolean }).success === true));

    // Clear unsubscribe ack
    messages.splice(0);

    // Live delta arrives — should NOT be received
    push(makeMsg(table, 'update'), 15);
    await new Promise(r => setTimeout(r, 200));

    // No update message should have been received
    const updates = messages.filter(m => (m as BitmexWsMessage).action === 'update');
    expect(updates).toHaveLength(0);

    client.close();
    await closeWss(wss);
    await stopServer(server);
  });

  it('unsubscribes from one table while keeping others active', async () => {
    const table1 = 'instrument_keep';
    const table2 = 'instrument_drop';

    const { server, url } = await startSnapshotServer({
      [table1]: makeSnapshot(table1, 1),
      [table2]: makeSnapshot(table2, 1),
    });
    const { wss, push } = createTestService(url);

    push(makeMsg(table1, 'insert'), 10);
    push(makeMsg(table2, 'insert'), 10);

    const port           = await listen(wss);
    const { client, messages } = await connect(port);

    client.send(JSON.stringify({ op: 'subscribe', args: [table1, table2] }));
    await waitFor(messages, msgs => partials(msgs).length >= 2);
    messages.splice(0);

    client.send(JSON.stringify({ op: 'unsubscribe', args: [table2] }));
    await new Promise(r => setTimeout(r, 100));

    // Delta to remaining subscription
    push(makeMsg(table1, 'update'), 15);
    await waitFor(messages, msgs =>
      msgs.some(m => (m as BitmexWsMessage).action === 'update'));

    const updates = messages.filter(m => (m as BitmexWsMessage).action === 'update');
    expect(updates[0]).toHaveProperty('table', table1);

    client.close();
    await closeWss(wss);
    await stopServer(server);
  });

  it('allows unsubscribing from all subscriptions and resubscribing', async () => {
    const table = 'trade_re_sub';

    const { server, url } = await startSnapshotServer({ [table]: makeSnapshot(table, 1) });
    const { wss, push }   = createTestService(url);

    push(makeMsg(table, 'insert'), 10);

    const port           = await listen(wss);
    const { client, messages } = await connect(port);

    // Subscribe
    client.send(JSON.stringify({ op: 'subscribe', args: [table] }));
    await waitFor(messages, msgs => partials(msgs).length >= 1);
    messages.splice(0);

    // Unsubscribe
    client.send(JSON.stringify({ op: 'unsubscribe', args: [table] }));
    await waitFor(messages, msgs =>
      msgs.some(m => (m as { success?: boolean }).success === true));
    messages.splice(0);

    // ReSubscribe to the same table
    client.send(JSON.stringify({ op: 'subscribe', args: [table] }));
    await waitFor(messages, msgs => partials(msgs).length >= 1);

    // Should have received a new snapshot
    const partialMsgs = partials(messages);
    expect(partialMsgs).toHaveLength(1);
    expect((partialMsgs[0] as BitmexWsMessage).table).toBe(table);

    client.close();
    await closeWss(wss);
    await stopServer(server);
  });
});
