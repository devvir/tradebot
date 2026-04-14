/**
 * Global types for the trader service
 */

export interface Quote {
  symbol:    string;
  timestamp: string;
  bidPrice:  number;
  bidSize:   number;
  askPrice:  number;
  askSize:   number;
}

export type OrderSide = 'Buy' | 'Sell';

export interface Order {
  orderID:    string;
  /** Client order ID — tagged with tb_<symbol>_ prefix by this service */
  clOrdID?:   string;
  symbol:     string;
  side:       OrderSide;
  price:      number;
  orderQty:   number;
  /** Remaining quantity after partial fills; defaults to orderQty when absent */
  leavesQty?: number;
  ordStatus:  'New' | 'PartiallyFilled' | 'Filled' | 'Cancelled' | 'Expired' | 'Rejected';
  timestamp:  string;
}

export interface Position {
  symbol:           string;
  currentQty:       number;
  markPrice:        number;
  liquidationPrice?: number;
  unrealizedPnl?:   number;
  marginCallPrice?: number;
}

export interface Instrument {
  symbol:      string;
  markPrice:   number;
  tickSize:    number;
  lotSize:     number;
  multiplier:  number;
  fundingRate?: number;
}

export type DataDependency = 'quote' | 'orders' | 'position' | 'instrument' | 'trades';

export interface StrategyInput {
  quote:      Quote | null;
  orders:     Order[];
  position:   Position | null;
  instrument: Instrument | null;
}
