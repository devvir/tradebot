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
