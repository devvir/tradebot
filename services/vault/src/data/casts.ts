//
// Per-table cast map used when streaming NDJSON.
//
// Only fields that require non-string coercion are listed:
//   'number'      — numeric fields
//   'boolean'     — boolean fields
//   'json'        — object / array fields (JSON.parse on read)
//   'timestamp_D' — BitMEX timestamp format with a 'D' date/time separator,
//                   read as ISO 8601 UTC (see `timestampD`)
//
// String / symbol / guid / timestamp / timespan fields are omitted — they pass
// through as strings. Empty fields are dropped for every table.

import { baseTable } from '@tradebot/utils';

type CastType   = 'number' | 'boolean' | 'json' | 'timestamp_D';
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
//
// The map also covers tables with no TABLE_HEADERS entry: a closed file can
// belong to any table, and it is cast on read all the same.

export const TABLE_CASTS: Record<string, TableCasts> = {

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

  compositeIndex: num('indexMultiplier', 'lastPrice', 'sourcePrice', 'conversionIndexPrice', 'weight'),

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

// ── Casting ───────────────────────────────────────────────────────────────────

// A zone designator at the end of an ISO 8601 timestamp: Z, ±hh:mm or ±hhmm.
const ZONE = /(?:[Zz]|[+-]\d{2}:?\d{2})$/;

/**
 * `2019-01-01D00:00:03.181913000` → `2019-01-01T00:00:03.181913000Z`. BitMEX
 * writes these timestamps in UTC, with or without a trailing `Z`; one without a
 * zone gets `Z`. The fractional digits are kept as they are.
 */
const timestampD = (value: string): string => {
  const iso = value.replace('D', 'T');

  return ZONE.test(iso) ? iso : `${iso}Z`;
};

const parseJson = (value: string): unknown => {
  try { return JSON.parse(value); } catch { return value; }
};

const CASTERS: Record<CastType, (value: string) => unknown> = {
  number:      value => Number(value),
  boolean:     value => value === 'true',
  json:        parseJson,
  timestamp_D: timestampD,
};

/** Builds one typed row from a record's raw field values. */
export type RowCaster = (fields: readonly string[]) => Record<string, unknown>;

/**
 * Compiles the casts of `table` (or the real table behind a pseudo-table) for a
 * fixed column list. The returned function reads column `cols[i]` from
 * `fields[offset + i]` and returns a row holding only the non-empty fields, each
 * cast per the table's map; fields beyond the columns are ignored.
 */
export const compileCasts = (table: string, cols: readonly string[], offset = 0): RowCaster => {
  const casts   = TABLE_CASTS[baseTable(table)] ?? {};
  const casters = cols.map(col => {
    const cast = casts[col];

    return cast ? CASTERS[cast] : undefined;
  });

  return (fields) => {
    const row: Record<string, unknown> = {};

    for (let i = 0; i < cols.length; i++) {
      const value = fields[offset + i];

      if (value === undefined || value === '') continue;

      const cast = casters[i];

      row[cols[i]!] = cast ? cast(value) : value;
    }

    return row;
  };
};

/**
 * Applies per-table type casts to one row (field name → raw string value).
 * Empty string values are dropped. Returns a typed row with only non-empty fields.
 */
export const applyCasts = (
  raw:   Record<string, string>,
  table: string,
): Record<string, unknown> => {
  const cols = Object.keys(raw);

  return compileCasts(table, cols)(cols.map(col => raw[col]!));
};
