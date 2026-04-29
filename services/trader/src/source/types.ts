/**
 * Source module types
 */

import type { Quote, Order, Position, Instrument } from '../types';

export interface SourceData {
  quote:      Quote | null;
  orders:     Order[];
  position:   Position | null;
  instrument: Instrument | null;
}

export interface SourceConfig {
  /** WebSocket URL — points at our `ws` service or BitMEX `wss://www.bitmex.com/realtime` */
  wsUrl: string;
}

/** A BitMEX-format WS message: { table, action, data: [...] } */
export interface WsMessage {
  table:   string;
  action?: 'partial' | 'insert' | 'update' | 'delete';
  data:    unknown[];
}
