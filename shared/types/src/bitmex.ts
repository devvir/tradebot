/**
 * BitMEX WebSocket API type definitions
 * Extracted from partial message schema
 * Reference: https://www.bitmex.com/api/explorer/
 */

/**
 * BitMEX field type as reported in partial message schema
 * These match the REST API field types
 * Reference: https://www.bitmex.com/api/explorer/
 */
export type BitmexFieldType =
  | 'symbol'
  | 'string'
  | 'guid'
  | 'timestamp'
  | 'timespan'
  | 'float'
  | 'long'
  | 'integer'
  | 'boolean'
  | 'date';

/**
 * All possible BitMEX WebSocket table names
 */
export type BitmexTable =
  | 'insurance'
  | 'instrument'
  | 'orderBookL2'
  | 'quote'
  | 'trade'
  | 'quoteBin1m'
  | 'quoteBin5m'
  | 'quoteBin1h'
  | 'quoteBin1d'
  | 'tradeBin1m'
  | 'tradeBin5m'
  | 'tradeBin1h'
  | 'tradeBin1d'
  | 'liquidation'
  | 'funding'
  | 'settlement';

/**
 * BitMEX WebSocket message structure as received from BitMEX API
 * Discriminated union by action type
 *
 * Note: Data items are identical in structure to data returned from the REST API.
 * For schema verification, see: https://www.bitmex.com/api/explorer/
 */

interface BitmexBaseMessage<Item extends BitmexDataItem = BitmexDataItem> {
  table: BitmexTable;
  filter?: { symbol?: string }
  data: Item[];
  _apiVersion?: string;
}

export interface BitmexPartial<Item extends BitmexDataItem = BitmexDataItem> extends BitmexBaseMessage<Item> {
  action: 'partial';
  keys: string[];
  types: Record<string, BitmexFieldType>;
}

export interface BitmexUpdate<Item extends BitmexDataItem = BitmexDataItem> extends BitmexBaseMessage<Item> {
  action: 'update';
}

export interface BitmexInsert<Item extends BitmexDataItem = BitmexDataItem> extends BitmexBaseMessage<Item> {
  action: 'insert';
}

export interface BitmexDelete<Item extends BitmexDataItem = BitmexDataItem> extends BitmexBaseMessage<Item> {
  action: 'delete';
}

/**
 * Union of all BitMEX WebSocket message types
 */
export type BitmexWSMessage<Item extends BitmexDataItem = BitmexDataItem> =
  | BitmexPartial<Item>
  | BitmexUpdate<Item>
  | BitmexInsert<Item>
  | BitmexDelete<Item>;

/**
 * Alias for backwards compatibility
 */
export type BitmexRawMessage = BitmexWSMessage;

/**
 * Table-specific data types extracted from BitMEX partial messages
 * These define the full field structure for each table
 */

export interface InsuranceData {
  currency: string;
  timestamp: string;
  walletBalance: number;
}

export interface InstrumentData {
  symbol: string;
  rootSymbol?: string;
  state?: string;
  typ?: string;
  listing?: string;
  front?: string;
  expiry?: string;
  settle?: string;
  listedSettle?: string;
  relistInterval?: string;
  positionCurrency?: string;
  underlying?: string;
  quoteCurrency?: string;
  underlyingSymbol?: string;
  reference?: string;
  referenceSymbol?: string;
  calcInterval?: string;
  publishInterval?: string;
  publishTime?: string;
  maxOrderQty?: number;
  minPrice?: number;
  maxPrice?: number;
  lotSize?: number;
  tickSize?: number;
  multiplier?: number;
  settlCurrency?: string;
  underlyingToPositionMultiplier?: number;
  underlyingToSettleMultiplier?: number;
  quoteToSettleMultiplier?: number;
  isQuanto?: boolean;
  isInverse?: boolean;
  initMargin?: number;
  maintMargin?: number;
  riskLimit?: number;
  riskStep?: number;
  limit?: number;
  taxed?: boolean;
  deleverage?: boolean;
  makerFee?: number;
  takerFee?: number;
  settlementFee?: number;
  fundingBaseSymbol?: string;
  fundingQuoteSymbol?: string;
  fundingPremiumSymbol?: string;
  fundingTimestamp?: string;
  fundingInterval?: string;
  fundingRate?: number;
  indicativeFundingRate?: number;
  rebalanceTimestamp?: string;
  rebalanceInterval?: string;
  launchingTimestamp?: string;
  prevClosePrice?: number;
  limitDownPrice?: number;
  limitUpPrice?: number;
  prevTotalVolume?: number;
  totalVolume?: number;
  volume?: number;
  volume24h?: number;
  prevTotalTurnover?: number;
  totalTurnover?: number;
  turnover?: number;
  turnover24h?: number;
  homeNotional24h?: number;
  foreignNotional24h?: number;
  prevPrice24h?: number;
  vwap?: number;
  highPrice?: number;
  lowPrice?: number;
  lastPrice?: number;
  lastPriceProtected?: number;
  lastTickDirection?: string;
  lastChangePcnt?: number;
  bidPrice?: number;
  midPrice?: number;
  askPrice?: number;
  impactBidPrice?: number;
  impactMidPrice?: number;
  impactAskPrice?: number;
  hasLiquidity?: boolean;
  openInterest?: number;
  openValue?: number;
  fairMethod?: string;
  fairBasisRate?: number;
  fairBasis?: number;
  fairPrice?: number;
  markMethod?: string;
  markPrice?: number;
  indicativeSettlePrice?: number;
  settledPriceAdjustmentRate?: number;
  settledPrice?: number;
  instantPnl?: boolean;
  minTick?: number;
  fundingBaseRate?: number;
  fundingQuoteRate?: number;
  farLegSymbol?: string;
  nearLegSymbol?: string;
  timestamp: string;
}

export interface OrderBookL2Data {
  symbol: string;
  id: number;
  side: string;
  size?: number;
  price: number;
  pool?: string;
  timestamp: string;
  transactTime?: string;
}

export interface QuoteData {
  timestamp: string;
  symbol: string;
  bidSize: number;
  bidPrice: number;
  askPrice: number;
  askSize: number;
  pool?: string;
}

export interface TradeData {
  timestamp: string;
  symbol: string;
  side: string;
  size: number;
  price: number;
  tickDirection: string;
  trdMatchID: string;
  grossValue: number;
  homeNotional: number;
  foreignNotional: number;
  trdType: string;
  pool?: string;
}

export interface QuoteBinData {
  timestamp: string;
  symbol: string;
  bidSize: number;
  bidPrice: number;
  askPrice: number;
  askSize: number;
  pool?: string;
}

export interface TradeBinData {
  timestamp: string;
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  trades: number;
  volume: number;
  vwap?: number;
  lastSize?: number;
  turnover: number;
  homeNotional: number;
  foreignNotional: number;
  pool?: string;
}

export interface LiquidationData {
  orderID: string;
  symbol: string;
  side: string;
  price: number;
  leavesQty: number;
}

export interface FundingData {
  symbol: string;
  timestamp: string;
  fundingInterval: string;
  fundingRate: number;
  fundingRateDaily: number;
}

export interface SettlementData {
  timestamp: string;
  symbol: string;
  settlementType: string;
  settledPrice?: number;
  optionStrikePrice?: number;
  optionUnderlyingPrice?: number;
  bankrupt?: number;
  taxBase?: number;
  taxRate?: number;
}

/**
 * Union type of all possible BitMEX data items
 */
export type BitmexDataItem =
  | InsuranceData
  | InstrumentData
  | OrderBookL2Data
  | QuoteData
  | TradeData
  | QuoteBinData
  | TradeBinData
  | LiquidationData
  | FundingData
  | SettlementData;

/**
 * ISO 8601 timestamp as string
 * Format: 2026-02-15T19:27:38.368Z
 *
 * Branded type for type safety without the union explosion.
 * Use isISO8601Timestamp() to narrow types at runtime.
 */
export type ISO8601Timestamp = string & { readonly __iso8601: true };

/**
 * Type guard to validate ISO 8601 timestamp format
 * Regex validates: YYYY-MM-DDTHH:mm:ss.fffZ
 * - Year: any 4-digit number (not restricted to 2000-2099)
 * - Month: 01-12
 * - Day: 01-31 (accepts some invalid combos like Feb 31, but that's okay)
 * - Hour: 00-23
 * - Minute/Second: 00-59
 * - Milliseconds: exactly 4 digits
 *
 * Cost: Single regex test, very cheap
 */
const ISO8601_REGEX =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{4}Z$/;

export function isISO8601Timestamp(value: string): value is ISO8601Timestamp {
  return ISO8601_REGEX.test(value);
}
