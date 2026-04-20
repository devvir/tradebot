export const orderbookData = {
  bids: [
    { price: 68940.2, size: 1500, sum: 45000, time: '12:34:56' },
    { price: 68938.5, size: 2100, sum: 43500, time: '12:34:55' },
    { price: 68936.0, size: 1800, sum: 41400, time: '12:34:54' },
    { price: 68933.5, size: 2500, sum: 39600, time: '12:34:53' },
    { price: 68930.0, size: 1200, sum: 37100, time: '12:34:52' },
    { price: 68928.3, size: 1900, sum: 35900, time: '12:34:51' },
    { price: 68925.0, size: 2200, sum: 34000, time: '12:34:50' },
    { price: 68920.5, size: 1600, sum: 31800, time: '12:34:49' },
  ],
  asks: [
    { price: 68942.0, size: 1700, sum: 45000, time: '12:34:56' },
    { price: 68944.5, size: 2300, sum: 43300, time: '12:34:55' },
    { price: 68947.0, size: 2000, sum: 41000, time: '12:34:54' },
    { price: 68950.0, size: 2600, sum: 39000, time: '12:34:53' },
    { price: 68953.5, size: 1400, sum: 36400, time: '12:34:52' },
    { price: 68956.0, size: 2100, sum: 35000, time: '12:34:51' },
    { price: 68959.5, size: 1900, sum: 32900, time: '12:34:50' },
    { price: 68965.0, size: 2400, sum: 31000, time: '12:34:49' },
  ],
};

export const recentTradesData = [
  { price: 68941.5, size: 243,  time: '12:34:58', side: 'buy' },
  { price: 68941.0, size: 156,  time: '12:34:57', side: 'sell' },
  { price: 68940.8, size: 512,  time: '12:34:56', side: 'buy' },
  { price: 68940.2, size: 789,  time: '12:34:55', side: 'sell' },
  { price: 68939.5, size: 421,  time: '12:34:54', side: 'buy' },
  { price: 68938.0, size: 667,  time: '12:34:53', side: 'sell' },
  { price: 68937.5, size: 334,  time: '12:34:52', side: 'buy' },
  { price: 68936.8, size: 923,  time: '12:34:51', side: 'sell' },
  { price: 68936.2, size: 555,  time: '12:34:50', side: 'buy' },
  { price: 68935.0, size: 801,  time: '12:34:49', side: 'sell' },
];

export const positionsData = [
  {
    symbol: 'XBTUSD',
    side: 'Long',
    size: 250,
    entryPrice: 68820.5,
    currentPrice: 68940.2,
    unrealizedPnl: 29.875,
    unrealizedPnlPct: 0.17,
    leverage: 5,
    liquidationPrice: 67200.0,
  },
  {
    symbol: 'ETHUSD',
    side: 'Short',
    size: 500,
    entryPrice: 3150.0,
    currentPrice: 3120.5,
    unrealizedPnl: 14.75,
    unrealizedPnlPct: 0.47,
    leverage: 3,
    liquidationPrice: 3380.0,
  },
];

export const activeOrdersData = [
  { symbol: 'XBTUSD', side: 'Buy',  price: 68500.0, quantity: 100, filled: 0,   status: 'Open' },
  { symbol: 'XBTUSD', side: 'Sell', price: 69200.0, quantity: 50,  filled: 0,   status: 'Open' },
  { symbol: 'ETHUSD', side: 'Buy',  price: 3000.0,  quantity: 200, filled: 100, status: 'PartiallyFilled' },
];

export const orderHistoryData = [
  { symbol: 'XBTUSD', side: 'Buy',  price: 68300.0, quantity: 75,  filled: 75,  status: 'Filled' },
  { symbol: 'XBTUSD', side: 'Sell', price: 69100.0, quantity: 150, filled: 150, status: 'Filled' },
  { symbol: 'ETHUSD', side: 'Buy',  price: 3050.0,  quantity: 100, filled: 0,   status: 'Canceled' },
  { symbol: 'XBTUSD', side: 'Buy',  price: 68000.0, quantity: 200, filled: 200, status: 'Filled' },
];

export const tradeHistoryData = [
  { symbol: 'XBTUSD', side: 'Buy',  price: 68300.0, quantity: 75,  pnl: 450.25  },
  { symbol: 'XBTUSD', side: 'Sell', price: 69100.0, quantity: 150, pnl: 1200.75 },
  { symbol: 'ETHUSD', side: 'Buy',  price: 3150.0,  quantity: 250, pnl: -125.50 },
  { symbol: 'XBTUSD', side: 'Buy',  price: 68000.0, quantity: 200, pnl: 750.00  },
  { symbol: 'XBTUSD', side: 'Sell', price: 68500.0, quantity: 100, pnl: 320.50  },
];

export const marginData = {
  initialMargin:     245.30,
  maintenanceMargin: 122.65,
  availableMargin:   1254.70,
  usedMargin:        245.30,
  walletBalance:     1500.0,
};
