//
// Per-table cast map used when streaming NDJSON.
//
// Only fields that require non-string coercion are listed:
//   'number'      — numeric fields
//   'boolean'     — boolean fields
//   'json'        — object / array fields (JSON.parse on read)
//   'required'    — string fields BitMEX explicitly sends as empty string (preserved)
//   'timestamp_D' — BitMEX timestamp format with 'D' separator → 'T'
//
// String / symbol / guid / timestamp / timespan fields are omitted — they pass
// through as strings and are dropped when empty.

type CastType  = 'number' | 'boolean' | 'json' | 'required' | 'timestamp_D';
type TableCasts = Record<string, CastType>;

// ── Helpers ───────────────────────────────────────────────────────────────────

const num  = (...fields: string[]): TableCasts => Object.fromEntries(fields.map(f => [f, 'number'      as CastType]));
const bool = (...fields: string[]): TableCasts => Object.fromEntries(fields.map(f => [f, 'boolean'     as CastType]));
const json = (...fields: string[]): TableCasts => Object.fromEntries(fields.map(f => [f, 'json'        as CastType]));
const tsD  = (...fields: string[]): TableCasts => Object.fromEntries(fields.map(f => [f, 'timestamp_D' as CastType]));

// ── Shared cast groups ────────────────────────────────────────────────────────

const QUOTE_CASTS: TableCasts    = { ...num('bidSize', 'bidPrice', 'askPrice', 'askSize'), ...tsD('timestamp') };
const TRADE_CASTS: TableCasts    = { ...num('size', 'price', 'grossValue', 'homeNotional', 'foreignNotional'), ...tsD('timestamp') };
const TRADEBIN_CASTS: TableCasts = num('open', 'high', 'low', 'close', 'trades', 'volume', 'vwap', 'lastSize', 'turnover', 'homeNotional', 'foreignNotional');

// ── Per-table casts ───────────────────────────────────────────────────────────

const TABLE_CASTS: Record<string, TableCasts> = {

  orderBook10: { ...json('bids', 'asks') },

  orderBookL2:    num('id', 'size', 'price'),
  orderBookL2_25: num('id', 'size', 'price'),

  quote:      QUOTE_CASTS,
  quoteBin1m: QUOTE_CASTS,
  quoteBin5m: QUOTE_CASTS,
  quoteBin1h: QUOTE_CASTS,
  quoteBin1d: QUOTE_CASTS,

  trade:      TRADE_CASTS,
  tradeBin1m: TRADEBIN_CASTS,
  tradeBin5m: TRADEBIN_CASTS,
  tradeBin1h: TRADEBIN_CASTS,
  tradeBin1d: TRADEBIN_CASTS,

  liquidation: num('price', 'leavesQty'),

  tick: num('price'),

  instrument: {
    ...num(
      'instrumentID', 'maxOrderQty', 'lotSize', 'multiplier',
      'underlyingToPositionMultiplier', 'underlyingToSettleMultiplier', 'quoteToSettleMultiplier',
      'riskLimit', 'riskStep', 'openInterest', 'openValue',
      'prevTotalVolume', 'totalVolume', 'volume', 'volume24h',
      'prevTotalTurnover', 'totalTurnover', 'turnover', 'turnover24h',
      'minPrice', 'maxPrice', 'tickSize', 'initMargin', 'maintMargin', 'limit',
      'makerFee', 'takerFee', 'settlementFee', 'fundingRate', 'indicativeFundingRate',
      'prevClosePrice', 'limitDownPrice', 'limitUpPrice',
      'homeNotional24h', 'foreignNotional24h', 'prevPrice24h',
      'vwap', 'highPrice', 'lowPrice', 'lastPrice', 'lastPriceProtected', 'lastChangePcnt',
      'bidPrice', 'midPrice', 'askPrice',
      'impactBidPrice', 'impactMidPrice', 'impactAskPrice',
      'fairBasisRate', 'fairBasis', 'fairPrice', 'markPrice', 'referencePrice',
      'indicativeSettlePrice', 'settledPriceAdjustmentRate', 'settledPrice',
      'minTick', 'fundingBaseRate', 'fundingQuoteRate',
    ),
    ...bool('isQuanto', 'isInverse', 'taxed', 'deleverage', 'hasLiquidity', 'instantPnl'),
  },

  funding:    num('fundingRate', 'fundingRateDaily'),

  settlement: num('settledPrice', 'optionStrikePrice', 'optionUnderlyingPrice', 'bankrupt', 'taxBase', 'taxRate'),

  insurance: num('walletBalance'),

  announcement: num('id'),

  chat: { ...num('id'), ...json('flair', 'guild') },

  connected: num('id', 'users', 'bots'),

  publicNotifications:  { ...num('ttl'),  ...bool('closable', 'persist') },
  privateNotifications: { ...num('ttl'),  ...bool('closable', 'persist') },

  execution: {
    ...num(
      'account', 'lastQty', 'lastPx', 'orderQty', 'price', 'displayQty', 'stopPx',
      'pegOffsetValue', 'leavesQty', 'cumQty', 'avgPx', 'commission', 'brokerCommission',
      'execCost', 'execComm', 'brokerExecComm', 'homeNotional', 'foreignNotional',
      'realisedPnl', 'maxSlippagePct',
    ),
    ...bool('workingIndicator'),
    ...json('algoOrderDetails'),
  },

  order: {
    ...num('account', 'orderQty', 'price', 'displayQty', 'stopPx', 'pegOffsetValue', 'leavesQty', 'cumQty', 'avgPx', 'maxSlippagePct'),
    ...bool('workingIndicator'),
    ...json('algoOrderDetails'),
  },

  position: {
    ...num(
      'account', 'commission', 'initMarginReq', 'maintMarginReq', 'riskLimit', 'leverage',
      'deleveragePercentile', 'rebalancedPnl', 'prevRealisedPnl', 'prevUnrealisedPnl',
      'openingQty', 'openOrderBuyQty', 'openOrderBuyCost', 'openOrderBuyPremium',
      'openOrderSellQty', 'openOrderSellCost', 'openOrderSellPremium',
      'currentQty', 'currentCost', 'currentComm', 'realisedCost', 'unrealisedCost',
      'grossOpenPremium', 'markPrice', 'markValue', 'riskValue', 'homeNotional', 'foreignNotional',
      'posCost', 'posCross', 'posComm', 'posLoss', 'posMargin', 'posMaint', 'posInit',
      'initMargin', 'maintMargin', 'realisedPnl', 'unrealisedPnl',
      'unrealisedPnlPcnt', 'unrealisedRoePcnt',
      'avgCostPrice', 'avgEntryPrice', 'breakEvenPrice', 'marginCallPrice',
      'liquidationPrice', 'bankruptPrice',
    ),
    ...bool('crossMargin', 'isOpen'),
  },

  margin: {
    ...num(
      'account', 'riskLimit', 'amount', 'prevRealisedPnl', 'grossComm', 'grossOpenCost',
      'grossOpenPremium', 'grossExecCost', 'grossMarkValue', 'riskValue',
      'initMargin', 'maintMargin', 'targetExcessMargin', 'realisedPnl', 'unrealisedPnl',
      'isolatedUnrealisedPnl', 'walletBalance', 'marginBalance', 'marginLeverage',
      'marginUsedPcnt', 'excessMargin', 'availableMargin', 'withdrawableMargin',
      'systemWithdrawableMargin', 'makerFeeDiscount', 'takerFeeDiscount',
      'foreignMarginBalance', 'foreignRequirement',
    ),
  },

  wallet: num('account', 'deposited', 'withdrawn', 'transferIn', 'transferOut', 'amount', 'pendingCredit', 'pendingDebit', 'confirmedDebit'),

  transact: num('account', 'amount', 'walletBalance', 'fee'),

  affiliate: num('account', 'prevPayout', 'prevTurnover', 'prevComm', 'execTurnover', 'execComm', 'totalReferrals', 'totalTurnover', 'totalComm', 'payoutPcnt', 'pendingPayout'),

  csastate: num('account', 'marginBalance', 'marginBalanceMarginCall', 'marginBalanceLiquidation', 'maintMarginRatio', 'maintMarginRatioMarginCall', 'maintMarginRatioLiquidation'),

  isolation: { ...num('account'), ...bool('crossMargin') },

  leverage: num('account', 'leverage'),

  mamAllocation: { ...num('account'), ...json('allocations') },

  voucher: num('account', 'balance'),

};

/**
 * Applies per-table type casts to a parsed row (field name → raw string value).
 * Empty string values are dropped. Returns a typed row with only non-empty fields.
 */
export const applyCasts = (
  raw:   Record<string, string>,
  table: string,
): Record<string, unknown> => {
  const casts  = TABLE_CASTS[table] ?? {};
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    const cast = casts[key];

    if (cast === 'required') {
      result[key] = value;
    } else if (value === '') {
      continue;
    } else if (cast === 'number') {
      result[key] = Number(value);
    } else if (cast === 'boolean') {
      result[key] = value === 'true';
    } else if (cast === 'json') {
      try { result[key] = JSON.parse(value); } catch { result[key] = value; }
    } else if (cast === 'timestamp_D') {
      result[key] = value.replace('D', 'T');
    } else {
      result[key] = value;
    }
  }

  return result;
};
