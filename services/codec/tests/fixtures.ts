import type {
  BitmexPartial,
  BitmexInsert,
  BitmexUpdate,
  BitmexDelete,
  OrderBookL2Data,
  QuoteData,
  QuoteBinData,
  TradeData,
  TradeBinData,
  LiquidationData,
  InstrumentData,
  FundingData,
  SettlementData,
  InsuranceData,
} from '../src/types';

// Pending Review
// Auto-generated BitMEX WebSocket message fixtures
// Each export contains real messages from MongoDB, untouched except for trimming data arrays to max 3 items
//
// Observed combinations (as of 2026-02-15):
// ✓ = observed, ? = not yet observed
//
// Table          | partial | insert | update | delete |
// ---------------|---------|--------|--------|--------|
// orderBookL2    |    ✓    |   ✓    |   ✓    |   ✓    |
// quote          |    ✓    |   ✓    |   ✗    |   ✗    |
// quoteBin1m     |    ✓    |   ✓    |   ?    |   ✗    |
// trade          |    ✓    |   ✓    |   ?    |   ?    |
// tradeBin1m     |    ✓    |   ✓    |   ?    |   ✗    |
// liquidation    |    ✓    |   ✓    |   ?    |   ✓    |
// instrument     |    ✓    |   ?    |   ✓    |   ?    |
// funding        |    ✓    |   ✓    |   ?    |   ✗    |
// settlement     |    ✓    |   ?    |   ?    |   ?    |
// insurance      |    ✓    |   ?    |   ?    |   ?    |
//
// Notes:
// - sample liquidation partial has empty data array (Ø)
// - ✗ means we are fairly certain the action does not exist

export const orderBookL2_XBTUSD_partial: BitmexPartial<OrderBookL2Data> = {
    "table": "orderBookL2",
    "action": "partial",
    "keys": [
      "symbol",
      "id",
      "side"
    ],
    "types": {
      "symbol": "symbol",
      "id": "long",
      "side": "symbol",
      "size": "long",
      "price": "float",
      "pool": "symbol",
      "timestamp": "timestamp",
      "transactTime": "timestamp"
    },
    "filter": {
      "symbol": "XBTUSD"
    },
    "data": [
      {
        "symbol": "XBTUSD",
        "id": 1000330,
        "side": "Sell",
        "size": 1000000,
        "price": 1000000,
        "timestamp": "2026-02-15T19:27:36.063Z",
        "transactTime": "2026-02-15T02:00:00.001Z"
      },
      {
        "symbol": "XBTUSD",
        "id": 25039222234,
        "side": "Sell",
        "size": 33800,
        "price": 676700,
        "timestamp": "2026-02-15T19:27:36.063Z",
        "transactTime": "2026-02-15T02:00:00.001Z"
      },
      {
        "symbol": "XBTUSD",
        "id": 1000294,
        "side": "Sell",
        "size": 10000,
        "price": 662520,
        "timestamp": "2026-02-15T19:27:36.063Z",
        "transactTime": "2026-02-15T02:00:00.001Z"
      }
    ],
    "_apiVersion": "2.0.0",
  };

export const orderBookL2_XBTUSD_insert: BitmexInsert<OrderBookL2Data> = {
    "table": "orderBookL2",
    "action": "insert",
    "data": [
      {
        "symbol": "XBTUSD",
        "id": 185239004940,
        "side": "Sell",
        "size": 100,
        "price": 68460.7,
        "timestamp": "2026-02-15T19:27:36.124Z",
        "transactTime": "2026-02-15T19:27:36.116Z"
      },
      {
        "symbol": "XBTUSD",
        "id": 185239004744,
        "side": "Buy",
        "size": 1500,
        "price": 68433.2,
        "timestamp": "2026-02-15T19:27:36.124Z",
        "transactTime": "2026-02-15T19:27:36.063Z"
      },
      {
        "symbol": "XBTUSD",
        "id": 185239004865,
        "side": "Buy",
        "size": 56000,
        "price": 68407.5,
        "timestamp": "2026-02-15T19:27:36.124Z",
        "transactTime": "2026-02-15T19:27:36.087Z"
      }
    ],
    "_apiVersion": "2.0.0",
  };

export const orderBookL2_XBTUSD_update: BitmexUpdate<OrderBookL2Data> = {
    "table": "orderBookL2",
    "action": "update",
    "data": [
      {
        "symbol": "XBTUSD",
        "id": 185239000272,
        "side": "Sell",
        "size": 6100,
        "price": 68460.6,
        "timestamp": "2026-02-15T19:27:36.124Z",
        "transactTime": "2026-02-15T19:27:36.116Z"
      },
      {
        "symbol": "XBTUSD",
        "id": 185238996228,
        "side": "Buy",
        "size": 9600,
        "price": 68414,
        "timestamp": "2026-02-15T19:27:36.124Z",
        "transactTime": "2026-02-15T19:27:36.073Z"
      }
    ],
    "_apiVersion": "2.0.0",
  };

export const orderBookL2_XBTUSD_delete: BitmexDelete<OrderBookL2Data> = {
    "table": "orderBookL2",
    "action": "delete",
    "data": [
      {
        "symbol": "XBTUSD",
        "id": 185239001643,
        "side": "Buy",
        "price": 68398.6,
        "timestamp": "2026-02-15T19:27:36.075Z",
        "transactTime": "2026-02-15T19:27:36.025Z"
      },
      {
        "symbol": "XBTUSD",
        "id": 185239002998,
        "side": "Buy",
        "price": 68400.9,
        "timestamp": "2026-02-15T19:27:36.075Z",
        "transactTime": "2026-02-15T19:27:36.028Z"
      }
    ],
    "_apiVersion": "2.0.0",
  };

export const quote_XBTUSD_partial: BitmexPartial<QuoteData> = {
    "table": "quote",
    "action": "partial",
    "keys": [],
    "types": {
      "timestamp": "timestamp",
      "symbol": "symbol",
      "bidSize": "long",
      "bidPrice": "float",
      "askPrice": "float",
      "askSize": "long",
      "pool": "symbol"
    },
    "filter": {
      "symbol": "XBTUSD"
    },
    "data": [
      {
        "timestamp": "2026-02-15T19:27:39.051Z",
        "symbol": "XBTUSD",
        "bidSize": 6600,
        "bidPrice": 68443.8,
        "askPrice": 68457,
        "askSize": 900
      }
    ],
    "_apiVersion": "2.0.0",
  };

export const quote_XBTUSD_insert: BitmexInsert<QuoteData> = {
    "table": "quote",
    "action": "insert",
    "data": [
      {
        "timestamp": "2026-02-15T19:27:39.101Z",
        "symbol": "XBTUSD",
        "bidSize": 500,
        "bidPrice": 68443.8,
        "askPrice": 68457,
        "askSize": 900
      }
    ],
    "_apiVersion": "2.0.0",
  };

export const quoteBin1m_partial: BitmexPartial<QuoteBinData> = {
    "table": "quoteBin1m",
    "action": "partial",
    "keys": [],
    "types": {
      "timestamp": "timestamp",
      "symbol": "symbol",
      "bidSize": "long",
      "bidPrice": "float",
      "askPrice": "float",
      "askSize": "long",
      "pool": "symbol"
    },
    "filter": {
      "symbol": "SOLUSD"
    },
    "data": [
      {
        "timestamp": "2026-02-15T19:27:00.000Z",
        "symbol": "SOLUSD",
        "bidSize": 434,
        "bidPrice": 86.09,
        "askPrice": 86.19,
        "askSize": 84
      }
    ],
    "_apiVersion": "2.0.0",
  };

export const quoteBin1m_insert: BitmexInsert<QuoteBinData> = {
    "table": "quoteBin1m",
    "action": "insert",
    "data": [
      {
        "timestamp": "2026-02-15T19:28:00.000Z",
        "symbol": "WLFIUSDT",
        "bidSize": 20646210,
        "bidPrice": 0.10183,
        "askPrice": 0.10189,
        "askSize": 20646210
      }
    ],
    "_apiVersion": "2.0.0",
  };

export const trade_XBTUSD_partial: BitmexPartial<TradeData> = {
    "table": "trade",
    "action": "partial",
    "keys": [],
    "types": {
      "timestamp": "timestamp",
      "symbol": "symbol",
      "side": "symbol",
      "size": "long",
      "price": "float",
      "tickDirection": "symbol",
      "trdMatchID": "guid",
      "grossValue": "long",
      "homeNotional": "float",
      "foreignNotional": "float",
      "trdType": "symbol",
      "pool": "symbol"
    },
    "filter": {
      "symbol": "XBTUSD"
    },
    "data": [
      {
        "timestamp": "2026-02-15T19:27:33.574Z",
        "symbol": "XBTUSD",
        "side": "Sell",
        "size": 200,
        "price": 68440,
        "tickDirection": "MinusTick",
        "trdMatchID": "00000000-006d-1000-0000-002b210b79c4",
        "grossValue": 292226,
        "homeNotional": 0.00292226,
        "foreignNotional": 200,
        "trdType": "Regular"
      }
    ],
    "_apiVersion": "2.0.0",
  };

export const trade_XBTUSD_insert: BitmexInsert<TradeData> = {
    "table": "trade",
    "action": "insert",
    "data": [
      {
        "timestamp": "2026-02-15T19:27:47.873Z",
        "symbol": "XBTUSD",
        "side": "Buy",
        "size": 200,
        "price": 68460,
        "tickDirection": "PlusTick",
        "trdMatchID": "00000000-006d-1000-0000-002b210c305a",
        "grossValue": 292142,
        "homeNotional": 0.00292142,
        "foreignNotional": 200,
        "trdType": "Regular"
      },
      {
        "timestamp": "2026-02-15T19:27:47.873Z",
        "symbol": "XBTUSD",
        "side": "Buy",
        "size": 3500,
        "price": 68460,
        "tickDirection": "ZeroPlusTick",
        "trdMatchID": "00000000-006d-1000-0000-002b210c305d",
        "grossValue": 5112485,
        "homeNotional": 0.05112485,
        "foreignNotional": 3500,
        "trdType": "Regular"
      }
    ],
    "_apiVersion": "2.0.0",
  };

export const tradeBin1m_partial: BitmexPartial<TradeBinData> = {
      "table": "tradeBin1m",
    "action": "partial",
    "keys": [],
    "types": {
      "timestamp": "timestamp",
      "symbol": "symbol",
      "open": "float",
      "high": "float",
      "low": "float",
      "close": "float",
      "trades": "long",
      "volume": "long",
      "vwap": "float",
      "lastSize": "long",
      "turnover": "long",
      "homeNotional": "float",
      "foreignNotional": "float",
      "pool": "symbol"
    },
    "filter": {
      "symbol": "LINKUSD"
    },
    "data": [
      {
        "timestamp": "2026-02-15T19:27:00.000Z",
        "symbol": "LINKUSD",
        "open": 8.665,
        "high": 8.665,
        "low": 8.665,
        "close": 8.665,
        "trades": 0,
        "volume": 0,
        "turnover": 0,
        "homeNotional": 0,
        "foreignNotional": 0
      }
    ],
    "_apiVersion": "2.0.0",
      };

  export const tradeBin1m_insert: BitmexInsert<TradeBinData> = {
    "table": "tradeBin1m",
    "action": "insert",
    "data": [
      {
        "timestamp": "2026-02-15T19:28:00.000Z",
        "symbol": "SOLUSDT",
        "open": 86.07,
        "high": 86.07,
        "low": 86.04,
        "close": 86.04,
        "trades": 10,
        "volume": 3589800,
        "vwap": 86.0658,
        "lastSize": 51100,
        "turnover": 30895881900,
        "homeNotional": 358.97999999999996,
        "foreignNotional": 30895.881899999997
      }
    ],
    "_apiVersion": "2.0.0",
  };

export const liquidation_partial: BitmexPartial<LiquidationData> = {
      "table": "liquidation",
    "action": "partial",
    "keys": [
      "orderID"
    ],
    "types": {
      "orderID": "guid",
      "symbol": "symbol",
      "side": "symbol",
      "price": "float",
      "leavesQty": "long"
    },
    "filter": {},
    "data": [],
    "_apiVersion": "2.0.0",
  };

export const liquidation_insert: BitmexInsert<LiquidationData> = {
    "table": "liquidation",
    "action": "insert",
    "data": [
      {
        "orderID": "00000000-0063-1000-0000-00000004155c",
        "symbol": "ETHUSD",
        "side": "Buy",
        "price": 1959.85,
        "leavesQty": 98
      }
    ],
    "_apiVersion": "2.0.0",
  };

export const liquidation_delete: BitmexDelete<LiquidationData> = {
    "table": "liquidation",
    "action": "delete",
    "data": [
      {
        "orderID": "00000000-0063-1000-0000-00000004155c",
        "symbol": "ETHUSD",
        "side": "Buy",
        "price": 1959.85,
        "leavesQty": 98
      }
    ],
    "_apiVersion": "2.0.0",
  };

export const instrument_partial: BitmexPartial<InstrumentData> = {
    "table": "instrument",
    "action": "partial",
    "keys": [
      "symbol"
    ],
    "types": {
      "symbol": "symbol",
      "rootSymbol": "symbol",
      "state": "symbol",
      "typ": "symbol",
      "listing": "timestamp",
      "front": "timestamp",
      "expiry": "timestamp",
      "settle": "timestamp",
      "listedSettle": "timestamp",
      "relistInterval": "timespan",
      "positionCurrency": "symbol",
      "underlying": "symbol",
      "quoteCurrency": "symbol",
      "underlyingSymbol": "symbol",
      "reference": "symbol",
      "referenceSymbol": "symbol",
      "calcInterval": "timespan",
      "publishInterval": "timespan",
      "publishTime": "timespan",
      "maxOrderQty": "long",
      "minPrice": "float",
      "maxPrice": "float",
      "lotSize": "long",
      "tickSize": "float",
      "multiplier": "long",
      "settlCurrency": "symbol",
      "underlyingToPositionMultiplier": "long",
      "underlyingToSettleMultiplier": "long",
      "quoteToSettleMultiplier": "long",
      "isQuanto": "boolean",
      "isInverse": "boolean",
      "initMargin": "float",
      "maintMargin": "float",
      "riskLimit": "long",
      "riskStep": "long",
      "limit": "float",
      "taxed": "boolean",
      "deleverage": "boolean",
      "makerFee": "float",
      "takerFee": "float",
      "settlementFee": "float",
      "fundingBaseSymbol": "symbol",
      "fundingQuoteSymbol": "symbol",
      "fundingPremiumSymbol": "symbol",
      "fundingTimestamp": "timestamp",
      "fundingInterval": "timespan",
      "fundingRate": "float",
      "indicativeFundingRate": "float",
      "rebalanceTimestamp": "timestamp",
      "rebalanceInterval": "timespan",
      "launchingTimestamp": "timestamp",
      "prevClosePrice": "float",
      "limitDownPrice": "float",
      "limitUpPrice": "float",
      "prevTotalVolume": "long",
      "totalVolume": "long",
      "volume": "long",
      "volume24h": "long",
      "prevTotalTurnover": "long",
      "totalTurnover": "long",
      "turnover": "long",
      "turnover24h": "long",
      "homeNotional24h": "float",
      "foreignNotional24h": "float",
      "prevPrice24h": "float",
      "vwap": "float",
      "highPrice": "float",
      "lowPrice": "float",
      "lastPrice": "float",
      "lastPriceProtected": "float",
      "lastTickDirection": "symbol",
      "lastChangePcnt": "float",
      "bidPrice": "float",
      "midPrice": "float",
      "askPrice": "float",
      "impactBidPrice": "float",
      "impactMidPrice": "float",
      "impactAskPrice": "float",
      "hasLiquidity": "boolean",
      "openInterest": "long",
      "openValue": "long",
      "fairMethod": "symbol",
      "fairBasisRate": "float",
      "fairBasis": "float",
      "fairPrice": "float",
      "markMethod": "symbol",
      "markPrice": "float",
      "indicativeSettlePrice": "float",
      "settledPriceAdjustmentRate": "float",
      "settledPrice": "float",
      "instantPnl": "boolean",
      "minTick": "float",
      "fundingBaseRate": "float",
      "fundingQuoteRate": "float",
      "farLegSymbol": "symbol",
      "nearLegSymbol": "symbol",
      "timestamp": "timestamp"
    },
    "filter": {},
    "data": [
      {
        "symbol": ".BPENGUT_NEXT",
        "rootSymbol": "PENGU",
        "state": "Unlisted",
        "typ": "MRCXXX",
        "underlying": "PENGU",
        "quoteCurrency": "USDT",
        "underlyingSymbol": "PENGUT=",
        "reference": "BMI",
        "referenceSymbol": ".BPENGUT_NEXT",
        "publishInterval": "2000-01-01T00:01:00.000Z",
        "minPrice": 0.000001,
        "tickSize": 0.000001,
        "isQuanto": false,
        "isInverse": false,
        "taxed": false,
        "deleverage": false,
        "volume24h": 0,
        "turnover24h": 0,
        "homeNotional24h": 0,
        "foreignNotional24h": 0,
        "prevPrice24h": 0.00791,
        "highPrice": 0.008176,
        "lowPrice": 0.006924,
        "lastPrice": 0.007007,
        "lastChangePcnt": -0.1142,
        "hasLiquidity": false,
        "markMethod": "LastPrice",
        "markPrice": 0.007007,
        "instantPnl": false,
        "timestamp": "2026-02-15T19:27:35.000Z"
      },
      {
        "symbol": ".BBCHXBT_NEXT",
        "rootSymbol": "BCH",
        "state": "Unlisted",
        "typ": "MRCXXX",
        "underlying": "BCH",
        "quoteCurrency": "XBT",
        "underlyingSymbol": "BCHXBT=",
        "reference": "BMI",
        "referenceSymbol": ".BBCHXBT_NEXT",
        "publishInterval": "2000-01-01T00:01:00.000Z",
        "minPrice": 0.000001,
        "tickSize": 0.000001,
        "isQuanto": false,
        "isInverse": false,
        "taxed": false,
        "deleverage": false,
        "volume24h": 0,
        "turnover24h": 0,
        "homeNotional24h": 0,
        "foreignNotional24h": 0,
        "prevPrice24h": 0.008145,
        "highPrice": 0.008152,
        "lowPrice": 0.007912,
        "lastPrice": 0.008118,
        "lastTickDirection": "ZeroPlusTick",
        "lastChangePcnt": -0.0033,
        "hasLiquidity": false,
        "openValue": 0,
        "markMethod": "LastPrice",
        "markPrice": 0.008118,
        "instantPnl": false,
        "timestamp": "2026-02-15T19:27:25.000Z"
      },
      {
        "symbol": ".BDOTT30M",
        "rootSymbol": "DOT",
        "state": "Unlisted",
        "typ": "MRCXXX",
        "underlying": "DOT",
        "quoteCurrency": "USDT",
        "underlyingSymbol": ".BDOTT30M",
        "reference": "BMI",
        "referenceSymbol": ".BDOTT",
        "calcInterval": "2000-01-01T00:30:00.000Z",
        "publishInterval": "2000-01-01T04:00:00.000Z",
        "publishTime": "2000-01-01T12:00:00.000Z",
        "minPrice": 0.0001,
        "tickSize": 0.0001,
        "isQuanto": false,
        "isInverse": false,
        "taxed": false,
        "deleverage": false,
        "volume24h": 0,
        "turnover24h": 0,
        "homeNotional24h": 0,
        "foreignNotional24h": 0,
        "prevPrice24h": 1.3913,
        "highPrice": 1.4327,
        "lowPrice": 1.3667,
        "lastPrice": 1.3667,
        "lastTickDirection": "PlusTick",
        "lastChangePcnt": -0.0039,
        "hasLiquidity": false,
        "openValue": 0,
        "markMethod": "LastPrice",
        "markPrice": 1.3667,
        "instantPnl": false,
        "timestamp": "2026-02-15T16:00:15.064Z"
      }
    ],
    "_apiVersion": "2.0.0",
  };

export const instrument_update: BitmexUpdate<InstrumentData> = {
    "table": "instrument",
    "action": "update",
    "data": [
      {
        "symbol": "ETHUSD",
        "bidPrice": 1950.15,
        "midPrice": 1950.855,
        "askPrice": 1951.56,
        "impactBidPrice": 1950.02,
        "impactMidPrice": 1950.845,
        "impactAskPrice": 1951.67,
        "timestamp": "2026-02-15T19:27:38.368Z"
      }
    ],
    "_apiVersion": "2.0.0",
  };

export const funding_partial: BitmexPartial<FundingData> = {
      "table": "funding",
    "action": "partial",
    "keys": [
      "timestamp",
      "symbol"
    ],
    "types": {
      "timestamp": "timestamp",
      "symbol": "symbol",
      "fundingInterval": "timespan",
      "fundingRate": "float",
      "fundingRateDaily": "float"
    },
    "filter": {
      "symbol": "SUIUSDT"
    },
    "data": [
      {
        "timestamp": "2026-02-15T12:00:00.000Z",
        "symbol": "SUIUSDT",
        "fundingInterval": "2000-01-01T08:00:00.000Z",
        "fundingRate": -0.000223,
        "fundingRateDaily": -0.000669
      }
    ],
    "_apiVersion": "2.0.0",
  };

export const funding_insert: BitmexInsert<FundingData> = {
    "table": "funding",
    "action": "insert",
    "data": [
      {
        "timestamp": "2026-02-15T20:00:00.000Z",
        "symbol": "FILUSD",
        "fundingInterval": "2000-01-01T08:00:00.000Z",
        "fundingRate": 0.0001,
        "fundingRateDaily": 0.00030000000000000003
      }
    ],
    "_apiVersion": "2.0.0",
  };

export const settlement_partial: BitmexPartial<SettlementData> = {
    "table": "settlement",
    "action": "partial",
    "keys": [
      "timestamp",
      "symbol"
    ],
    "types": {
      "timestamp": "timestamp",
      "symbol": "symbol",
      "settlementType": "symbol",
      "settledPrice": "float",
      "optionStrikePrice": "float",
      "optionUnderlyingPrice": "float",
      "bankrupt": "long",
      "taxBase": "long",
      "taxRate": "float"
    },
    "filter": {
      "symbol": "DOGEUSDT"
    },
    "data": [
      {
        "timestamp": "2021-10-13T12:00:00.000Z",
        "symbol": "DOGEUSDT",
        "settlementType": "Settlement",
        "settledPrice": 0.22391
      }
    ],
    "_apiVersion": "2.0.0",
  };

export const insurance_partial: BitmexPartial<InsuranceData> = {
    "table": "insurance",
    "action": "partial",
    "keys": [
      "currency",
      "timestamp"
    ],
    "types": {
      "currency": "symbol",
      "timestamp": "timestamp",
      "walletBalance": "long"
    },
    "filter": {},
    "data": [
      {
        "currency": "Gwei",
        "timestamp": "2026-02-15T12:00:00.000Z",
        "walletBalance": 0
      },
      {
        "currency": "USD",
        "timestamp": "2026-02-15T12:00:00.000Z",
        "walletBalance": 33791558
      },
      {
        "currency": "USDe",
        "timestamp": "2026-02-15T12:00:00.000Z",
        "walletBalance": 0
      }
    ],
    "_apiVersion": "2.0.0",
};
