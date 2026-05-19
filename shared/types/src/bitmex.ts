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
  | ''          // untyped / array-of-objects (e.g. orderBook10.bids, orderBook10.asks)
  | 'boolean'
  | 'float'
  | 'guid'
  | 'int'
  | 'integer'   // variant seen in some private tables
  | 'long'
  | 'number'    // variant seen in publicNotifications
  | 'object'
  | 'string'
  | 'symbol'
  | 'timespan'
  | 'timestamp';

/**
 * All possible BitMEX WebSocket table names
 */
export type BitmexTable =
  // ── Public ──────────────────────────────────────────────────────────────────
  | 'announcement'
  | 'chat'
  | 'connected'
  | 'funding'
  | 'insurance'
  | 'instrument'
  | 'liquidation'
  | 'orderBook10'
  | 'orderBookL2'
  | 'orderBookL2_25'
  | 'publicNotifications'
  | 'quote'
  | 'quoteBin1d'
  | 'quoteBin1h'
  | 'quoteBin1m'
  | 'quoteBin5m'
  | 'settlement'
  | 'trade'
  | 'tradeBin1d'
  | 'tradeBin1h'
  | 'tradeBin1m'
  | 'tradeBin5m'
  // ── Private ─────────────────────────────────────────────────────────────────
  | 'affiliate'
  | 'csastate'
  | 'execution'
  | 'isolation'
  | 'leverage'
  | 'mamAllocation'
  | 'margin'
  | 'order'
  | 'position'
  | 'privateNotifications'
  | 'transact'
  | 'voucher'
  | 'wallet';

export type BitmexAction = 'partial' | 'update' | 'insert' | 'delete';

export type BitmexSide = 'Buy' | 'Sell';

export type BitmexTickDirection = 'MinusTick' | 'ZeroMinusTick' | 'ZeroPlusTick' | 'PlusTick';

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
}

export interface BitmexPartial<Item extends BitmexDataItem = BitmexDataItem> extends BitmexBaseMessage<Item> {
  action: 'partial';
  keys: string[];
  types: Record<string, BitmexFieldType>;
  foreignKeys?: Record<string, string>;
  attributes?:  Record<string, string>;
  filter?:      Record<string, unknown>;
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
export type BitmexDataMessage<Item extends BitmexDataItem = BitmexDataItem> =
  | BitmexPartial<Item>
  | BitmexUpdate<Item>
  | BitmexInsert<Item>
  | BitmexDelete<Item>;

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
  /** Always present */
  symbol: string;
  timestamp: string;

  /** >35% occurrences */
  lastChangePcnt?: number;
  lastPrice?: number;
  markPrice?: number;

  /** >10% occurrences */
  fairPrice?: number;
  impactAskPrice?: number;
  impactBidPrice?: number;
  impactMidPrice?: number;
  indicativeSettlePrice?: number;
  midPrice?: number;
  openValue?: number;
  prevPrice24h?: number;

  /** 1-10% occurrences */
  askPrice?: number;
  bidPrice?: number;

  /** 0.3-1% occurrences */
  fairBasis?: number;
  foreignNotional24h?: number;
  homeNotional24h?: number;
  lastPriceProtected?: number;
  lastTickDirection?: BitmexTickDirection;
  lowPrice?: number;
  openInterest?: number;
  totalTurnover?: number;
  totalVolume?: number;
  turnover?: number;
  turnover24h?: number;
  volume?: number;
  volume24h?: number;

  /** <0.3% occurrences */
  calcInterval?: string;
  deleverage?: boolean;
  expiry?: string;
  fairBasisRate?: number;
  fairMethod?: string;
  front?: string;
  fundingBaseRate?: number;
  fundingBaseSymbol?: string;
  fundingInterval?: string;
  fundingPremiumSymbol?: string;
  fundingQuoteRate?: number;
  fundingQuoteSymbol?: string;
  fundingRate?: number;
  fundingTimestamp?: string;
  hasLiquidity?: boolean;
  highPrice?: number;
  indicativeFundingRate?: number;
  initMargin?: number;
  instantPnl?: boolean;
  instrumentID?: number;
  isInverse?: boolean;
  isQuanto?: boolean;
  limit?: number;
  limitDownPrice?: number;
  limitUpPrice?: number;
  listing?: string;
  lotSize?: number;
  maintMargin?: number;
  makerFee?: number;
  markMethod?: string;
  maxOrderQty?: number;
  maxPrice?: number;
  minPrice?: number;
  minTick?: number;
  multiplier?: number;
  positionCurrency?: string;
  prevClosePrice?: number;
  prevTotalTurnover?: number;
  prevTotalVolume?: number;
  publishInterval?: string;
  publishTime?: string;
  quoteCurrency?: string;
  quoteToSettleMultiplier?: number;
  reference?: string;
  referencePrice?: number;
  referenceSymbol?: string;
  riskLimit?: number;
  riskStep?: number;
  rootSymbol?: string;
  settle?: string;
  settlCurrency?: string;
  settlementFee?: number;
  state?: string;
  takerFee?: number;
  taxed?: boolean;
  tickSize?: number;
  typ?: string;
  underlying?: string;
  underlyingSymbol?: string;
  underlyingToPositionMultiplier?: number;
  underlyingToSettleMultiplier?: number;
  vwap?: number;

  /** Not seen once in 1.4M sample */
  farLegSymbol?: string;
  launchingTimestamp?: string;
  listedSettle?: string;
  nearLegSymbol?: string;
  rebalanceInterval?: string;
  rebalanceTimestamp?: string;
  relistInterval?: string;
  settledPrice?: number;
  settledPriceAdjustmentRate?: number;
}

export interface OrderBookL2Data {
  symbol: string;
  id: number;
  side: BitmexSide;
  size?: number; // Missing in delete actions
  price: number;
  timestamp: string;
  transactTime: string;
  pool?: string; // Only in Rest API?
}

interface QuoteDataBase {
  timestamp: string;
  symbol: string;
  pool?: string; // Only in Rest API?
}

export interface QuoteDataAsk {
  askSize: number;
  askPrice: number;
}

export interface QuoteDataBid {
  bidSize: number;
  bidPrice: number;
}
// Quote data may include at least one size/price pair, and potentially both.
export type QuoteData = QuoteDataBase & (QuoteDataAsk | QuoteDataBid);
export type QuoteDataFull = QuoteDataBase & QuoteDataAsk & QuoteDataBid;

export interface TradeData {
  timestamp: string;
  symbol: string;
  side: BitmexSide;
  size: number;
  price: number;
  tickDirection: BitmexTickDirection;
  trdType: string;
  trdMatchID?: string;
  grossValue?: number;
  homeNotional?: number;
  foreignNotional?: number;
  pool?: string; // Only in Rest API?
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
  side: BitmexSide;
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

export interface AnnouncementData {
  id: number;
  link: string;
  title: string;
  content: string;
  date: string;
}

export interface ChatData {
  id: number;
  date: string;
  user: string;
  message: string;
  html: string;
  userColor: string;
}

export interface ConnectedData {
  id: number;
  users: number;
  bots: number;
}

export interface PublicNotificationsData {
  title: string;
  body: string;
  ttl: number;
  closable: boolean;
  persist: boolean;
  sound: string;
}

/**
 * Union type of all possible BitMEX data items
 */
export type BitmexDataItem = BitmexDataItemWithSymbol | BitmexDataItemWithoutSymbol;

export type BitmexDataItemWithSymbol =
  | InstrumentData
  | OrderBookL2Data
  | QuoteData
  | TradeData
  | QuoteBinData
  | TradeBinData
  | LiquidationData
  | FundingData
  | SettlementData;

export type BitmexDataItemWithoutSymbol =
  | InsuranceData
  | AnnouncementData
  | ChatData
  | ConnectedData
  | PublicNotificationsData;

/**
 * BitMEX subscription confirmation message
 */
export interface BitmexSubscriptionMessage {
  subscribe: string;
  success: boolean;
  request?: {
    op: string;
    args: string[];
  };
}

/**
 * BitMEX unsubscription confirmation message
 */
export interface BitmexUnsubscriptionMessage {
  unsubscribe: string;
  success: boolean;
  request?: {
    op: string;
    args: string[];
  };
}

/**
 * BitMEX info/welcome message
 */
export interface BitmexInfoMessage {
  info: string;
  version: string;
  timestamp: string;
  docs: string;
  limit?: {
    remaining: number;
  };
}

/**
 * Union of all BitMEX control messages (subscription/unsubscription/info)
 * These are WebSocket control frames, not data messages
 */
export type BitmexControlMessage =
  | BitmexSubscriptionMessage
  | BitmexUnsubscriptionMessage
  | BitmexInfoMessage;

/**
 * Union of all possible BitMEX WebSocket messages
 * Includes both data messages and control messages
 */
export type BitmexWebSocketMessage = BitmexDataMessage | BitmexControlMessage;

/**
 * Type guard for subscription messages
 */
export const isBitmexSubscriptionMessage = (data: unknown): data is BitmexSubscriptionMessage => {
  return typeof data === 'object' && data !== null && 'subscribe' in data;
};

/**
 * Type guard for unsubscription messages
 */
export const isBitmexUnsubscriptionMessage = (data: unknown): data is BitmexUnsubscriptionMessage => {
  return typeof data === 'object' && data !== null && 'unsubscribe' in data;
};

/**
 * Type guard for info messages
 */
export const isBitmexInfoMessage = (data: unknown): data is BitmexInfoMessage => {
  return typeof data === 'object' && data !== null && 'info' in data && 'version' in data;
};

/**
 * Type guard for data messages
 */
export const isBitmexDataMessage = (data: unknown): data is BitmexDataMessage => {
  return typeof data === 'object' && data !== null && 'table' in data && 'action' in data;
};

/**
 * Type guard for subscription messages
 */
export const isBitmexDataWithSymbol = (data: BitmexDataItem[]): data is BitmexDataItemWithSymbol[] => {
  return data.length > 0 && 'symbol' in data[0];
};

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
