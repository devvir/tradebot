/**
 * Snapshot fixtures for the mock HTTP snapshot server used in conformance tests.
 *
 * Each entry matches the shape the real snapshots service returns:
 *   { table, keys, types, data, counter }
 * The mock server adds `filter` dynamically based on `?symbol=` and whether
 * `types` contains a `symbol` field.  The WS server strips `counter` and
 * adds `action: 'partial'`.
 *
 * `data` is intentionally empty — conformance tests verify protocol behaviour,
 * not data content.  Tables NOT listed here return 404, which causes the WS
 * server to reply "Unknown table" (used for MISSING_TABLES tests).
 *
 * `keys` and `types` match the real BitMEX snapshots service exactly.
 */

export const snapshotStore: Record<string, object> = {

  // ── Order books ─────────────────────────────────────────────────────────────

  orderBook10: {
    table:   'orderBook10',
    keys:    ['symbol'],
    types:   { symbol: 'symbol', bids: '', asks: '', pool: 'symbol', timestamp: 'timestamp' },
    data:    [],
    counter: 1,
  },

  orderBookL2_25: {
    table:   'orderBookL2_25',
    keys:    ['symbol', 'id', 'side'],
    types:   { symbol: 'symbol', id: 'long', side: 'symbol', size: 'long', price: 'float', pool: 'symbol', timestamp: 'timestamp', transactTime: 'timestamp' },
    data:    [],
    counter: 1,
  },

  orderBookL2: {
    table:   'orderBookL2',
    keys:    ['symbol', 'id', 'side'],
    types:   { symbol: 'symbol', id: 'long', side: 'symbol', size: 'long', price: 'float', pool: 'symbol', timestamp: 'timestamp', transactTime: 'timestamp' },
    data:    [],
    counter: 1,
  },

  // ── Quote ───────────────────────────────────────────────────────────────────

  quote: {
    table:   'quote',
    keys:    [],
    types:   { timestamp: 'timestamp', symbol: 'symbol', bidSize: 'long', bidPrice: 'float', askPrice: 'float', askSize: 'long', pool: 'symbol' },
    data:    [],
    counter: 1,
  },

  quoteBin1m: {
    table:   'quoteBin1m',
    keys:    [],
    types:   { timestamp: 'timestamp', symbol: 'symbol', bidSize: 'long', bidPrice: 'float', askPrice: 'float', askSize: 'long', pool: 'symbol' },
    data:    [],
    counter: 1,
  },

  quoteBin5m: {
    table:   'quoteBin5m',
    keys:    [],
    types:   { timestamp: 'timestamp', symbol: 'symbol', bidSize: 'long', bidPrice: 'float', askPrice: 'float', askSize: 'long', pool: 'symbol' },
    data:    [],
    counter: 1,
  },

  quoteBin1h: {
    table:   'quoteBin1h',
    keys:    [],
    types:   { timestamp: 'timestamp', symbol: 'symbol', bidSize: 'long', bidPrice: 'float', askPrice: 'float', askSize: 'long', pool: 'symbol' },
    data:    [],
    counter: 1,
  },

  quoteBin1d: {
    table:   'quoteBin1d',
    keys:    [],
    types:   { timestamp: 'timestamp', symbol: 'symbol', bidSize: 'long', bidPrice: 'float', askPrice: 'float', askSize: 'long', pool: 'symbol' },
    data:    [],
    counter: 1,
  },

  // ── Trade ───────────────────────────────────────────────────────────────────

  trade: {
    table:   'trade',
    keys:    [],
    types:   { timestamp: 'timestamp', symbol: 'symbol', side: 'symbol', size: 'long', price: 'float', tickDirection: 'symbol', trdMatchID: 'guid', grossValue: 'long', homeNotional: 'float', foreignNotional: 'float', trdType: 'symbol', pool: 'symbol' },
    data:    [],
    counter: 1,
  },

  tradeBin1m: {
    table:   'tradeBin1m',
    keys:    [],
    types:   { timestamp: 'timestamp', symbol: 'symbol', open: 'float', high: 'float', low: 'float', close: 'float', trades: 'long', volume: 'long', vwap: 'float', lastSize: 'long', turnover: 'long', homeNotional: 'float', foreignNotional: 'float', pool: 'symbol' },
    data:    [],
    counter: 1,
  },

  tradeBin5m: {
    table:   'tradeBin5m',
    keys:    [],
    types:   { timestamp: 'timestamp', symbol: 'symbol', open: 'float', high: 'float', low: 'float', close: 'float', trades: 'long', volume: 'long', vwap: 'float', lastSize: 'long', turnover: 'long', homeNotional: 'float', foreignNotional: 'float', pool: 'symbol' },
    data:    [],
    counter: 1,
  },

  tradeBin1h: {
    table:   'tradeBin1h',
    keys:    [],
    types:   { timestamp: 'timestamp', symbol: 'symbol', open: 'float', high: 'float', low: 'float', close: 'float', trades: 'long', volume: 'long', vwap: 'float', lastSize: 'long', turnover: 'long', homeNotional: 'float', foreignNotional: 'float', pool: 'symbol' },
    data:    [],
    counter: 1,
  },

  tradeBin1d: {
    table:   'tradeBin1d',
    keys:    [],
    types:   { timestamp: 'timestamp', symbol: 'symbol', open: 'float', high: 'float', low: 'float', close: 'float', trades: 'long', volume: 'long', vwap: 'float', lastSize: 'long', turnover: 'long', homeNotional: 'float', foreignNotional: 'float', pool: 'symbol' },
    data:    [],
    counter: 1,
  },

  // ── Other symbol-optional ────────────────────────────────────────────────────

  liquidation: {
    table:   'liquidation',
    keys:    ['orderID'],
    types:   { orderID: 'guid', symbol: 'symbol', side: 'symbol', price: 'float', leavesQty: 'long' },
    data:    [],
    counter: 1,
  },

  instrument: {
    table:   'instrument',
    keys:    ['symbol'],
    types:   {
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
    data:    [],
    counter: 1,
  },

  funding: {
    table:   'funding',
    keys:    ['timestamp', 'symbol'],
    types:   { timestamp: 'timestamp', symbol: 'symbol', fundingInterval: 'timespan', fundingRate: 'float', fundingRateDaily: 'float' },
    data:    [],
    counter: 1,
  },

  settlement: {
    table:   'settlement',
    keys:    ['timestamp', 'symbol'],
    types:   { timestamp: 'timestamp', symbol: 'symbol', settlementType: 'symbol', settledPrice: 'float', optionStrikePrice: 'float', optionUnderlyingPrice: 'float', bankrupt: 'long', taxBase: 'long', taxRate: 'float' },
    data:    [],
    counter: 1,
  },

  // ── Symbol-N/A public tables (no `symbol` in types → always filter: {}) ──────

  insurance: {
    table:   'insurance',
    keys:    ['currency', 'timestamp'],
    types:   { currency: 'symbol', timestamp: 'timestamp', walletBalance: 'long' },
    data:    [],
    counter: 1,
  },

  announcement: {
    table:   'announcement',
    keys:    ['id'],
    types:   { id: 'integer', link: 'string', title: 'string', content: 'string', date: 'timestamp' },
    data:    [],
    counter: 1,
  },

  chat: {
    table:   'chat',
    keys:    ['id'],
    types:   { id: 'integer', date: 'timestamp', user: 'string', message: 'string', html: 'string', userColor: 'string' },
    data:    [],
    counter: 1,
  },

  connected: {
    table:   'connected',
    keys:    ['id'],
    types:   { id: 'integer', users: 'integer', bots: 'integer' },
    data:    [],
    counter: 1,
  },

  publicNotifications: {
    table:   'publicNotifications',
    keys:    ['id'],
    types:   { title: 'string', body: 'string', ttl: 'number', closable: 'boolean', persist: 'boolean', sound: 'string' },
    data:    [],
    counter: 1,
  },

  // ── Private tables (require auth — account filter) ───────────────────────────

  execution: {
    table:   'execution',
    keys:    [],
    types:   { execID: 'guid', orderID: 'guid', origClOrdID: 'symbol', clOrdID: '', clOrdLinkID: '', account: 'long', symbol: 'symbol', strategy: 'symbol', side: 'symbol', lastQty: 'long', lastPx: 'float', lastLiquidityInd: 'symbol', orderQty: 'long', price: 'float', displayQty: 'long', stopPx: 'float', pegOffsetValue: 'float', pegPriceType: 'symbol', currency: 'symbol', settlCurrency: 'symbol', execType: 'symbol', ordType: 'symbol', timeInForce: 'symbol', execInst: 'symbol', contingencyType: 'symbol', ordStatus: 'symbol', triggered: 'symbol', workingIndicator: 'boolean', ordRejReason: '', leavesQty: 'long', cumQty: 'long', avgPx: 'float', commission: 'float', brokerCommission: 'float', feeType: 'symbol', tradePublishIndicator: 'symbol', text: '', trdMatchID: 'guid', execCost: 'long', execComm: 'long', execCommCcy: 'symbol', brokerExecComm: 'long', homeNotional: 'float', foreignNotional: 'float', transactTime: 'timestamp', timestamp: 'timestamp', realisedPnl: 'long', trdType: 'symbol', maxSlippagePct: 'float', pool: 'symbol', destination: 'symbol', algoOrderDetails: 'object', error: 'symbol' },
    data:    [],
    counter: 1,
  },

  order: {
    table:   'order',
    keys:    ['orderID'],
    types:   { orderID: 'guid', clOrdID: 'string', clOrdLinkID: 'string', account: 'long', symbol: 'symbol', strategy: 'symbol', side: 'symbol', orderQty: 'long', price: 'float', displayQty: 'long', stopPx: 'float', pegOffsetValue: 'float', pegPriceType: 'symbol', currency: 'symbol', settlCurrency: 'symbol', ordType: 'symbol', timeInForce: 'symbol', execInst: 'symbol', contingencyType: 'symbol', ordStatus: 'symbol', triggered: 'symbol', workingIndicator: 'boolean', ordRejReason: 'string', leavesQty: 'long', cumQty: 'long', avgPx: 'float', text: 'string', transactTime: 'timestamp', timestamp: 'timestamp', parentOrderID: 'guid', maxSlippagePct: 'float', pool: 'symbol', destination: 'symbol', algoOrderDetails: 'object', error: 'symbol' },
    data:    [],
    counter: 1,
  },

  position: {
    table:   'position',
    keys:    ['account', 'symbol', 'strategy'],
    types:   { account: 'long', symbol: 'symbol', strategy: 'symbol', currency: 'symbol', underlying: 'symbol', quoteCurrency: 'symbol', commission: 'float', initMarginReq: 'float', maintMarginReq: 'float', riskLimit: 'long', leverage: 'float', crossMargin: 'boolean', deleveragePercentile: 'float', rebalancedPnl: 'long', prevRealisedPnl: 'long', prevUnrealisedPnl: 'long', openingQty: 'long', openOrderBuyQty: 'long', openOrderBuyCost: 'long', openOrderBuyPremium: 'long', openOrderSellQty: 'long', openOrderSellCost: 'long', openOrderSellPremium: 'long', currentQty: 'long', currentCost: 'long', currentComm: 'long', realisedCost: 'long', unrealisedCost: 'long', grossOpenPremium: 'long', isOpen: 'boolean', markPrice: 'float', markValue: 'long', riskValue: 'long', homeNotional: 'float', foreignNotional: 'float', posState: 'symbol', posCost: 'long', posCross: 'long', posComm: 'long', posLoss: 'long', posMargin: 'long', posMaint: 'long', posInit: 'long', initMargin: 'long', maintMargin: 'long', realisedPnl: 'long', unrealisedPnl: 'long', unrealisedPnlPcnt: 'float', unrealisedRoePcnt: 'float', avgCostPrice: 'float', avgEntryPrice: 'float', breakEvenPrice: 'float', marginCallPrice: 'float', liquidationPrice: 'float', bankruptPrice: 'float', timestamp: 'timestamp' },
    data:    [],
    counter: 1,
  },

  margin: {
    table:   'margin',
    keys:    ['account', 'currency'],
    types:   { account: 'long', currency: 'symbol', riskLimit: 'long', state: 'symbol', amount: 'long', prevRealisedPnl: 'long', grossComm: 'long', grossOpenCost: 'long', grossOpenPremium: 'long', grossExecCost: 'long', grossMarkValue: 'long', riskValue: 'long', initMargin: 'long', maintMargin: 'long', targetExcessMargin: 'long', realisedPnl: 'long', unrealisedPnl: 'long', isolatedUnrealisedPnl: 'long', walletBalance: 'long', marginBalance: 'long', marginLeverage: 'float', marginUsedPcnt: 'float', excessMargin: 'long', availableMargin: 'long', withdrawableMargin: 'long', systemWithdrawableMargin: 'long', makerFeeDiscount: 'float', takerFeeDiscount: 'float', timestamp: 'timestamp', foreignMarginBalance: 'long', foreignRequirement: 'long' },
    data:    [],
    counter: 1,
  },

  wallet: {
    table:   'wallet',
    keys:    ['account', 'currency'],
    types:   { account: 'long', currency: 'symbol', deposited: 'long', withdrawn: 'long', transferIn: 'long', transferOut: 'long', amount: 'long', pendingCredit: 'long', pendingDebit: 'long', confirmedDebit: 'long', timestamp: 'timestamp' },
    data:    [],
    counter: 1,
  },

  transact: {
    table:   'transact',
    keys:    ['transactID'],
    types:   { transactID: 'guid', account: 'long', currency: 'symbol', network: 'symbol', transactType: 'symbol', amount: 'long', walletBalance: 'long', fee: 'long', transactStatus: 'symbol', address: 'symbol', tx: 'symbol', orderID: 'guid', text: 'symbol', transactTime: 'timestamp', timestamp: 'timestamp', memo: 'symbol', subType: 'symbol' },
    data:    [],
    counter: 1,
  },

  affiliate: {
    table:   'affiliate',
    keys:    ['account', 'currency'],
    types:   { account: 'long', currency: 'symbol', prevPayout: 'long', prevTurnover: 'long', prevComm: 'long', prevTimestamp: 'timestamp', execTurnover: 'long', execComm: 'long', totalReferrals: 'long', totalTurnover: 'long', totalComm: 'long', payoutPcnt: 'float', pendingPayout: 'long', timestamp: 'timestamp' },
    data:    [],
    counter: 1,
  },

};
