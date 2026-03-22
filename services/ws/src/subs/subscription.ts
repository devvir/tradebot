import { WebSocket } from 'ws';
import { logger } from '@devvir/service-kit';
import {
  SUBSCRIPTION,
  DISCONNECT,
  deltaWildcard,
} from '../events';
import type {
  Bus,
  SubscriptionEvent,
  DisconnectEvent,
  DeltaChannelEvent,
} from '../events';
import { parseArg, subscribeAck, unsubscribeAck } from '../server/protocol';
import { unknownTable, alreadySubscribed, authRequired } from '../server/responses';
import type { ClientRegistry } from './clients';
import { Queue } from '@devvir/elastic-queue';
import type { BitmexWsMessage, SubscribeOp } from '../types';

// ---- Types --------------------------------------------------------------

type SubQueue = Queue<DeltaChannelEvent>;

// ---- Private tables -----------------------------------------------------

const PRIVATE_TABLES = new Set([
  'execution', 'order', 'transact',
  'position', 'margin', 'wallet',
  'affiliate',
]);

const RETRY_DELAY_MS = 5_000;

// ---- Helpers ------------------------------------------------------------

const getSymbol = (delta: BitmexWsMessage): string =>
  (delta.data[0] as { symbol?: string } | undefined)?.symbol ?? '_';

// BitMEX accepts args as either a string or an array of strings (quirk).
// Normalise to array so the rest of the code always sees the same shape.
// The parameter is typed loosely because the client controls the wire format.
const normalizeArgs = (args: string[] | string | null | undefined): string[] => {
  if (! args) return [];
  if (typeof args === 'string') return [args];
  return args;
};

// ---- Snapshot fetch -----------------------------------------------------

type SnapshotResult =
  | { ok: true;  snapshot: BitmexWsMessage; counter: number }
  | { ok: false; reason: 'not-found' | 'error' };

const fetchSnapshot = async (
  table:        string,
  symbol:       string,
  snapshotsUrl: string,
  account?:     string,
): Promise<SnapshotResult> => {
  try {
    const symbolParam = symbol !== '_' ? `symbol=${encodeURIComponent(symbol)}` : '';
    const query = account
      ? `?account=${encodeURIComponent(account)}${symbolParam ? `&${symbolParam}` : ''}`
      : (symbolParam ? `?${symbolParam}` : '');
    const res = await fetch(`${snapshotsUrl}/snapshot/${table}${query}`);

    if (res.status === 404) return { ok: false, reason: 'not-found' };
    if (! res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json() as BitmexWsMessage & { counter?: number };
    const { counter, ...snapshot } = data;

    return { ok: true, snapshot: snapshot as BitmexWsMessage, counter: counter ?? 0 };
  } catch (err) {
    logger.error({ err, table }, 'Failed to fetch snapshot');
    return { ok: false, reason: 'error' };
  }
};

// ---- Setup --------------------------------------------------------------

/**
 * Wire subscription handling into the event bus.
 *
 * All state is local to this function (closure) so each call is fully
 * isolated — important for testing and multi-instance scenarios.
 */
export const setup = (
  bus:          Bus,
  registry:     ClientRegistry,
  snapshotsUrl: string,
): void => {

  // ---- State (per-setup, scoped via closure) -------------------------

  // Routing: 'table:symbol' → queues of subscribed clients
  const _keyQueues = new Map<string, Set<SubQueue>>();

  // Reverse map for cleanup on disconnect / unsubscribe
  const _clientQueues = new Map<WebSocket, Map<string, SubQueue>>();

  // Per-table delta listeners, managed to keep the bus clean
  const _tableListeners = new Map<string, (event: DeltaChannelEvent) => void>();

  // ---- Queue helpers ------------------------------------------------

  const addQueue = (ws: WebSocket, key: string, queue: SubQueue): void => {
    if (! _keyQueues.has(key)) _keyQueues.set(key, new Set());
    _keyQueues.get(key)!.add(queue);

    if (! _clientQueues.has(ws)) _clientQueues.set(ws, new Map());
    _clientQueues.get(ws)!.set(key, queue);
  };

  const removeQueue = (ws: WebSocket, key: string): void => {
    const queue = _clientQueues.get(ws)?.get(key);
    if (! queue) return;

    _keyQueues.get(key)?.delete(queue);
    _clientQueues.get(ws)?.delete(key);
  };

  // ---- Table-level delta listeners ----------------------------------
  //
  // One listener per table on the 'delta:table:*' channel pushes incoming
  // deltas to all queues subscribed to that table:symbol.  Each queue
  // handles filtering and forwarding to its client independently.

  const handleTableDelta = (table: string) =>
    (event: DeltaChannelEvent): void => {
      const key    = `${table}:${getSymbol(event.delta)}`;
      const queues = _keyQueues.get(key);
      if (! queues?.size) return;
      for (const queue of queues) queue.push(event);
    };

  const isTableIdle = (table: string): boolean => {
    for (const [key, queues] of _keyQueues) {
      if (key.startsWith(`${table}:`) && queues.size > 0) return false;
    }
    return true;
  };

  const ensureTableListener = (table: string): void => {
    if (_tableListeners.has(table)) return;
    const handler = handleTableDelta(table);
    bus.on(deltaWildcard(table), handler);
    _tableListeners.set(table, handler);
  };

  const removeTableListenerIfIdle = (table: string): void => {
    if (! isTableIdle(table)) return;
    const handler = _tableListeners.get(table);
    if (handler) {
      bus.off(deltaWildcard(table), handler);
      _tableListeners.delete(table);
    }
  };

  // ---- Subscribe / unsubscribe --------------------------------------

  const activate = (ws: WebSocket, queue: SubQueue, snapshot: BitmexWsMessage, counter: number): void => {
    ws.send(JSON.stringify({ ...snapshot, action: 'partial' }));

    queue.stream(({ delta }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(delta));
    }, counter);

    registry.setState(ws, 'streaming');
  };

  const scheduleRetry = (
    ws:      WebSocket,
    key:     string,
    queue:   SubQueue,
    table:   string,
    symbol:  string,
    op:      SubscribeOp,
    account: string | undefined,
  ): void => {
    setTimeout(async () => {
      if (ws.readyState !== WebSocket.OPEN) {
        removeQueue(ws, key);
        removeTableListenerIfIdle(table);
        return;
      }

      const result = await fetchSnapshot(table, symbol, snapshotsUrl, account);

      if (! result.ok) {
        if (result.reason === 'not-found') {
          ws.send(unknownTable(table, op));
          removeQueue(ws, key);
          registry.removeSubscription(ws, key);
          removeTableListenerIfIdle(table);
        } else {
          scheduleRetry(ws, key, queue, table, symbol, op, account);
        }
        return;
      }

      activate(ws, queue, result.snapshot, result.counter);
    }, RETRY_DELAY_MS);
  };

  const handleSubscribe = async (ws: WebSocket, op: SubscribeOp): Promise<void> => {
    for (const arg of normalizeArgs(op.args)) {
      const { table, symbol } = parseArg(arg);
      const key               = `${table}:${symbol}`;
      const account           = PRIVATE_TABLES.has(table) ? registry.getApiKey(ws) : undefined;

      if (PRIVATE_TABLES.has(table) && ! account) {
        ws.send(authRequired(op));
        continue;
      }

      if (registry.hasSubscription(ws, key)) {
        ws.send(alreadySubscribed(arg, op));
        continue;
      }

      // Create queue before fetching snapshot so deltas that arrive
      // during the async fetch are captured and not lost.
      const queue = new Queue<DeltaChannelEvent>();

      ensureTableListener(table);
      addQueue(ws, key, queue);
      registry.addSubscription(ws, key);
      registry.setState(ws, 'awaitSnapshot');

      ws.send(subscribeAck(arg, op));

      const result = await fetchSnapshot(table, symbol, snapshotsUrl, account);

      if (! result.ok) {
        if (result.reason === 'not-found') {
          ws.send(unknownTable(table, op));
          removeQueue(ws, key);
          registry.removeSubscription(ws, key);
          removeTableListenerIfIdle(table);
        } else {
          // Transient error: queue keeps accumulating while we retry
          scheduleRetry(ws, key, queue, table, symbol, op, account);
        }

        continue;
      }

      activate(ws, queue, result.snapshot, result.counter);
    }
  };

  const handleUnsubscribe = (ws: WebSocket, op: SubscribeOp): void => {
    for (const arg of normalizeArgs(op.args)) {
      const { table, symbol } = parseArg(arg);
      const key = `${table}:${symbol}`;

      removeQueue(ws, key);
      registry.removeSubscription(ws, key);
      ws.send(unsubscribeAck(arg, op));

      removeTableListenerIfIdle(table);
    }

    if (registry.getSubscriptions(ws).size === 0) {
      registry.setState(ws, 'idle');
    }
  };

  const handleDisconnect = (ws: WebSocket): void => {
    const keyMap = _clientQueues.get(ws);
    if (! keyMap) return;

    for (const [key] of keyMap) {
      _keyQueues.get(key)?.delete(_clientQueues.get(ws)!.get(key)!);

      const table = key.split(':')[0];
      removeTableListenerIfIdle(table);
    }

    _clientQueues.delete(ws);
    registry.deregister(ws);
  };

  // ---- Wire up bus listeners ----------------------------------------

  bus.on(SUBSCRIPTION, ({ ws, op }: SubscriptionEvent) => {
    if (op.op === 'subscribe') {
      handleSubscribe(ws, op).catch(err => logger.error({ err }, 'Subscribe error'));
    } else if (op.op === 'unsubscribe') {
      handleUnsubscribe(ws, op);
    }
  });

  bus.on(DISCONNECT, ({ ws }: DisconnectEvent) => {
    handleDisconnect(ws);
  });
};
