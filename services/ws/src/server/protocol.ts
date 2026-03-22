import type { SubscribeOp } from '../types';

export const parseArg = (arg: string): { table: string; symbol: string } => {
  const colon = arg.indexOf(':');
  if (colon === -1) return { table: arg, symbol: '_' };
  return { table: arg.slice(0, colon), symbol: arg.slice(colon + 1) };
};

export const welcome = (): string =>
  JSON.stringify({
    info:             'Welcome to the BitMEX Realtime API.',
    version:          '2.0.0',
    timestamp:        new Date().toISOString(),
    docs:             'https://www.bitmex.com/app/wsAPI',
    heartbeatEnabled: false,
    limit:            { remaining: 179 },
    appName:          'TradeBOT',
  });

export const subscribeAck = (arg: string, request: SubscribeOp): string =>
  JSON.stringify({ success: true, subscribe: arg, request });

export const unsubscribeAck = (arg: string, request: SubscribeOp): string =>
  JSON.stringify({ success: true, unsubscribe: arg, request });
