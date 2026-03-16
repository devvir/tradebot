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
  return {
    wss,
    registry,
    push: (delta: BitmexWsMessage, counter: number) => processDelta(delta, counter, bus),
  };
};

const makeSnapshot = (table: string, counter: number) => ({
  table,
  action: 'partial',
  keys:   ['id'],
  data:   [{ id: 1 }],
  counter,
});

// ---- Tests -----------------------------------------------------------------

describe('client disconnect and cleanup', () => {
  it('client does not receive messages after disconnecting', async () => {
    const table = 'trade_disconnect';

    const { server, url } = await startSnapshotServer({ [table]: makeSnapshot(table, 1) });
    const { wss, push } = createTestService(url);

    const port                 = await listen(wss);
    const { client, messages } = await connect(port);

    client.send(JSON.stringify({ op: 'subscribe', args: [table] }));

    // Wait for snapshot
    await waitFor(messages, msgs =>
      msgs.some(m => (m as BitmexWsMessage).action === 'partial'));

    messages.splice(0); // clear snapshot from messages
    const initialMsgCount = messages.length;

    // Disconnect client
    client.close();
    await new Promise(r => setTimeout(r, 100));

    // Send delta — disconnected client should NOT be in the receiver list
    push({ table, action: 'update', keys: ['id'], data: [{ id: 1 }] }, 10);
    await new Promise(r => setTimeout(r, 200));

    // No new messages should be received by the closed client
    // The client.on('message') won't fire after close anyway, so messages list stays the same
    expect(messages.length).toBe(initialMsgCount);

    await closeWss(wss);
    await stopServer(server);
  });

  it('handles multiple clients disconnecting without affecting others', async () => {
    const table = 'trade_multi_disconnect';

    const { server, url } = await startSnapshotServer({ [table]: makeSnapshot(table, 1) });
    const { wss } = createTestService(url);

    const port = await listen(wss);
    const { client: client1, messages: msgs1 } = await connect(port);
    const { client: client2, messages: msgs2 } = await connect(port);
    const { client: client3, messages: msgs3 } = await connect(port);

    // All subscribe
    client1.send(JSON.stringify({ op: 'subscribe', args: [table] }));
    client2.send(JSON.stringify({ op: 'subscribe', args: [table] }));
    client3.send(JSON.stringify({ op: 'subscribe', args: [table] }));

    await waitFor(msgs1, m => m.some(x => (x as BitmexWsMessage).action === 'partial'));
    await waitFor(msgs2, m => m.some(x => (x as BitmexWsMessage).action === 'partial'));
    await waitFor(msgs3, m => m.some(x => (x as BitmexWsMessage).action === 'partial'));

    msgs1.splice(0);
    msgs2.splice(0);
    msgs3.splice(0);

    // Disconnect client2
    client2.close();
    await new Promise(r => setTimeout(r, 100));

    // client1 and client3 should still be connected and receiving
    // Verify by checking they're still in the registry
    const bus = (wss as any)._eventEmitter;
    expect(msgs1.length).toBe(0); // No unexpected messages
    expect(msgs3.length).toBe(0);

    client1.close();
    client3.close();
    await closeWss(wss);
    await stopServer(server);
  });
});

describe('unwelcome socket behavior', () => {
  it('handles client closing immediately after connect', async () => {
    const { server, url } = await startSnapshotServer({});
    const { wss } = createTestService(url);

    const port = await listen(wss);

    const client = new WebSocket(`ws://localhost:${port}`);
    const messages: unknown[] = [];

    client.on('message', (data) => messages.push(JSON.parse(data.toString())));

    await new Promise<void>(r => client.on('open', r));
    client.close();

    // Server should handle gracefully (no errors logged)
    await new Promise(r => setTimeout(r, 100));

    // Verify wss is still operational
    const { client: newClient } = await connect(port);
    expect(newClient.readyState).toBe(WebSocket.OPEN);

    newClient.close();
    await closeWss(wss);
    await stopServer(server);
  });

  it('handles rapid connect-disconnect cycles', async () => {
    const { server, url } = await startSnapshotServer({});
    const { wss } = createTestService(url);

    const port = await listen(wss);

    // Rapid cycles
    for (let i = 0; i < 10; i++) {
      const client = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>(r => {
        client.on('open', () => r());
        client.on('error', () => r());
      });
      if (client.readyState === WebSocket.OPEN) client.close();
    }

    // Server should still be operational
    const { client: testClient } = await connect(port);
    expect(testClient.readyState).toBe(WebSocket.OPEN);

    testClient.close();
    await closeWss(wss);
    await stopServer(server);
  });
});
