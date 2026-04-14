/**
 * Planner module types
 */

export type OrdType =
  | 'Limit'
  | 'Market'
  | 'Stop'
  | 'StopLimit'
  | 'MarketIfTouched'
  | 'LimitIfTouched'
  | 'Pegged';

export type PegPriceType = 'TrailingStopPeg' | 'PrimaryPeg' | 'MarketPeg';

export type TimeInForce = 'GoodTillCancel' | 'ImmediateOrCancel' | 'FillOrKill' | 'Day';

/**
 * A fully specified order ready to be sent to the exchange.
 * Symbol is added by the planner; all other fields map directly to the BitMEX REST API.
 */
export interface OrderPlan {
  symbol:          string;
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
