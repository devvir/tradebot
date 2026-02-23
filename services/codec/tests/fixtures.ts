/**
 * Real unencoded document fixtures fetched from the database.
 * For encode→decode→verify testing: raw data → encode → decode → compare to raw.
 */

export const REAL_FIXTURES: Record<string, unknown> = {
  "chat": {
  "_id": "699a54afca24a063889cf9a6",
  "table": "chat",
  "action": "insert",
  "keys": [
    "id"
  ],
  "data": [
    {
      "channelID": 1,
      "date": "2026-02-22T00:58:23.673Z",
      "html": "Sunday doom? <img class=\"emoji\" src=\"/img/emoji/pepe.webp\"/>\n",
      "id": 74014374,
      "message": "Sunday doom? :pepe:",
      "user": "contract details",
      "userColor": "#76B900",
      "flair": [],
      "guild": {
        "name": "Beers, BTC and BMex - Cheers!",
        "emoji": "https://static.bitmex.com/emojis/rare-diamond-pepe.webp"
      }
    }
  ],
  "filterKey": "channelID"
},
  "instrument": {
  "_id": "699a541fca24a063889ba6c7",
  "table": "instrument",
  "action": "update",
  "data": [
    {
      "symbol": "XBTUSDT",
      "impactBidPrice": 67840.7,
      "impactMidPrice": 67847.5,
      "timestamp": "2026-02-22T00:55:58.403Z"
    }
  ]
},
  "trade": {
  "_id": "699a5420ca24a063889ba999",
  "table": "trade",
  "action": "insert",
  "data": [
    {
      "timestamp": "2026-02-22T00:56:00.000Z",
      "symbol": ".BAI16ZT_NEXT",
      "side": "Buy",
      "size": 0,
      "price": 0.0569,
      "tickDirection": "ZeroMinusTick",
      "trdType": "Referential"
    }
  ]
},
  "quote": {
  "_id": "699a541eca24a063889ba685",
  "table": "quote",
  "action": "insert",
  "data": [
    {
      "timestamp": "2026-02-22T00:55:57.903Z",
      "symbol": "BCHUSDT",
      "bidSize": 3727000,
      "bidPrice": 563.55,
      "askPrice": 563.6,
      "askSize": 1000
    }
  ]
},
  "settlement": null,
  "orderBookL2": {
  "_id": "699a5420ca24a063889ba8a6",
  "table": "orderBookL2",
  "action": "update",
  "data": [
    {
      "symbol": "ARBUSDT",
      "id": 186898796284,
      "side": "Buy",
      "size": 535200,
      "price": 0.088,
      "timestamp": "2026-02-22T00:55:59.948Z",
      "transactTime": "2026-02-22T00:55:59.943Z"
    }
  ]
},
  "publicNotifications": null,
  "funding": {
  "_id": "699a7f40ca24a063880c06a0",
  "table": "funding",
  "action": "insert",
  "data": [
    {
      "timestamp": "2026-02-22T04:00:00.000Z",
      "symbol": "FILUSD",
      "fundingInterval": "2000-01-01T08:00:00.000Z",
      "fundingRate": 0.0001,
      "fundingRateDaily": 0.00030000000000000003
    }
  ]
},
  "announcement": null,
  "liquidation": {
  "_id": "699a6907ca24a06388cf2aaa",
  "table": "liquidation",
  "action": "insert",
  "data": [
    {
      "orderID": "00000000-0063-1000-0000-000000041de0",
      "symbol": "XAUTUSDT",
      "side": "Sell",
      "price": 5102.08,
      "leavesQty": 800
    }
  ]
},
  "connected": {
  "_id": "699a542fca24a063889bd22d",
  "table": "connected",
  "action": "update",
  "data": [
    {
      "id": 0,
      "users": 1045,
      "bots": 19087
    }
  ]
},
  "insurance": null,
};
