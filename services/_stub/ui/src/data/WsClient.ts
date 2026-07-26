import type { WsAction } from '../types';

type ChannelHandler<T = unknown> = (action: WsAction, data: T[]) => void;

/**
 * Manages a single WebSocket connection with ref-counted per-channel subscriptions.
 *
 * `destroy()` closes the connection but is not terminal — a subsequent
 * `subscribe()` will reopen. This keeps the client tolerant of React
 * StrictMode's double-mount, where the same instance gets destroyed then
 * re-used.
 */
export class WsClient {
  private ws:             WebSocket | null = null;
  private listeners:      Map<string, Set<ChannelHandler>> = new Map();
  private connected:      boolean = false;
  private reconnectDelay: number  = 1_000;

  constructor(private readonly url: string) {}

  /**
   * Subscribe to a channel. Sends the WS subscribe op if this is the first
   * listener for this channel. Returns a cleanup function that removes the
   * listener and sends unsubscribe when the last listener is gone.
   */
  subscribe<T>(channel: string, handler: ChannelHandler<T>): () => void {
    if (! this.listeners.has(channel)) {
      this.listeners.set(channel, new Set());
    }

    this.listeners.get(channel)!.add(handler as ChannelHandler);

    if (this.connected) {
      this.send({ op: 'subscribe', args: [channel] });
    } else {
      this.connect();
    }

    return () => this.remove(channel, handler as ChannelHandler);
  }

  destroy() {
    this.ws?.close();
    this.ws = null;
  }

  private remove(channel: string, handler: ChannelHandler) {
    const set = this.listeners.get(channel);

    if (! set) {
      return;
    }

    set.delete(handler);

    if (set.size === 0) {
      this.listeners.delete(channel);

      if (this.connected) {
        this.send({ op: 'unsubscribe', args: [channel] });
      }
    }
  }

  private connect() {
    if (this.ws) {
      return;
    }

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.connected      = true;
      this.reconnectDelay = 1_000;

      const channels = [...this.listeners.keys()];

      if (channels.length > 0) {
        this.send({ op: 'subscribe', args: channels });
      }
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string);

        if (! (msg.table && msg.action && Array.isArray(msg.data))) {
          return;
        }

        const table  = msg.table  as string;
        const action = msg.action as WsAction;
        const data   = msg.data   as Record<string, unknown>[];

        // Dispatch to unfiltered subscribers (e.g. 'trade' → all symbols)
        const tableHandlers = this.listeners.get(table);

        if (tableHandlers) {
          tableHandlers.forEach(h => h(action, data));
        }

        // Dispatch to symbol-scoped subscribers (e.g. 'trade:XBTUSD').
        // BitMEX already filters server-side when you subscribe to 'table:SYMBOL',
        // but messages still arrive with table name only — we do the client-side
        // routing here so both subscription styles work transparently.
        if (data.length > 0 && typeof data[0]['symbol'] === 'string') {
          const bySymbol = new Map<string, Record<string, unknown>[]>();

          for (const item of data) {
            const sym = item['symbol'] as string;

            if (! bySymbol.has(sym)) {
              bySymbol.set(sym, []);
            }

            bySymbol.get(sym)!.push(item);
          }

          for (const [sym, items] of bySymbol) {
            const scopedHandlers = this.listeners.get(`${table}:${sym}`);

            if (scopedHandlers) {
              scopedHandlers.forEach(h => h(action, items));
            }
          }
        }
      } catch {
        // ignore malformed frames
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.ws        = null;

      if (this.listeners.size > 0) {
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      }
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
