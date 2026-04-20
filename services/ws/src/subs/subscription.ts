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
import type { Snapshots } from './snapshots';
import { Queue } from '@devvir/elastic-queue';
import type { BitmexWsMessage, Config, SubscribeOp } from '../types';
import { PRIVATE_CHANNELS } from '@tradebot/utils';

// ---- Types --------------------------------------------------------------

type SubQueue = Queue<DeltaChannelEvent>;

// ---- Private tables -----------------------------------------------------

const PRIVATE_TABLES = new Set<string>(PRIVATE_CHANNELS);

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

// ---- Broadcast signal ---------------------------------------------------

type SignalResult = 'ok' | 'rejected' | 'error';

const signalBroadcastResubscribe = async (
  broadcastUrl: string,
  channel:      string,
  accountId?:   string,
): Promise<SignalResult> => {
  try {
    const headers: Record<string, string> = {};

    if (accountId) headers['x-account-id'] = accountId;

    const res = await fetch(`${broadcastUrl}/resubscribe/${channel}`, {
      method: 'POST',
      headers,
    });

    if (res.status === 201) return 'ok';
    if (res.status === 400) return 'rejected';

    logger.warn({ channel, accountId, status: res.status }, 'Broadcast resubscribe signal returned unexpected status');

    return 'error';
  } catch (err) {
    logger.warn({ err, channel, accountId }, 'Broadcast resubscribe signal failed');
    return 'error';
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
  bus:       Bus,
  config:    Config,
  registry:  ClientRegistry,
  snapshots: Snapshots,
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
      const routingId = PRIVATE_TABLES.has(table) ? (event.accountId ?? '') : getSymbol(event.delta);
      const key       = `${table}:${routingId}`;

      const queues = _keyQueues.get(key);

      if (queues?.size) {
        for (const queue of queues)
          queue.push(event);
      }

      // Also deliver to wildcard subscribers (subscribed to the table without a symbol filter)
      if (routingId !== '_') {
        const wildcardQueues = _keyQueues.get(`${table}:_`);

        if (wildcardQueues?.size) {
          for (const queue of wildcardQueues)
            queue.push(event);
        }
      }
    };

  const isTableIdle = (table: string): boolean => {
    for (const [key, queues] of _keyQueues) {
      if (key.startsWith(`${table}:`) && queues.size > 0)
        return false;
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

  const activate = (
    ws: WebSocket,
    queue: SubQueue,
    snapshot: BitmexWsMessage,
    counter: number,
    key: string,
  ): void => {
    ws.send(JSON.stringify({ ...snapshot, action: 'partial' }));

    queue.stream(({ delta }) => {
      if (ws.readyState === WebSocket.OPEN && registry.hasSubscription(ws, key))
        ws.send(JSON.stringify(delta));
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
    setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        removeQueue(ws, key);
        removeTableListenerIfIdle(table);
        return;
      }

      const result = snapshots.get(table, symbol !== '_' ? symbol : undefined, account);

      if (! result.ok) {
        scheduleRetry(ws, key, queue, table, symbol, op, account);
        return;
      }

      activate(ws, queue, result.snapshot, result.counter, key);
    }, RETRY_DELAY_MS);
  };

  const handleSubscribe = async (ws: WebSocket, op: SubscribeOp): Promise<void> => {
    for (const arg of normalizeArgs(op.args)) {
      const { table, symbol } = parseArg(arg);
      const account           = PRIVATE_TABLES.has(table) ? registry.getApiKey(ws) : undefined;
      const key               = PRIVATE_TABLES.has(table) ? `${table}:${account ?? ''}` : `${table}:${symbol}`;

      if (PRIVATE_TABLES.has(table) && ! account) {
        ws.send(authRequired(op));
        continue;
      }

      if (registry.hasSubscription(ws, key)) {
        ws.send(alreadySubscribed(arg, op));
        continue;
      }

      // Create queue before reading the snapshot so deltas that arrive
      // between now and activation are captured and not lost.
      const queue = new Queue<DeltaChannelEvent>();

      ensureTableListener(table);
      addQueue(ws, key, queue);
      registry.addSubscription(ws, key);
      registry.setState(ws, 'awaitSnapshot');

      ws.send(subscribeAck(arg, op));

      const result = snapshots.get(table, symbol !== '_' ? symbol : undefined, account);

      if (! result.ok) {
        // Snapshots doesn't have this table yet — signal broadcast to subscribe
        const signal = await signalBroadcastResubscribe(config.broadcastUrl, table, account);

        if (signal === 'rejected') {
          // BitMEX rejected the channel — genuinely unknown table
          ws.send(unknownTable(table, op));
          removeQueue(ws, key);
          registry.removeSubscription(ws, key);
          removeTableListenerIfIdle(table);
          continue;
        }

        // Data is in flight (broadcast signaled) — retry until partial arrives
        scheduleRetry(ws, key, queue, table, symbol, op, account);

        continue;
      }

      activate(ws, queue, result.snapshot, result.counter, key);
    }
  };

  const handleUnsubscribe = (ws: WebSocket, op: SubscribeOp): void => {
    for (const arg of normalizeArgs(op.args)) {
      const { table, symbol } = parseArg(arg);
      const account           = PRIVATE_TABLES.has(table) ? registry.getApiKey(ws) : undefined;
      const key               = PRIVATE_TABLES.has(table) ? `${table}:${account ?? ''}` : `${table}:${symbol}`;

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

  bus.on(DISCONNECT, ({ ws }: DisconnectEvent) => handleDisconnect(ws));
};
