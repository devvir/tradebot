import type { WsAction } from '../types';

type ChannelHandler<T = unknown> = (action: WsAction, data: T[]) => void;

/**
 * Manages a single WebSocket connection with ref-counted per-channel subscriptions.
 *
 * The connection opens on the first `subscribe()`. While any listener remains,
 * a closed connection reopens after an exponential backoff (1 s, doubling to a
 * 30 s cap, back to 1 s once a connection opens), and the new connection
 * subscribes every registered channel. Events are acted on only when they come
 * from the socket the client currently owns.
 *
 * `destroy()` closes the connection, cancels a pending reconnect and drops the
 * socket's handlers. It is not terminal: listeners stay registered, and the
 * next `subscribe()` opens a new connection.
 */
export class WsClient {
  private ws:             WebSocket | null = null;
  private listeners:      Map<string, Set<ChannelHandler>> = new Map();
  private connected:      boolean = false;
  private reconnectDelay: number  = 1_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly url: string) {}

  /**
   * Subscribe to a channel. When connected, sends the WS subscribe op if this
   * is the first listener for the channel; otherwise opens the connection,
   * which subscribes every channel once open. Returns a cleanup function that
   * removes the listener and sends unsubscribe when the last listener is gone.
   */
  subscribe<T>(channel: string, handler: ChannelHandler<T>): () => void {
    const isNew = ! this.listeners.has(channel);

    if (isNew) {
      this.listeners.set(channel, new Set());
    }

    this.listeners.get(channel)!.add(handler as ChannelHandler);

    if (this.connected) {
      if (isNew) {
        this.send({ op: 'subscribe', args: [channel] });
      }
    } else {
      this.connect();
    }

    return () => this.remove(channel, handler as ChannelHandler);
  }

  destroy() {
    this.clearReconnect();

    const ws = this.ws;

    if (ws) {
      ws.onopen    = null;
      ws.onmessage = null;
      ws.onclose   = null;
      ws.onerror   = null;
      ws.close();
    }

    this.ws             = null;
    this.connected      = false;
    this.reconnectDelay = 1_000;
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
    if (this.ws || this.listeners.size === 0) {
      return;
    }

    this.clearReconnect();

    const ws = new WebSocket(this.url);

    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) {
        return;
      }

      this.connected      = true;
      this.reconnectDelay = 1_000;

      const channels = [...this.listeners.keys()];

      if (channels.length > 0) {
        this.send({ op: 'subscribe', args: channels });
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws) {
        return;
      }

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

    ws.onclose = () => {
      if (this.ws !== ws) {
        return;
      }

      this.connected = false;
      this.ws        = null;

      if (this.listeners.size > 0) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      }
    };

    ws.onerror = () => {
      if (this.ws !== ws) {
        return;
      }

      ws.close();
    };
  }

  private clearReconnect() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
