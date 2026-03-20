import { logger } from '@devvir/service-kit';
import { createDatabase, BitmexTable } from '@devvir/bitmex-database';
import type { Config, WsState, LiveOrder } from './types';

export interface WsPool {
  getOrCreate: (accountId: string) => Promise<WsState>;
  closeAll:    () => void;
}

export function createWsPool(config: Config): WsPool {
  const pool = new Map<string, WsState>();

  return {
    async getOrCreate(accountId) {
      const existing = pool.get(accountId);

      if (existing) return existing;

      const expires = Math.round(Date.now() / 1000) + 5;
      const res     = await fetch(`${config.bouncerUrl}/accounts/${accountId}?expires=${expires}`, {
        headers: { 'Authorization': `Bearer ${config.bouncerToken}` },
      });

      if (! res.ok) {
        throw new Error(`Bouncer returned ${res.status} for account '${accountId}'`);
      }

      const { wsUrl, apiKey, signature } = await res.json() as { wsUrl: string; apiKey: string; signature: string };
      const ws = connect(accountId, wsUrl, apiKey, signature, expires, () => {
        pool.delete(accountId);
        logger.info({ accountId }, 'WS closed — removed from pool');
      });

      pool.set(accountId, ws);

      return ws;
    },

    closeAll() {
      for (const ws of pool.values()) ws.close();
      pool.clear();
    },
  };
}

function connect(
  accountId: string,
  wsUrl:     string,
  apiKey:    string,
  signature: string,
  expires:   number,
  onClose:   () => void,
): WsState {
  const db    = createDatabase();
  let ready   = false;
  const ws    = new WebSocket(wsUrl);

  ws.onopen = () => {
    logger.info({ accountId }, 'WS connected — authenticating');
    ws.send(JSON.stringify({ op: 'authKeyExpires', args: [apiKey, expires, signature] }));
  };

  ws.onmessage = (event) => handleMessage(event.data as string);

  ws.onerror = (event) => logger.error({ event, accountId }, 'WS error');

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
        logger.info({ accountId }, 'WS order table initialised — ready');
      }
    }
  }

  return {
    isReady:   () => ready,
    getOrders: () => ready ? db.snapshot(BitmexTable.Order) as LiveOrder[] : [],
    close:     () => ws.close(),
  };
}
