/**
 * Global types for the trader service.
 *
 * Module-specific types live in each module's own types.ts. This file holds
 * the cross-module domain types (BitMEX entities) and the top-level Config.
 */

// ---- Top-level config --------------------------------------------------

export interface Config {
  /** WS endpoint — our `ws` service or BitMEX `wss://www.bitmex.com/realtime` */
  wsUrl:          string;
  /** REST endpoint — our `rest` service or BitMEX `https://www.bitmex.com` */
  restUrl:        string;
  /** BitMEX api-key (or our service's account identifier when proxied) */
  apiKey:         string;
  /** BitMEX api-secret used for HMAC signing */
  apiSecret:      string;
  /** Strategy name, looked up in the registry */
  strategy:       string;
  /** Symbol to trade (single-symbol per process for now) */
  symbol:         string;
  /** Strategy tick interval in milliseconds */
  tickIntervalMs: number;
  [key: string]:  unknown;
}

// ---- BitMEX domain entities --------------------------------------------

export interface Quote {
  symbol:    string;
  timestamp: string;
  bidPrice:  number;
  bidSize:   number;
  askPrice:  number;
  askSize:   number;
}

export type OrderSide = 'Buy' | 'Sell';

export type OrdStatus = 'New' | 'PartiallyFilled' | 'Filled' | 'Cancelled' | 'Expired' | 'Rejected';

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
  ordStatus:  OrdStatus;
  timestamp:  string;
}

export interface Position {
  symbol:            string;
  currentQty:        number;
  markPrice:         number;
  liquidationPrice?: number;
  unrealizedPnl?:    number;
  marginCallPrice?:  number;
}

export interface Instrument {
  symbol:       string;
  markPrice:    number;
  tickSize:     number;
  lotSize:      number;
  multiplier:   number;
  fundingRate?: number;
}

// ---- Strategy data dependencies ----------------------------------------

export type DataDependency = 'quote' | 'orders' | 'position' | 'instrument' | 'trades';

export interface StrategyInput {
  quote:      Quote | null;
  orders:     Order[];
  position:   Position | null;
  instrument: Instrument | null;
}
