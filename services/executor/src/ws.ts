// Pending Review
import { logger } from '@devvir/service-kit';
import { createDatabase, BitmexTable } from '@devvir/bitmex-database';
import { resolveBitmexUrls } from '@tradebot/utils';
import type { Config, WsState, LiveOrder } from './types';

const READY_TIMEOUT_MS = 5_000;

export interface WsPool {
  getOrCreate: (accountId: string) => Promise<WsState>;
  closeAll:    () => void;
}

export function createWsPool(config: Config): WsPool {
  const pool:    Map<string, WsState>          = new Map();
  const pending: Map<string, Promise<WsState>> = new Map();

  return {
    async getOrCreate(accountId) {
      const existing = pool.get(accountId);

      if (existing) return existing;

      const inFlight = pending.get(accountId);
      if (inFlight) return inFlight;

      const promise = (async () => {
        const expires = Math.round(Date.now() / 1000) + 60;
        const res     = await fetch(`${config.bouncerUrl}/accounts/${accountId}?expires=${expires}`, {
          headers: { 'Authorization': `Bearer ${config.bouncerToken}` },
        });

        if (! res.ok) {
          throw new Error(`Bouncer returned ${res.status} for account '${accountId}'`);
        }

        const { type, apiKey, signature } = await res.json() as { type: 'live' | 'testnet' | 'replay'; apiKey: string; signature: string };
        const wsUrl = resolveBitmexUrls(type).wsUrl;

        const ws = await connectAndWait(accountId, wsUrl, apiKey, signature, expires, () => {
          pool.delete(accountId);
          logger.info({ accountId }, 'WS closed — removed from pool');
        });

        pool.set(accountId, ws);

        return ws;
      })();

      pending.set(accountId, promise);

      promise
        .then(() => pending.delete(accountId))
        .catch(() => pending.delete(accountId));

      return promise;
    },

    closeAll() {
      for (const ws of pool.values()) ws.close();
      pool.clear();
    },
  };
}

function connectAndWait(
  accountId: string,
  wsUrl:     string,
  apiKey:    string,
  signature: string,
  expires:   number,
  onClose:   () => void,
): Promise<WsState> {
  return new Promise((resolve, reject) => {
    const db  = createDatabase();
    let ready = false;
    const ws  = new WebSocket(wsUrl);

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`WS not ready after ${READY_TIMEOUT_MS}ms for account '${accountId}'`));
    }, READY_TIMEOUT_MS);

    const state: WsState = {
      isReady:   () => ready,
      getOrders: () => ready ? db.snapshot(BitmexTable.Order) as LiveOrder[] : [],
      close:     () => ws.close(),
    };

    ws.onopen = () => {
      logger.info({ accountId }, 'WS connected — authenticating');
      ws.send(JSON.stringify({ op: 'authKeyExpires', args: [apiKey, expires, signature] }));
    };

    ws.onmessage = (event) => handleMessage(event.data as string);

    ws.onerror = (event) => {
      logger.error({ event, accountId }, 'WS error');
      clearTimeout(timer);
      reject(new Error(`WS connection error for account '${accountId}'`));
    };

    ws.onclose = () => {
      ready = false;
      onClose();
    };

    function handleMessage(raw: string): void {
      let msg: Record<string, unknown>;

      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }

      if ('request' in msg && (msg['request'] as Record<string, unknown>)['op'] === 'authKeyExpires') {
        if (msg['success'] === true) {
          logger.info({ accountId }, 'WS authenticated — subscribing to order table');
          ws.send(JSON.stringify({ op: 'subscribe', args: ['order'] }));
        } else {
          logger.error({ accountId, msg }, 'WS authentication failed');
          clearTimeout(timer);
          reject(new Error(`WS authentication failed for account '${accountId}'`));
        }

        return;
      }

      if ('subscribe' in msg) {
        logger.info({ accountId, subscription: msg['subscribe'] }, 'WS subscription confirmed');
        return;
      }

      if ('table' in msg && 'action' in msg) {
        db.apply(msg as Parameters<typeof db.apply>[0]);

        if (msg['table'] === 'order' && msg['action'] === 'partial') {
          ready = true;
          clearTimeout(timer);
          logger.info({ accountId }, 'WS order table initialised — ready');
          resolve(state);
        }
      }
    }
  });
}
