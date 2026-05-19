// Authoritative column lists per BitMEX table.
//
// Used by vault when initialising new CSV files (header row) and by the
// encoder when serialising rows into CSV — vault never infers columns from
// incoming data because WS updates only include changed fields.
//
// Sources:
//   - Vault files in /data/bitmex/vault  (observed, authoritative)
//   - journalist CHAT_SCHEMA             (chat has extra fields missing from the partial WS message)
//   - BitMEX OpenAPI + TABLE_SPECS       (tables not yet observed in vault)

export const TABLE_HEADERS: Record<string, string[]> = {

  // ── From BitMEX REST API ────────────────────────────────────────────────────

  funding:        ['timestamp', 'symbol', 'fundingInterval', 'fundingRate', 'fundingRateDaily'],
  insurance:      ['currency', 'timestamp', 'walletBalance'],
  settlement:     ['timestamp', 'symbol', 'settlementType', 'settledPrice', 'optionStrikePrice', 'optionUnderlyingPrice', 'bankrupt', 'taxBase', 'taxRate'],
  compositeIndex: ['timestamp', 'symbol', 'indexSymbol', 'indexMultiplier', 'reference', 'lastPrice', 'sourcePrice', 'conversionIndex', 'conversionIndexPrice', 'weight', 'logged'],
  tick:           ['timestamp', 'symbol', 'price', 'tickDirection'],

  // ── Streamed from BitMEX WebSocket ─────────────────────────────────────────
  //
  // WS table rows are stored with two metadata columns at the start:
  //   _date_   — ISO timestamp of the message (set on the first row of each
  //              message only; empty on continuation rows within the message)
  //   _action_ — BitMEX action for the message (partial / insert / update / delete)
  //
  // A non-empty _date_ marks the start of a new message group on both write
  // and read. Continuation rows within the same message have an empty _date_.

  announcement:        [ '_date_', '_action_', 'id', 'link', 'title', 'content', 'date' ],
  chat:                [ '_date_', '_action_', 'channelID', 'date', 'html', 'id', 'message', 'user', 'userColor', 'flair', 'guild' ],
  connected:           [ '_date_', '_action_', 'id', 'users', 'bots' ],
  instrument:          [
    '_date_', '_action_', 'symbol', 'rootSymbol', 'instrumentID', 'state', 'typ', 'listing', 'front', 'expiry', 'settle',
    'listedSettle', 'relistInterval', 'positionCurrency', 'underlying', 'quoteCurrency', 'underlyingSymbol', 'reference',
    'referenceSymbol', 'calcInterval', 'publishInterval', 'publishTime', 'maxOrderQty', 'minPrice', 'maxPrice', 'lotSize', 'tickSize',
    'multiplier', 'settlCurrency', 'underlyingToPositionMultiplier', 'underlyingToSettleMultiplier', 'quoteToSettleMultiplier',
    'isQuanto', 'isInverse', 'initMargin', 'maintMargin', 'riskLimit', 'riskStep', 'limit', 'taxed', 'deleverage', 'makerFee',
    'takerFee', 'settlementFee', 'fundingBaseSymbol', 'fundingQuoteSymbol', 'fundingPremiumSymbol', 'fundingTimestamp',
    'fundingInterval', 'fundingRate', 'indicativeFundingRate', 'rebalanceTimestamp', 'rebalanceInterval', 'launchingTimestamp',
    'prevClosePrice', 'limitDownPrice', 'limitUpPrice', 'prevTotalVolume', 'totalVolume', 'volume', 'volume24h', 'prevTotalTurnover',
    'totalTurnover', 'turnover', 'turnover24h', 'homeNotional24h', 'foreignNotional24h', 'prevPrice24h', 'vwap', 'highPrice',
    'lowPrice', 'lastPrice', 'lastPriceProtected', 'lastTickDirection', 'lastChangePcnt', 'bidPrice', 'midPrice', 'askPrice',
    'impactBidPrice', 'impactMidPrice', 'impactAskPrice', 'hasLiquidity', 'openInterest', 'openValue', 'fairMethod', 'fairBasisRate',
    'fairBasis', 'fairPrice', 'markMethod', 'markPrice', 'referencePrice', 'indicativeSettlePrice', 'settledPriceAdjustmentRate',
    'settledPrice', 'instantPnl', 'minTick', 'fundingBaseRate', 'fundingQuoteRate', 'farLegSymbol', 'nearLegSymbol', 'timestamp',
  ],
  liquidation:         [ '_date_', '_action_', 'orderID', 'symbol', 'side', 'price', 'leavesQty' ],
  orderBookL2:         [ '_date_', '_action_', 'symbol', 'id', 'side', 'size', 'price', 'transactTime', 'timestamp', 'pool' ],
  publicNotifications: [ '_date_', '_action_', 'title', 'body', 'ttl', 'closable', 'persist', 'sound' ],
};
