import { WebSocket, WebSocketServer } from 'ws';
import { createServer, type Server as HttpServer } from 'node:http';

// ---- Snapshot HTTP server ---------------------------------------------------

type SnapshotStore = Record<string, object>;

export const startSnapshotServer = (store: SnapshotStore): Promise<{ server: HttpServer; url: string }> =>
  new Promise(resolve => {
    const server = createServer((req, res) => {
      const table = req.url?.match(/^\/snapshot\/([^/?]+)/)?.[1];

      if (! table || ! (store as Record<string, unknown>)[table]) {
        res.writeHead(404).end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(store[table]));
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });

export const stopServer = (server: HttpServer): Promise<void> =>
  new Promise(resolve => server.close(() => resolve()));

// ---- WebSocket helpers -------------------------------------------------------

export const listen = (wss: WebSocketServer): Promise<number> =>
  new Promise(resolve => wss.once('listening', () =>
    resolve((wss.address() as { port: number }).port)));

export const closeWss = (wss: WebSocketServer): Promise<void> =>
  new Promise(resolve => wss.close(() => resolve()));

export const connect = (port: number): Promise<{ client: WebSocket; messages: unknown[] }> =>
  new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    const client = new WebSocket(`ws://localhost:${port}`);

    client.on('message', (data) => messages.push(JSON.parse(data.toString())));
    client.on('open',    () => resolve({ client, messages }));
    client.on('error',   reject);
  });

// ---- Wait helpers -----------------------------------------------------------

export const waitFor = (
  messages: unknown[],
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

export const testHelpers = {
  startSnapshotServer,
  stopServer,
  listen,
  closeWss,
  connect,
  waitFor,
};
