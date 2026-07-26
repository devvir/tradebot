// All interfaces and types — no inline types elsewhere in this service.

// ── MongoDB document shapes ────────────────────────────────────────────────────

export interface OrderDoc {
  orderID:   string;
  clOrdID:   string;
  accountId: string;
  symbol:    string;
  side:      'Buy' | 'Sell';
  ordType:   'Limit' | 'Market';
  price:     number | null;
  orderQty:  number;
  leavesQty: number;
  cumQty:    number;
  avgPx:     number | null;
  ordStatus: 'New' | 'PartiallyFilled' | 'Filled' | 'Canceled';
  timestamp: string;
  text:      string;
}

export interface ExecutionDoc {
  execID:        string;
  orderID:       string;
  clOrdID:       string;
  accountId:     string;
  symbol:        string;
  side:          'Buy' | 'Sell';
  price:         number;
  lastQty:       number;
  lastPx:        number;
  cumQty:        number;
  leavesQty:     number;
  ordStatus:     string;
  execType:      'New' | 'Trade' | 'Canceled' | 'Liquidation';
  timestamp:     string;    // replay clock — aligns with the trade that triggered it
  wallTimestamp: string;    // wall clock — when teller processed it during replay
}

export interface PositionDoc {
  accountId:        string;
  symbol:           string;
  strategy:         string;    // '' in one-way mode; leg identifier in hedge mode
  crossMargin:      boolean;   // true in v1 (cross-margin only)
  currentQty:       number;
  avgEntryPx:       number | null;
  realisedPnl:      number;    // satoshis
  unrealisedPnl:    number;    // satoshis; recomputed on mark price change
  markPrice:        number | null;
  liquidationPrice: number | null;  // null until liquidation formulas are implemented
  bankruptcyPrice:  number | null;  // null until liquidation formulas are implemented
  timestamp:        string;
}

export interface MarginDoc {
  accountId:       string;
  currency:        'XBt';
  walletBalance:   number;    // satoshis; starting balance ± realised PnL
  realisedPnl:     number;
  unrealisedPnl:   number;
  marginBalance:   number;    // walletBalance + unrealisedPnl
  availableMargin: number;    // marginBalance - initMargin
  initMargin:      number;    // sum of initial margin held for open orders
  maintMargin:     number;    // maintenance margin; liquidation triggers when marginBalance < maintMargin
  timestamp:       string;
}

// ── In-memory state ────────────────────────────────────────────────────────────

export interface AccountState {
  margin:    MarginDoc;
  positions: Map<string, PositionDoc>;  // symbol → position
  orders:    Map<string, OrderDoc>;     // orderID → order
}

export interface PriceGuard {
  highestBid: number | null;  // most aggressive buy limit resting for this symbol
  lowestAsk:  number | null;  // most aggressive sell limit resting for this symbol
}

export interface InstrumentCache {
  symbol:        string;
  multiplier:    number;      // raw from instrument stream (e.g. -1e8 for XBTUSD)
  initMarginReq: number;
  maintMarginReq: number;
  tickSize:      number;
  lotSize:       number;
  markPrice:     number | null;
}

/** Service state — lives in service.state() and is accessible via SK_STATE from the registry. */
export interface State {
  store:       Map<string, AccountState>;  // accountId → state
  guards:      Map<string, PriceGuard>;   // symbol → price guard
  instruments: Map<string, InstrumentCache>;
}

// ── Config ─────────────────────────────────────────────────────────────────────

export interface InitialBalance {
  currency: 'XBt';
  amount:   number;  // satoshis
}

export interface Config {
  database:       string;
  initialBalance: InitialBalance;
  port:           number;
  exchange:       string;  // RabbitMQ topic exchange name
  diggerUrl:      string;
  workerUuid:     string;
}

// ── Request shapes ─────────────────────────────────────────────────────────────

export interface CreateRequest {
  clOrdID?:  string;
  symbol:    string;
  side:      'Buy' | 'Sell';
  ordType:   'Limit' | 'Market';
  orderQty:  number;
  price?:    number;
  timestamp: string;
}

export interface AmendFields {
  price?:    number;
  orderQty?: number;
}

export interface Fill {
  side:  'Buy' | 'Sell';
  qty:   number;
  price: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Error carrying an HTTP status code — thrown by pure functions, caught by REST routes. */
export class TellerError extends Error {
  constructor(message: string, public readonly statusCode: number = 400) {
    super(message);
    this.name = 'TellerError';
  }
}
