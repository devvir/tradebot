import { describe, it, expect } from 'vitest';
import { WebSocket } from 'ws';
import { createBus } from '../src/events';
import { ClientRegistry } from '../src/subs/clients';
import { createServer } from '../src/server/websocket';
import { setup } from '../src/subs/subscription';
import { createSnapshots } from '../src/subs/snapshots';
import type { BitmexWsMessage } from '../src/types';
import {
  primeSnapshots,
  startBroadcastRejector,
  stopServer,
  listen,
  closeWss,
  connect,
  waitFor,
  type SnapshotFixture,
} from './helpers';

const createTestService = (store: Record<string, SnapshotFixture> = {}, broadcastUrl = '') => {
  const bus       = createBus();
  const registry  = new ClientRegistry();
  const snapshots = createSnapshots();
  const wss       = createServer(bus, registry, 0);

  primeSnapshots(snapshots, store);
  setup(bus, { broadcastUrl }, registry, snapshots);

  return { wss };
};

const makeFixture = (table: string, counter: number): SnapshotFixture => ({
  table,
  keys:    ['id'],
  data:    [{ id: 1 }],
  counter,
});

// ---- Tests -----------------------------------------------------------------

describe('websocket protocol', () => {
  it('responds to ping with pong', async () => {
    const { wss } = createTestService();

    const port  = await listen(wss);
    const rawWs = new WebSocket(`ws://localhost:${port}`);

    const messages: string[] = [];
    rawWs.on('message', (data) => messages.push(data.toString()));
    await new Promise<void>(r => rawWs.on('open', r));

    rawWs.send('ping');

    await waitFor(messages, msgs => msgs.includes('pong'));

    expect(messages).toContain('pong');

    rawWs.close();
    await closeWss(wss);
  });

  it('rejects malformed JSON with 400 error', async () => {
    const { wss } = createTestService();

    const port                 = await listen(wss);
    const { client, messages } = await connect(port);

    client.send('not json at all');

    await waitFor(messages, msgs =>
      msgs.some(m => (m as { status?: number }).status === 400));

    const err = messages.find(m => (m as { status?: number }).status === 400) as { status: number; error: string };
    expect(err.status).toBe(400);
    expect(err.error).toMatch(/Unrecognized/i);

    client.close();
    await closeWss(wss);
  });

  it('rejects unknown op with 400 error', async () => {
    const { wss } = createTestService();

    const port                 = await listen(wss);
    const { client, messages } = await connect(port);

    client.send(JSON.stringify({ op: 'unknownOp', args: [] }));

    await waitFor(messages, msgs =>
      msgs.some(m => (m as { status?: number }).status === 400));

    const err = messages.find(m => (m as { status?: number }).status === 400) as { status: number };
    expect(err.status).toBe(400);

    client.close();
    await closeWss(wss);
  });

  it('rejects subscribe to unknown table with 400 error', async () => {
    const { server, url } = await startBroadcastRejector();
    const { wss }         = createTestService({}, url);

    const port                 = await listen(wss);
    const { client, messages } = await connect(port);

    client.send(JSON.stringify({ op: 'subscribe', args: ['noSuchTable'] }));

    await waitFor(messages, msgs =>
      msgs.some(m => (m as { status?: number }).status === 400));

    const err = messages.find(m => (m as { status?: number }).status === 400) as { status: number; error: string };
    expect(err.status).toBe(400);
    expect(err.error).toMatch(/Unknown table/i);

    client.close();
    await closeWss(wss);
    await stopServer(server);
  });

  it('rejects duplicate subscribe to same table with 400 error', async () => {
    const table = 'trade_protocol_dup';

    const { wss } = createTestService({ [table]: makeFixture(table, 1) });

    const port                 = await listen(wss);
    const { client, messages } = await connect(port);

    client.send(JSON.stringify({ op: 'subscribe', args: [table] }));
    await waitFor(messages, msgs =>
      msgs.some(m => (m as { success?: boolean }).success === true));
    messages.splice(0);

    client.send(JSON.stringify({ op: 'subscribe', args: [table] }));
    await waitFor(messages, msgs =>
      msgs.some(m => (m as { status?: number }).status === 400));

    const err = messages.find(m => (m as { status?: number }).status === 400) as { status: number; error: string };
    expect(err.status).toBe(400);
    expect(err.error).toMatch(/already subscribed/i);

    client.close();
    await closeWss(wss);
  });

  it('sends success ack on valid subscribe', async () => {
    const table = 'instrument_ack';

    const { wss } = createTestService({ [table]: makeFixture(table, 1) });

    const port                 = await listen(wss);
    const { client, messages } = await connect(port);

    client.send(JSON.stringify({ op: 'subscribe', args: [table] }));

    await waitFor(messages, msgs =>
      msgs.some(m => (m as { success?: boolean }).success === true));

    const ack = messages.find(m => (m as { success?: boolean }).success === true) as { success: boolean };
    expect(ack.success).toBe(true);

    client.close();
    await closeWss(wss);
  });

  it('sends success ack on valid unsubscribe', async () => {
    const table = 'trade_unsub_ack';

    const { wss } = createTestService({ [table]: makeFixture(table, 1) });

    const port                 = await listen(wss);
    const { client, messages } = await connect(port);

    client.send(JSON.stringify({ op: 'subscribe', args: [table] }));
    await waitFor(messages, msgs =>
      msgs.some(m => (m as { success?: boolean }).success === true));
    messages.splice(0);

    client.send(JSON.stringify({ op: 'unsubscribe', args: [table] }));

    await waitFor(messages, msgs =>
      msgs.some(m => (m as { success?: boolean }).success === true));

    const ack = messages.find(m => (m as { success?: boolean }).success === true) as { success: boolean };
    expect(ack.success).toBe(true);

    client.close();
    await closeWss(wss);
  });

  it('normalizes single-string args to array', async () => {
    const table = 'instrument_normalize';

    const { wss } = createTestService({ [table]: makeFixture(table, 1) });

    const port                 = await listen(wss);
    const { client, messages } = await connect(port);

    // Send args as a single string instead of array
    client.send(JSON.stringify({ op: 'subscribe', args: table }));

    await waitFor(messages, msgs =>
      msgs.some(m => (m as { success?: boolean }).success === true));

    const ack = messages.find(m => (m as { success?: boolean }).success === true);
    expect(ack).toBeDefined();

    client.close();
    await closeWss(wss);
  });

  it('handles null/empty args gracefully', async () => {
    const { wss } = createTestService();

    const port                 = await listen(wss);
    const { client, messages } = await connect(port);

    // Subscribe with no args
    client.send(JSON.stringify({ op: 'subscribe', args: null }));
    await new Promise(r => setTimeout(r, 100));

    // Should be treated as no-op (no error, just silence)
    expect(messages.filter(m => (m as { status?: number }).status === 400)).toHaveLength(0);

    client.close();
    await closeWss(wss);
  });
});
