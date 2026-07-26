/**
 * Data cache for subscribed data
 */

import type { Quote, Order, Position, Instrument } from '../types';
import type { SourceData } from './types';

export class DataCache {
  private data: SourceData = {
    quote: null,
    orders: [],
    position: null,
    instrument: null,
  };

  getAll(): SourceData {
    return this.data;
  }

  getQuote(): Quote | null {
    return this.data.quote;
  }

  getOrders(): Order[] {
    return this.data.orders;
  }

  getPosition(): Position | null {
    return this.data.position;
  }

  getInstrument(): Instrument | null {
    return this.data.instrument;
  }

  updateQuote(quote: Quote): void {
    this.data.quote = quote;
  }

  updateOrders(orders: Order[]): void {
    this.data.orders = orders;
  }

  updatePosition(position: Position): void {
    this.data.position = position;
  }

  updateInstrument(instrument: Instrument): void {
    this.data.instrument = instrument;
  }
}
