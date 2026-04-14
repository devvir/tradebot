/**
 * Source module types
 */

import type { Quote, Order, Position, Instrument } from '../types';

export interface SourceData {
  quote: Quote | null;
  orders: Order[];
  position: Position | null;
  instrument: Instrument | null;
}

export interface SourceConfig {
  wsUrl: string;
  restUrl: string;
}
