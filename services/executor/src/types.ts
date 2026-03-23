export interface Config {
  bouncerUrl:   string;
  bouncerToken: string;
  httpPort:     number;
  restUrl:      string;
  [key: string]: unknown;
}

export interface DesiredState {
  accountId:       string;
  symbol:          string;
  orders:          DesiredOrder[];
  timestamp:       string;
  amendThreshold?: number;   // absolute price delta; defaults to 0 (any change triggers amend)
}

export interface DesiredOrder {
  side:            'Buy' | 'Sell';
  ordType:         OrdType;
  orderQty?:       number;
  price?:          number;
  stopPx?:         number;
  pegOffsetValue?: number;
  pegPriceType?:   PegPriceType;
  timeInForce?:    TimeInForce;
  execInst?:       string;
  displayQty?:     number;
}

export interface WsState {
  isReady:   () => boolean;
  getOrders: () => LiveOrder[];
  close:     () => void;
}

export interface LiveOrder {
  orderID:   string;
  clOrdID:   string;
  symbol:    string;
  side:      'Buy' | 'Sell';
  ordType:   string;
  ordStatus: string;
  price?:    number;
  leavesQty: number;
  cumQty:    number;
}

export interface AmendOp {
  orderID:    string;
  price?:     number;
  leavesQty?: number;
}

export interface CreateOp {
  order: DesiredOrder;
}

export interface CancelOp {
  orderID: string;
}

export interface ConvergeResult {
  amends:  AmendOp[];
  creates: CreateOp[];
  cancels: CancelOp[];
}

export type OrdType =
  | 'Limit'
  | 'Market'
  | 'Stop'
  | 'StopLimit'
  | 'MarketIfTouched'
  | 'LimitIfTouched'
  | 'Pegged';

export type PegPriceType =
  | 'TrailingStopPeg'
  | 'PrimaryPeg'
  | 'MarketPeg';

export type TimeInForce =
  | 'GoodTillCancel'
  | 'ImmediateOrCancel'
  | 'FillOrKill'
  | 'Day';
