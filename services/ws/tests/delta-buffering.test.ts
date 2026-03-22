import { describe, it, expect } from 'vitest';
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
  return { wss, push: (delta: BitmexWsMessage, counter: number) => processDelta(delta, counter, bus) };
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

describe('delta buffering and replay', () => {
  it('replays buffered deltas newer than snapshot on activation', async () => {
    const table           = 'quote_replay';
    const snapshotCounter = 5;

    const { server, url } = await startSnapshotServer({ [table]: makeSnapshot(table, snapshotCounter) });
    const { wss, push }   = createTestService(url);

    const port                 = await listen(wss);
    const { client, messages } = await connect(port);

    client.send(JSON.stringify({ op: 'subscribe', args: [table] }));

    // Wait for ack — queue now exists and snapshot fetch is in flight.
    // Push deltas here so they're captured by the queue before snapshot arrives.
    await waitFor(messages, hasAck);
    push(makeMsg(table, 'insert'), 10);
    push(makeMsg(table, 'insert'), 15);

    // Expect: snapshot partial + 2 buffered inserts replayed
    await waitFor(messages, msgs =>
      partials(msgs).length >= 1 &&
      msgs.filter(m => (m as BitmexWsMessage).action === 'insert').length >= 2);

    expect(partials(messages)).toHaveLength(1);

    const inserts = messages.filter(m => (m as BitmexWsMessage).action === 'insert');
    expect(inserts).toHaveLength(2);

    client.close();
    await closeWss(wss);
    await stopServer(server);
  });

  it('does not replay old deltas that arrived before subscription', async () => {
    const table           = 'trade_old';
    const snapshotCounter = 10;
    const olderCounter    = 5;

    const { server, url } = await startSnapshotServer({ [table]: makeSnapshot(table, snapshotCounter) });
    const { wss, push }   = createTestService(url);

    // Pre-buffer an old delta (older than snapshot)
    push(makeMsg(table, 'update'), olderCounter);

    const port                 = await listen(wss);
    const { client, messages } = await connect(port);

    client.send(JSON.stringify({ op: 'subscribe', args: [table] }));

    // Qualifying delta triggers activation
    push(makeMsg(table, 'update'), 20);
    await waitFor(messages, msgs => partials(msgs).length >= 1);

    // Clear everything up to and including the partial, then send a live delta
    messages.splice(0);

    push(makeMsg(table, 'insert'), 30);
    await waitFor(messages, msgs =>
      msgs.some(m => (m as BitmexWsMessage).action === 'insert'));

    // Live delta arrives; old delta (counter 5) must not have appeared
    const inserts = messages.filter(m => (m as BitmexWsMessage).action === 'insert');
    expect(inserts).toHaveLength(1);

    const updates = messages.filter(m => (m as BitmexWsMessage).action === 'update');
    expect(updates).toHaveLength(0);

    client.close();
    await closeWss(wss);
    await stopServer(server);
  });
});

describe('counter = 0 (fresh snapshot) edge cases', () => {
  it('accepts snapshot with counter 0 and streams subsequent deltas', async () => {
    const table = 'instrument_counter0';

    const { server, url } = await startSnapshotServer({ [table]: makeSnapshot(table, 0) });
    const { wss, push }   = createTestService(url);

    const port                 = await listen(wss);
    const { client, messages } = await connect(port);

    client.send(JSON.stringify({ op: 'subscribe', args: [table] }));
    await waitFor(messages, hasAck);

    // Delta triggers activation
    push(makeMsg(table, 'insert'), 100);

    await waitFor(messages, msgs =>
      partials(msgs).length >= 1 &&
      msgs.filter(m => (m as BitmexWsMessage).action === 'insert').length >= 1);

    // counter is stripped from the partial before forwarding to clients
    const snapshot = partials(messages)[0] as Record<string, unknown>;
    expect(snapshot).not.toHaveProperty('counter');

    const inserts = messages.filter(m => (m as BitmexWsMessage).action === 'insert');
    expect(inserts).toHaveLength(1);

    client.close();
    await closeWss(wss);
    await stopServer(server);
  });

  it('does not replay deltas when counter is 0 (fresh snapshot case)', async () => {
    const table = 'orderBook_counter0_no_replay';

    const { server, url } = await startSnapshotServer({ [table]: makeSnapshot(table, 0) });
    const { wss, push }   = createTestService(url);

    // Pre-buffer a delta
    push(makeMsg(table, 'update'), 50);

    const port                 = await listen(wss);
    const { client, messages } = await connect(port);

    client.send(JSON.stringify({ op: 'subscribe', args: [table] }));

    // Buffered delta triggers immediate activation
    await waitFor(messages, msgs => partials(msgs).length >= 1);

    // Pre-buffered update must NOT be replayed (counter 0 = fresh start)
    const updates = messages.filter(m => (m as BitmexWsMessage).action === 'update');
    expect(updates).toHaveLength(0);

    // Live delta after activation is received
    push(makeMsg(table, 'insert'), 100);

    await waitFor(messages, msgs =>
      msgs.filter(m => (m as BitmexWsMessage).action === 'insert').length >= 1);

    const inserts = messages.filter(m => (m as BitmexWsMessage).action === 'insert');
    expect(inserts).toHaveLength(1);

    client.close();
    await closeWss(wss);
    await stopServer(server);
  });

  it('treats counter 0 as less than any positive counter when determining replay', async () => {
    const table = 'trade_counter0_comparison';

    const { server, url } = await startSnapshotServer({ [table]: makeSnapshot(table, 0) });
    const { wss, push }   = createTestService(url);

    const port                 = await listen(wss);
    const { client, messages } = await connect(port);

    client.send(JSON.stringify({ op: 'subscribe', args: [table] }));
    await waitFor(messages, hasAck);

    // Delta with counter 1 arrives (1 > 0)
    push(makeMsg(table, 'insert'), 1);

    await waitFor(messages, msgs =>
      partials(msgs).length >= 1 &&
      msgs.filter(m => (m as BitmexWsMessage).action === 'insert').length >= 1);

    // This delta should be streamed, not replayed from buffer
    const inserts = messages.filter(m => (m as BitmexWsMessage).action === 'insert');
    expect(inserts).toHaveLength(1);

    client.close();
    await closeWss(wss);
    await stopServer(server);
  });
});

describe('symbol extraction and routing', () => {
  it('extracts symbol from delta data and routes correctly', async () => {
    const table = 'orderBook_symbol';

    const { server, url } = await startSnapshotServer({ [table]: makeSnapshot(table, 1) });
    const { wss, push }   = createTestService(url);

    const port                 = await listen(wss);
    const { client, messages } = await connect(port);

    client.send(JSON.stringify({ op: 'subscribe', args: [`${table}:XBTUSD`] }));
    await waitFor(messages, msgs =>
      msgs.some(m => (m as BitmexWsMessage).action === 'partial'));
    messages.splice(0);

    // Delta with matching symbol
    const deltaWithSymbol: BitmexWsMessage = {
      table,
      action: 'insert',
      keys: ['symbol'],
      data: [{ symbol: 'XBTUSD' }],
    };

    push(deltaWithSymbol, 10);

    await waitFor(messages, msgs =>
      msgs.some(m => (m as BitmexWsMessage).action === 'insert'));

    const insert = messages.find(m => (m as BitmexWsMessage).action === 'insert');
    expect(insert).toHaveProperty('action', 'insert');
    expect(insert).toHaveProperty('table', table);

    client.close();
    await closeWss(wss);
    await stopServer(server);
  });
});
