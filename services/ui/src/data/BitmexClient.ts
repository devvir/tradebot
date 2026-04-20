import type { WsAction } from '../types';
import { WsClient } from './WsClient';

type StreamHandler<T> = (action: WsAction, data: T[]) => void;

/** Sensible defaults for fetch() count per table. */
const FETCH_DEFAULTS: Record<string, number> = {
  trade:     50,
  orderBook: 25,
  order:    100,
  position:  10,
  execution: 50,
};

/**
 * Unified data client for BitMEX. Widgets use data language — fetch and stream —
 * without knowing whether the underlying transport is REST or WebSocket.
 *
 * fetch()  → REST (historical, paginated, one-shot)
 * stream() → WebSocket (live, push, ongoing)
 */
export class BitmexClient {
  private ws: WsClient;

  constructor(
    private readonly restUrl: string,
    wsBaseUrl: string,
  ) {
    this.ws = new WsClient(`${wsBaseUrl}/realtime`);
  }

  /**
   * Fetch a page of records from the REST API.
   * count defaults to a sensible value per table.
   * Extra params (symbol, start, etc.) are forwarded as query string.
   */
  async fetch<T>(
    table:   string,
    count?:  number,
    params?: Record<string, string | number>,
  ): Promise<T[]> {
    const limit = count ?? FETCH_DEFAULTS[table] ?? 50;
    const qs    = new URLSearchParams({ count: String(limit), reverse: 'true' });

    for (const [k, v] of Object.entries(params ?? {})) {
      qs.set(k, String(v));
    }

    const res = await fetch(`${this.restUrl}/${table}?${qs}`);

    if (! res.ok) {
      throw new Error(`REST /${table} failed: ${res.status}`);
    }

    return res.json() as Promise<T[]>;
  }

  /**
   * Subscribe to a live channel. The handler receives (action, data[]) on every
   * WebSocket message for this table. Returns a cleanup function — call it to
   * unsubscribe (the WS unsubscribe op is sent when the last listener is removed).
   */
  stream<T>(table: string, handler: StreamHandler<T>): () => void {
    return this.ws.subscribe(table, handler);
  }

  destroy() {
    this.ws.destroy();
  }
}
