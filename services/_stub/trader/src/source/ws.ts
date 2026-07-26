/**
 * WebSocket lifecycle for the source.
 *
 * Owns: connect, subscribe, reconnect with capped exponential backoff, and
 * forwarding of incoming table messages to the dispatch layer.
 *
 * Auth: every connection URL is signed with BitMEX-compatible query params so
 * the same code path works against both our `ws` service and BitMEX directly.
 *
 * Reconnect: exponential backoff (capped). Subscriptions are re-sent on each
 * reconnect so a transient outage is invisible to the caller.
 */

import { logger } from '@devvir/service-kit';
import { signWsUrl } from '../auth';
import type { ApiCredentials } from '../auth';
import type { DataCache } from './cache';
import type { SourceConfig, WsMessage } from './types';
import type { DataDependency } from '../types';
import { dispatch } from './dispatch';

/** Map our internal dependency names to BitMEX WS table names */
const TABLE_MAP: Record<DataDependency, string> = {
  quote:      'quote',
  instrument: 'instrument',
  orders:     'order',
  position:   'position',
  trades:     'trade',
};

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS  = 30_000;

export class Connection {
  private readonly wsUrl:     string;
  private readonly creds:     ApiCredentials;
  private readonly cache:     DataCache;
  private ws:                 WebSocket | null = null;
  private connected =         false;
  private stopped =           false;
  private subscribedArgs:     string[] = [];
  private reconnectAttempt =  0;

  constructor(config: SourceConfig, creds: ApiCredentials, cache: DataCache) {
    this.wsUrl = config.wsUrl;
    this.creds = creds;
    this.cache = cache;
  }

  async connect(): Promise<void> {
    return this.openSocket();
  }

  async disconnect(): Promise<void> {
    this.stopped   = true;
    this.connected = false;
    this.ws?.close();
    this.ws = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Subscribe to the given dependencies for one symbol.
   * Args are remembered so they can be re-sent on reconnect.
   */
  subscribe(symbol: string, deps: DataDependency[]): void {
    this.subscribedArgs = deps.map((dep) => `${TABLE_MAP[dep]}:${symbol}`);

    this.sendOp('subscribe', this.subscribedArgs);
  }

  // ---- Private -----------------------------------------------------------

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const signedUrl = signWsUrl(this.wsUrl, this.creds);
      const ws        = new WebSocket(signedUrl);

      let resolved = false;

      ws.addEventListener('open', () => {
        this.ws               = ws;
        this.connected        = true;
        this.reconnectAttempt = 0;
        resolved              = true;
        logger.info({ url: this.wsUrl }, 'Trader WS connected');
        resolve();
      });

      ws.addEventListener('error', (event) => {
        logger.error({ event }, 'Trader WS error');

        if (! resolved) {
          resolved = true;
          reject(new Error('WS connection failed'));
        }
      });

      ws.addEventListener('close', () => {
        this.connected = false;
        this.ws        = null;

        if (this.stopped) return;

        const delay = this.nextReconnectDelay();

        logger.warn({ delayMs: delay, attempt: this.reconnectAttempt }, 'Trader WS disconnected — reconnecting');
        setTimeout(() => this.reconnect(), delay);
      });

      ws.addEventListener('message', (event: MessageEvent) => {
        this.handleMessage(event.data as string);
      });
    });
  }

  private reconnect(): void {
    if (this.stopped) return;

    this.openSocket()
      .then(() => {
        if (this.subscribedArgs.length > 0) {
          this.sendOp('subscribe', this.subscribedArgs);
        }
      })
      .catch((err: unknown) => {
        const delay = this.nextReconnectDelay();

        logger.error({ err, delayMs: delay, attempt: this.reconnectAttempt }, 'Trader WS reconnect failed');
        setTimeout(() => this.reconnect(), delay);
      });
  }

  private nextReconnectDelay(): number {
    this.reconnectAttempt += 1;

    const exp = RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempt - 1, 5);

    return Math.min(exp, RECONNECT_MAX_MS);
  }

  private sendOp(op: string, args: string[]): void {
    if (! this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(JSON.stringify({ op, args }));
  }

  private handleMessage(raw: string): void {
    const msg = parseWsMessage(raw);

    if (! msg) return;

    dispatch(msg.table, msg.data, this.cache);
  }
}

// ---- Helpers -----------------------------------------------------------

function parseWsMessage(raw: string): WsMessage | null {
  let msg: unknown;

  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof msg !== 'object' || msg === null) return null;

  // Control messages (welcome, subscribe ack) lack `table` + `data`
  if (! ('table' in msg) || ! ('data' in msg)) return null;

  const m = msg as { table: unknown; data: unknown };

  if (typeof m.table !== 'string' || ! Array.isArray(m.data)) return null;

  return msg as WsMessage;
}

// ---- Test exports ------------------------------------------------------

export const _test_parseWsMessage = parseWsMessage;
export const _test_TABLE_MAP      = TABLE_MAP;
