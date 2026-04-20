import { WebSocket, WebSocketServer } from 'ws';
import { createServer, type Server as HttpServer } from 'node:http';
import type { BitmexMessage } from '@devvir/bitmex-database';
import type { Snapshots } from '../src/subs/snapshots';

// ---- Snapshot priming -------------------------------------------------------

export interface SnapshotFixture {
  table:    string;
  keys?:    string[];
  types?:   Record<string, string>;
  data?:    unknown[];
  counter:  number;
}

/**
 * Prime an in-memory Snapshots instance with fixture partials, as if the
 * corresponding BitMEX `partial` messages had streamed in. Each fixture's
 * `counter` becomes the table's current counter, mirroring what the live
 * delta consumer does at runtime.
 */
export const primeSnapshots = (
  snapshots: Snapshots,
  store:     Record<string, SnapshotFixture>,
): void => {
  for (const [table, fixture] of Object.entries(store)) {
    const partial = {
      table,
      action: 'partial',
      keys:   fixture.keys  ?? [],
      types:  fixture.types ?? {},
      filter: {},
      data:   fixture.data  ?? [],
    } as unknown as BitmexMessage;

    snapshots.apply(partial, fixture.counter);
  }
};

// ---- Broadcast signal rejector ---------------------------------------------

/**
 * Mock broadcast commands server that always rejects resubscribe requests
 * with 400. Used to assert the "unknown table" path in the subscribe flow:
 * a 400 from broadcast signals BitMEX genuinely rejected the channel.
 */
export const startBroadcastRejector = (): Promise<{ server: HttpServer; url: string }> =>
  new Promise(resolve => {
    const server = createServer((_req, res) => {
      res.writeHead(400).end();
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });

export const stopServer = (server: HttpServer): Promise<void> =>
  new Promise(resolve => server.close(() => resolve()));

// ---- WebSocket helpers ------------------------------------------------------

export const listen = (wss: WebSocketServer): Promise<number> =>
  new Promise(resolve => wss.once('listening', () =>
    resolve((wss.address() as { port: number }).port)));

export const closeWss = (wss: WebSocketServer): Promise<void> =>
  new Promise(resolve => wss.close(() => resolve()));

export const connect = (port: number, apiKey?: string): Promise<{ client: WebSocket; messages: unknown[] }> =>
  new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    const url    = apiKey ? `ws://localhost:${port}?api-key=${encodeURIComponent(apiKey)}` : `ws://localhost:${port}`;
    const client = new WebSocket(url);

    client.on('message', (data) => messages.push(JSON.parse(data.toString())));
    client.on('open',    () => resolve({ client, messages }));
    client.on('error',   reject);
  });

// ---- Wait helpers -----------------------------------------------------------

export const waitFor = (
  messages:  unknown[],
  predicate: (msgs: unknown[]) => boolean,
  timeoutMs = 2000,
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (predicate(messages)) { resolve(); return; }

    const interval = setInterval(() => {
      if (predicate(messages)) { clearInterval(interval); clearTimeout(timer); resolve(); }
    }, 10);

    const timer = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timed out after ${timeoutMs}ms. Messages: ${JSON.stringify(messages)}`));
    }, timeoutMs);
  });
