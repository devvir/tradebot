/**
 * WS connection to the exchange WebSocket service.
 *
 * Subscribes to BitMEX-format topics and forwards incoming data to the cache.
 * Reconnects automatically after any disconnect.
 */

import { logger } from '@devvir/service-kit';
import type { QuoteDataFull, InstrumentData } from '@tradebot/types';
import type { SourceConfig } from './types';
import type { DataCache } from './cache';
import type { DataDependency } from '../types';

/** Map from our internal dependency names to BitMEX WS table names */
const TABLE_MAP: Record<DataDependency, string> = {
  quote:      'quote',
  instrument: 'instrument',
  orders:     'order',
  position:   'position',
  trades:     'trade',
};

const RECONNECT_DELAY_MS = 5_000;

export class Connection {
  private readonly wsUrl:     string;
  private readonly cache:     DataCache;
  private ws:                 WebSocket | null = null;
  private connected =         false;
  private subscribedArgs:     string[] = [];
  private stopped =           false;

  constructor(config: SourceConfig, cache: DataCache) {
    this.wsUrl = config.wsUrl;
    this.cache = cache;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);

      ws.addEventListener('open', () => {
        logger.info({ url: this.wsUrl }, 'Trader WS connected');
        this.ws        = ws;
        this.connected = true;
        resolve();
      });

      ws.addEventListener('error', (err) => {
        logger.error({ err }, 'Trader WS error');

        if (! this.connected) {
          reject(new Error('WS connection failed'));
        }
      });

      ws.addEventListener('close', () => {
        this.connected = false;

        if (! this.stopped) {
          logger.warn('Trader WS disconnected — scheduling reconnect');
          setTimeout(() => this.reconnect(), RECONNECT_DELAY_MS);
        }
      });

      ws.addEventListener('message', (event: MessageEvent) => {
        this.handleMessage(event.data as string);
      });
    });
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

  async subscribe(symbol: string, deps: DataDependency[]): Promise<void> {
    this.subscribedArgs = deps
      .filter((dep) => dep !== 'orders' && dep !== 'position') // public only for now
      .map((dep) => `${TABLE_MAP[dep]}:${symbol}`);

    this.sendOp('subscribe', this.subscribedArgs);
  }

  // ---- Private -----------------------------------------------------------

  private reconnect(): void {
    this.connect()
      .then(() => {
        if (this.subscribedArgs.length > 0) {
          this.sendOp('subscribe', this.subscribedArgs);
        }
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'Trader WS reconnect failed');
        setTimeout(() => this.reconnect(), RECONNECT_DELAY_MS);
      });
  }

  private sendOp(op: string, args: string[]): void {
    if (! this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(JSON.stringify({ op, args }));
  }

  private handleMessage(raw: string): void {
    let msg: unknown;

    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (typeof msg !== 'object' || msg === null) {
      return;
    }

    // Control messages (welcome, subscribe ack, etc.) — ignore
    if (! ('table' in msg) || ! ('data' in msg)) {
      return;
    }

    const { table, data } = msg as { table: string; data: unknown[] };

    if (! Array.isArray(data) || data.length === 0) {
      return;
    }

    this.applyData(table, data);
  }

  private applyData(table: string, data: unknown[]): void {
    if (table === 'quote') {
      // Take the last item — most recent quote
      const item = data[data.length - 1] as QuoteDataFull;

      if (item.bidPrice != null && item.askPrice != null) {
        this.cache.updateQuote({
          symbol:    item.symbol,
          timestamp: item.timestamp,
          bidPrice:  item.bidPrice,
          bidSize:   item.bidSize,
          askPrice:  item.askPrice,
          askSize:   item.askSize,
        });
      }
    } else if (table === 'instrument') {
      // First item contains the full instrument snapshot
      const item = data[0] as InstrumentData;

      if (item.tickSize != null && item.lotSize != null) {
        this.cache.updateInstrument({
          symbol:      item.symbol,
          markPrice:   item.markPrice ?? 0,
          tickSize:    item.tickSize,
          lotSize:     item.lotSize,
          multiplier:  item.multiplier ?? 1,
          fundingRate: item.fundingRate,
        });
      }
    }
  }
}
