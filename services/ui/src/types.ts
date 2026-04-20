export type WsAction = 'partial' | 'insert' | 'update' | 'delete';

export interface OrderBookLevel {
  symbol: string;
  id:     number;
  side:   'Buy' | 'Sell';
  size:   number;
  price:  number;
}

export interface WsMessage<T = unknown> {
  table:  string;
  action: WsAction;
  data:   T[];
}

export interface TradeBin {
  timestamp:        string;
  symbol:           string;
  open?:            number;
  high?:            number;
  low?:             number;
  close?:           number;
  trades?:          number;
  volume?:          number;
  vwap?:            number;
  lastSize?:        number;
  turnover?:        number;
  homeNotional?:    number;
  foreignNotional?: number;
}

export interface Trade {
  timestamp:      string;
  symbol:         string;
  side:           'Buy' | 'Sell';
  size:           number;
  price:          number;
  tickDirection:  string;
  trdMatchID:     string;
  grossValue:     number;
  homeNotional:   number;
  foreignNotional: number;
}
