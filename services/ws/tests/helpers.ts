import { WebSocket, WebSocketServer } from 'ws';
import { createServer, type Server as HttpServer } from 'node:http';

// ---- Snapshot HTTP server ---------------------------------------------------

type SnapshotStore = Record<string, object>;

// Mirrors the real snapshots service: if ?symbol= is present and the stored
// snapshot's `types` object contains a 'symbol' field, the response gets
// filter: { symbol }.  Otherwise filter: {}.
export const startSnapshotServer = (store: SnapshotStore): Promise<{ server: HttpServer; url: string }> =>
  new Promise(resolve => {
    const server = createServer((req, res) => {
      const url    = new URL(req.url!, 'http://x');
      const table  = url.pathname.match(/^\/snapshot\/([^/]+)$/)?.[1];
      const symbol  = url.searchParams.get('symbol')  ?? undefined;
      const account = url.searchParams.get('account') ?? undefined;

      if (! table || ! (store as Record<string, unknown>)[table]) {
        res.writeHead(404).end();
        return;
      }

      const base            = store[table] as Record<string, unknown>;
      const types           = base.types as object | null | undefined;
      const hasAccountField = typeof types === 'object' && types !== null && 'account' in types;
      const hasSymbolField  = typeof types === 'object' && types !== null && 'symbol' in types;

      const filter: Record<string, string> = {};

      if (account && hasAccountField) filter['account'] = account;
      if (symbol  && hasSymbolField)  filter['symbol']  = symbol;

      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ ...base, filter }));
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
