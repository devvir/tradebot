import type { BitmexSide, BitmexTickDirection, InstrumentData } from '@tradebot/types';

export const ACTION_ID = {
  partial: 0,
  insert: 1,
  update: 2,
  delete: 3,
} as const;

export const SIDE_ID: Record<BitmexSide, 0 | 1> = {
  Buy: 0,
  Sell: 1
} as const;

export const TICK_DIRECTION: Record<BitmexTickDirection, 0 | 1 | 2 | 3> = {
  MinusTick: 0,
  ZeroMinusTick: 1,
  ZeroPlusTick: 2,
  PlusTick: 3,
} as const;

export const TRD_TYPE = {
  Regular: 0,
  Referential: 1,
} as const;

/**
 * Single-character 1-byte encoding for instrument fields
 * symbol & timestamp: not encoded (stored implicitly)
 * Remaining fields: A-9, then special chars
 */
export const INSTRUMENT_FIELD: Record<keyof InstrumentData, string> = {
  // Not encoded (implicit in structure)
  symbol: '__SYMBOL__',
  timestamp: '__TIMESTAMP__',

  // Top 15 (>1%): A-M
  lastChangePcnt: 'A',
  lastPrice: 'B',
  markPrice: 'C',
  fairPrice: 'D',
  impactAskPrice: 'E',
  impactBidPrice: 'F',
  impactMidPrice: 'G',
  indicativeSettlePrice: 'H',
  midPrice: 'I',
  openValue: 'J',
  prevPrice24h: 'K',
  bidPrice: 'L',
  askPrice: 'M',
  // Next 11: N-X
  typ: 'N',
  listing: 'O',
  front: 'P',
  expiry: 'Q',
  settle: 'R',
  listedSettle: 'S',
  relistInterval: 'T',
  positionCurrency: 'U',
  underlying: 'V',
  quoteCurrency: 'W',
  underlyingSymbol: 'X',
  // Next 13: Y-Z, a-k
  reference: 'Y',
  referenceSymbol: 'Z',
  calcInterval: 'a',
  publishInterval: 'b',
  publishTime: 'c',
  maxOrderQty: 'd',
  minPrice: 'e',
  maxPrice: 'f',
  lotSize: 'g',
  tickSize: 'h',
  multiplier: 'i',
  settlCurrency: 'j',
  underlyingToPositionMultiplier: 'k',
  // Next 13: l-x
  underlyingToSettleMultiplier: 'l',
  quoteToSettleMultiplier: 'm',
  isQuanto: 'n',
  isInverse: 'o',
  initMargin: 'p',
  maintMargin: 'q',
  riskLimit: 'r',
  riskStep: 's',
  limit: 't',
  taxed: 'u',
  deleverage: 'v',
  makerFee: 'w',
  takerFee: 'x',
  // Next 10: y-z, 0-7
  settlementFee: 'y',
  fundingBaseSymbol: 'z',
  fundingQuoteSymbol: '0',
  fundingPremiumSymbol: '1',
  fundingTimestamp: '2',
  fundingInterval: '3',
  fundingRate: '4',
  indicativeFundingRate: '5',
  rebalanceTimestamp: '6',
  rebalanceInterval: '7',
  // Next 10: 8-9, then special chars
  launchingTimestamp: '8',
  prevClosePrice: '9',
  limitDownPrice: '!',
  limitUpPrice: '#',
  prevTotalVolume: '$',
  totalVolume: '%',
  volume: '&',
  volume24h: '*',
  prevTotalTurnover: '+',
  totalTurnover: '-',
  // Remaining 18
  turnover: '.',
  turnover24h: '/',
  homeNotional24h: ':',
  foreignNotional24h: '=',
  vwap: '@',
  highPrice: '^',
  lowPrice: '_',
  lastPriceProtected: '{',
  lastTickDirection: '|',
  rootSymbol: '}',
  state: '~',
  hasLiquidity: '?',
  openInterest: '<',
  fairMethod: '>',
  fairBasisRate: '[',
  fairBasis: ']',
  markMethod: '`',
  settledPriceAdjustmentRate: '(',
  settledPrice: ')',
  instantPnl: ',',
  minTick: ';',
  fundingBaseRate: "'",
  fundingQuoteRate: '"',
  farLegSymbol: '-',
  nearLegSymbol: '+',
} as const;

/**
 * Reverse mappings for decoding (derived from forward mappings)
 */
export const reverseMapping = <K extends PropertyKey, V extends PropertyKey>(obj: Record<K, V>): Record<V, K> => {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [v, k])
  ) as Record<V, K>;
};

export const SIDE_ID_REVERSE = reverseMapping(SIDE_ID) as Record<0 | 1, BitmexSide>;
export const TICK_DIRECTION_REVERSE = reverseMapping(TICK_DIRECTION) as Record<0 | 1 | 2 | 3, BitmexTickDirection>;
export const TRD_TYPE_REVERSE = reverseMapping(TRD_TYPE) as Record<0 | 1, string>;
export const INSTRUMENT_FIELD_REVERSE = reverseMapping(INSTRUMENT_FIELD) as Record<string, keyof InstrumentData>;
