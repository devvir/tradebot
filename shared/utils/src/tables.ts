import type { BitmexFieldType, BitmexTable } from '@tradebot/types';

/**
 * Static per-table specs derived from live BitMEX WebSocket partial messages.
 * Source: services/ws/tests/fixtures.ts (authoritative keys + types per table).
 *
 * Tables not in the WS fixture set (csastate, isolation, leverage,
 * mamAllocation, voucher, privateNotifications) are approximated from
 * the type definitions in bitmex-database/src/types.ts.
 */

export interface TableSpec {
  keys:   string[];
  types:  Record<string, BitmexFieldType>;
  filter: Record<string, unknown>;
}

export const TABLE_SPECS: Record<BitmexTable, TableSpec> = {

  // ── Order books ─────────────────────────────────────────────────────────────

  orderBook10: {
    keys:   ['symbol'],
    types:  { symbol: 'symbol', bids: '', asks: '', pool: 'symbol', timestamp: 'timestamp' },
    filter: {},
  },

  orderBookL2_25: {
    keys:   ['symbol', 'id', 'side'],
    types:  { symbol: 'symbol', id: 'long', side: 'symbol', size: 'long', price: 'float', pool: 'symbol', timestamp: 'timestamp', transactTime: 'timestamp' },
    filter: {},
  },

  orderBookL2: {
    keys:   ['symbol', 'id', 'side'],
    types:  { symbol: 'symbol', id: 'long', side: 'symbol', size: 'long', price: 'float', pool: 'symbol', timestamp: 'timestamp', transactTime: 'timestamp' },
    filter: {},
  },

  // ── Quote ───────────────────────────────────────────────────────────────────

  quote: {
    keys:   [],
    types:  { timestamp: 'timestamp', symbol: 'symbol', bidSize: 'long', bidPrice: 'float', askPrice: 'float', askSize: 'long', pool: 'symbol' },
    filter: {},
  },

  quoteBin1m: {
    keys:   [],
    types:  { timestamp: 'timestamp', symbol: 'symbol', bidSize: 'long', bidPrice: 'float', askPrice: 'float', askSize: 'long', pool: 'symbol' },
    filter: {},
  },

  quoteBin5m: {
    keys:   [],
    types:  { timestamp: 'timestamp', symbol: 'symbol', bidSize: 'long', bidPrice: 'float', askPrice: 'float', askSize: 'long', pool: 'symbol' },
    filter: {},
  },

  quoteBin1h: {
    keys:   [],
    types:  { timestamp: 'timestamp', symbol: 'symbol', bidSize: 'long', bidPrice: 'float', askPrice: 'float', askSize: 'long', pool: 'symbol' },
    filter: {},
  },

  quoteBin1d: {
    keys:   [],
    types:  { timestamp: 'timestamp', symbol: 'symbol', bidSize: 'long', bidPrice: 'float', askPrice: 'float', askSize: 'long', pool: 'symbol' },
    filter: {},
  },

  // ── Trade ───────────────────────────────────────────────────────────────────

  trade: {
    keys:   [],
    types:  { timestamp: 'timestamp', symbol: 'symbol', side: 'symbol', size: 'long', price: 'float', tickDirection: 'symbol', trdMatchID: 'guid', grossValue: 'long', homeNotional: 'float', foreignNotional: 'float', trdType: 'symbol', pool: 'symbol' },
    filter: {},
  },

  tradeBin1m: {
    keys:   [],
    types:  { timestamp: 'timestamp', symbol: 'symbol', open: 'float', high: 'float', low: 'float', close: 'float', trades: 'long', volume: 'long', vwap: 'float', lastSize: 'long', turnover: 'long', homeNotional: 'float', foreignNotional: 'float', pool: 'symbol' },
    filter: {},
  },

  tradeBin5m: {
    keys:   [],
    types:  { timestamp: 'timestamp', symbol: 'symbol', open: 'float', high: 'float', low: 'float', close: 'float', trades: 'long', volume: 'long', vwap: 'float', lastSize: 'long', turnover: 'long', homeNotional: 'float', foreignNotional: 'float', pool: 'symbol' },
    filter: {},
  },

  tradeBin1h: {
    keys:   [],
    types:  { timestamp: 'timestamp', symbol: 'symbol', open: 'float', high: 'float', low: 'float', close: 'float', trades: 'long', volume: 'long', vwap: 'float', lastSize: 'long', turnover: 'long', homeNotional: 'float', foreignNotional: 'float', pool: 'symbol' },
    filter: {},
  },

  tradeBin1d: {
    keys:   [],
    types:  { timestamp: 'timestamp', symbol: 'symbol', open: 'float', high: 'float', low: 'float', close: 'float', trades: 'long', volume: 'long', vwap: 'float', lastSize: 'long', turnover: 'long', homeNotional: 'float', foreignNotional: 'float', pool: 'symbol' },
    filter: {},
  },

  // ── Other symbol-optional public tables ─────────────────────────────────────

  liquidation: {
    keys:   ['orderID'],
    types:  { orderID: 'guid', symbol: 'symbol', side: 'symbol', price: 'float', leavesQty: 'long' },
    filter: {},
  },

  instrument: {
    keys:  ['symbol'],
    types: {
      symbol: 'symbol', rootSymbol: 'symbol', instrumentID: 'int', state: 'symbol', typ: 'symbol',
      listing: 'timestamp', front: 'timestamp', expiry: 'timestamp', settle: 'timestamp', listedSettle: 'timestamp',
      relistInterval: 'timespan', positionCurrency: 'symbol', underlying: 'symbol', quoteCurrency: 'symbol',
      underlyingSymbol: 'symbol', reference: 'symbol', referenceSymbol: 'symbol',
      calcInterval: 'timespan', publishInterval: 'timespan', publishTime: 'timespan',
      maxOrderQty: 'long', minPrice: 'float', maxPrice: 'float', lotSize: 'long', tickSize: 'float',
      multiplier: 'long', settlCurrency: 'symbol', underlyingToPositionMultiplier: 'long',
      underlyingToSettleMultiplier: 'long', quoteToSettleMultiplier: 'long',
      isQuanto: 'boolean', isInverse: 'boolean', initMargin: 'float', maintMargin: 'float',
      riskLimit: 'long', riskStep: 'long', limit: 'float', taxed: 'boolean', deleverage: 'boolean',
      makerFee: 'float', takerFee: 'float', settlementFee: 'float',
      fundingBaseSymbol: 'symbol', fundingQuoteSymbol: 'symbol', fundingPremiumSymbol: 'symbol',
      fundingTimestamp: 'timestamp', fundingInterval: 'timespan', fundingRate: 'float',
      indicativeFundingRate: 'float', rebalanceTimestamp: 'timestamp', rebalanceInterval: 'timespan',
      launchingTimestamp: 'timestamp', prevClosePrice: 'float', limitDownPrice: 'float', limitUpPrice: 'float',
      prevTotalVolume: 'long', totalVolume: 'long', volume: 'long', volume24h: 'long',
      prevTotalTurnover: 'long', totalTurnover: 'long', turnover: 'long', turnover24h: 'long',
      homeNotional24h: 'float', foreignNotional24h: 'float', prevPrice24h: 'float',
      vwap: 'float', highPrice: 'float', lowPrice: 'float', lastPrice: 'float', lastPriceProtected: 'float',
      lastTickDirection: 'symbol', lastChangePcnt: 'float',
      bidPrice: 'float', midPrice: 'float', askPrice: 'float',
      impactBidPrice: 'float', impactMidPrice: 'float', impactAskPrice: 'float',
      hasLiquidity: 'boolean', openInterest: 'long', openValue: 'long',
      fairMethod: 'symbol', fairBasisRate: 'float', fairBasis: 'float', fairPrice: 'float',
      markMethod: 'symbol', markPrice: 'float', referencePrice: 'float',
      indicativeSettlePrice: 'float', settledPriceAdjustmentRate: 'float', settledPrice: 'float',
      instantPnl: 'boolean', minTick: 'float', fundingBaseRate: 'float', fundingQuoteRate: 'float',
      farLegSymbol: 'symbol', nearLegSymbol: 'symbol', timestamp: 'timestamp',
    },
    filter: {},
  },

  funding: {
    keys:   ['timestamp', 'symbol'],
    types:  { timestamp: 'timestamp', symbol: 'symbol', fundingInterval: 'timespan', fundingRate: 'float', fundingRateDaily: 'float' },
    filter: {},
  },

  settlement: {
    keys:   ['timestamp', 'symbol'],
    types:  { timestamp: 'timestamp', symbol: 'symbol', settlementType: 'symbol', settledPrice: 'float', optionStrikePrice: 'float', optionUnderlyingPrice: 'float', bankrupt: 'long', taxBase: 'long', taxRate: 'float' },
    filter: {},
  },

  // ── Symbol-N/A public tables ─────────────────────────────────────────────────

  insurance: {
    keys:   ['currency', 'timestamp'],
    types:  { currency: 'symbol', timestamp: 'timestamp', walletBalance: 'long' },
    filter: {},
  },

  announcement: {
    keys:   ['id'],
    types:  { id: 'integer', link: 'string', title: 'string', content: 'string', date: 'timestamp' },
    filter: {},
  },

  chat: {
    keys:   ['id'],
    types:  { id: 'integer', date: 'timestamp', user: 'string', message: 'string', html: 'string', userColor: 'string' },
    filter: {},
  },

  connected: {
    keys:   ['id'],
    types:  { id: 'integer', users: 'integer', bots: 'integer' },
    filter: {},
  },

  publicNotifications: {
    keys:   ['id'],
    types:  { title: 'string', body: 'string', ttl: 'number', closable: 'boolean', persist: 'boolean', sound: 'string' },
    filter: {},
  },

  // ── Private tables ────────────────────────────────────────────────────────

  execution: {
    keys:   [],
    types:  { execID: 'guid', orderID: 'guid', origClOrdID: 'symbol', clOrdID: '', clOrdLinkID: '', account: 'long', symbol: 'symbol', strategy: 'symbol', side: 'symbol', lastQty: 'long', lastPx: 'float', lastLiquidityInd: 'symbol', orderQty: 'long', price: 'float', displayQty: 'long', stopPx: 'float', pegOffsetValue: 'float', pegPriceType: 'symbol', currency: 'symbol', settlCurrency: 'symbol', execType: 'symbol', ordType: 'symbol', timeInForce: 'symbol', execInst: 'symbol', contingencyType: 'symbol', ordStatus: 'symbol', triggered: 'symbol', workingIndicator: 'boolean', ordRejReason: '', leavesQty: 'long', cumQty: 'long', avgPx: 'float', commission: 'float', brokerCommission: 'float', feeType: 'symbol', tradePublishIndicator: 'symbol', text: '', trdMatchID: 'guid', execCost: 'long', execComm: 'long', execCommCcy: 'symbol', brokerExecComm: 'long', homeNotional: 'float', foreignNotional: 'float', transactTime: 'timestamp', timestamp: 'timestamp', realisedPnl: 'long', trdType: 'symbol', maxSlippagePct: 'float', pool: 'symbol', destination: 'symbol', algoOrderDetails: 'object', error: 'symbol' },
    filter: {},
  },

  order: {
    keys:   ['orderID'],
    types:  { orderID: 'guid', clOrdID: 'string', clOrdLinkID: 'string', account: 'long', symbol: 'symbol', strategy: 'symbol', side: 'symbol', orderQty: 'long', price: 'float', displayQty: 'long', stopPx: 'float', pegOffsetValue: 'float', pegPriceType: 'symbol', currency: 'symbol', settlCurrency: 'symbol', ordType: 'symbol', timeInForce: 'symbol', execInst: 'symbol', contingencyType: 'symbol', ordStatus: 'symbol', triggered: 'symbol', workingIndicator: 'boolean', ordRejReason: 'string', leavesQty: 'long', cumQty: 'long', avgPx: 'float', text: 'string', transactTime: 'timestamp', timestamp: 'timestamp', parentOrderID: 'guid', maxSlippagePct: 'float', pool: 'symbol', destination: 'symbol', algoOrderDetails: 'object', error: 'symbol' },
    filter: {},
  },

  position: {
    keys:   ['account', 'symbol', 'strategy'],
    types:  { account: 'long', symbol: 'symbol', strategy: 'symbol', currency: 'symbol', underlying: 'symbol', quoteCurrency: 'symbol', commission: 'float', initMarginReq: 'float', maintMarginReq: 'float', riskLimit: 'long', leverage: 'float', crossMargin: 'boolean', deleveragePercentile: 'float', rebalancedPnl: 'long', prevRealisedPnl: 'long', prevUnrealisedPnl: 'long', openingQty: 'long', openOrderBuyQty: 'long', openOrderBuyCost: 'long', openOrderBuyPremium: 'long', openOrderSellQty: 'long', openOrderSellCost: 'long', openOrderSellPremium: 'long', currentQty: 'long', currentCost: 'long', currentComm: 'long', realisedCost: 'long', unrealisedCost: 'long', grossOpenPremium: 'long', isOpen: 'boolean', markPrice: 'float', markValue: 'long', riskValue: 'long', homeNotional: 'float', foreignNotional: 'float', posState: 'symbol', posCost: 'long', posCross: 'long', posComm: 'long', posLoss: 'long', posMargin: 'long', posMaint: 'long', posInit: 'long', initMargin: 'long', maintMargin: 'long', realisedPnl: 'long', unrealisedPnl: 'long', unrealisedPnlPcnt: 'float', unrealisedRoePcnt: 'float', avgCostPrice: 'float', avgEntryPrice: 'float', breakEvenPrice: 'float', marginCallPrice: 'float', liquidationPrice: 'float', bankruptPrice: 'float', timestamp: 'timestamp' },
    filter: {},
  },

  margin: {
    keys:   ['account', 'currency'],
    types:  { account: 'long', currency: 'symbol', riskLimit: 'long', state: 'symbol', amount: 'long', prevRealisedPnl: 'long', grossComm: 'long', grossOpenCost: 'long', grossOpenPremium: 'long', grossExecCost: 'long', grossMarkValue: 'long', riskValue: 'long', initMargin: 'long', maintMargin: 'long', targetExcessMargin: 'long', realisedPnl: 'long', unrealisedPnl: 'long', isolatedUnrealisedPnl: 'long', walletBalance: 'long', marginBalance: 'long', marginLeverage: 'float', marginUsedPcnt: 'float', excessMargin: 'long', availableMargin: 'long', withdrawableMargin: 'long', systemWithdrawableMargin: 'long', makerFeeDiscount: 'float', takerFeeDiscount: 'float', timestamp: 'timestamp', foreignMarginBalance: 'long', foreignRequirement: 'long' },
    filter: {},
  },

  wallet: {
    keys:   ['account', 'currency'],
    types:  { account: 'long', currency: 'symbol', deposited: 'long', withdrawn: 'long', transferIn: 'long', transferOut: 'long', amount: 'long', pendingCredit: 'long', pendingDebit: 'long', confirmedDebit: 'long', timestamp: 'timestamp' },
    filter: {},
  },

  transact: {
    keys:   ['transactID'],
    types:  { transactID: 'guid', account: 'long', currency: 'symbol', network: 'symbol', transactType: 'symbol', amount: 'long', walletBalance: 'long', fee: 'long', transactStatus: 'symbol', address: 'symbol', tx: 'symbol', orderID: 'guid', text: 'symbol', transactTime: 'timestamp', timestamp: 'timestamp', memo: 'symbol', subType: 'symbol' },
    filter: {},
  },

  affiliate: {
    keys:   ['account', 'currency'],
    types:  { account: 'long', currency: 'symbol', prevPayout: 'long', prevTurnover: 'long', prevComm: 'long', prevTimestamp: 'timestamp', execTurnover: 'long', execComm: 'long', totalReferrals: 'long', totalTurnover: 'long', totalComm: 'long', payoutPcnt: 'float', pendingPayout: 'long', timestamp: 'timestamp' },
    filter: {},
  },

  // ── Undocumented private tables (types approximated from type definitions) ──

  csastate: {
    keys:   ['account'],
    types:  { account: 'long', valuationCurrency: 'symbol', maintMarginRatio: 'float', maintMarginRatioMarginCall: 'float', maintMarginRatioLiquidation: 'float', maintMarginRatioStatus: 'symbol', marginBalance: 'long', marginBalanceMarginCall: 'long', marginBalanceLiquidation: 'long', marginBalanceStatus: 'symbol', overallStatus: 'symbol', liquidationDeadline: 'timestamp', timestamp: 'timestamp' },
    filter: {},
  },

  isolation: {
    keys:   ['account', 'symbol'],
    types:  { account: 'long', symbol: 'symbol', crossMargin: 'boolean' },
    filter: {},
  },

  leverage: {
    keys:   ['account', 'symbol', 'strategy'],
    types:  { account: 'long', symbol: 'symbol', strategy: 'symbol', leverage: 'float' },
    filter: {},
  },

  mamAllocation: {
    keys:   ['account', 'marginCurrency'],
    types:  { account: 'long', marginCurrency: 'symbol', allocations: '', timestamp: 'timestamp' },
    filter: {},
  },

  voucher: {
    keys:   ['voucherId'],
    types:  { account: 'long', voucherId: 'guid', currency: 'symbol', balance: 'long', expiry: 'timestamp', voucherType: 'symbol', transactTime: 'timestamp', timestamp: 'timestamp', masterVoucherId: 'guid' },
    filter: {},
  },

  privateNotifications: {
    keys:   ['id'],
    types:  { title: 'string', body: 'string', ttl: 'number', closable: 'boolean', persist: 'boolean', sound: 'string' },
    filter: {},
  },

};

/**
 * Tables whose vault files store reconstructed WS message envelopes
 * (`{ action, date, data[] }`) rather than per-row REST records. Used to
 * decide, at task creation time, whether a bucket flows through the
 * assembler stage or straight to the writer queue.
 */
export const WS_TABLES = new Set<BitmexTable>([
  'announcement',
  'chat',
  'connected',
  'instrument',
  'liquidation',
  'orderBookL2',
  'publicNotifications',
]);

/**
 * Tables whose fields can contain commas, double quotes, or embedded newlines —
 * free-text content such as announcement bodies, chat messages, and notification
 * text. Reading these requires a full RFC 4180 CSV parser; a line-based reader
 * would fragment a quoted field at its embedded `\n` before any consumer saw it
 * as a single field.
 *
 * Every other table holds only numbers, symbols, and ISO timestamps — no
 * quoting — so each physical line is exactly one record and a plain comma split
 * (several times faster) is correct. This is the single source of truth both
 * vault and the data-prepare tool read from.
 */
export const FREE_TEXT_TABLES: ReadonlySet<string> = new Set([
  'announcement',
  'chat',
  'publicNotifications',
]);
