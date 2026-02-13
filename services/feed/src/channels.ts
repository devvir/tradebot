/**
 * BitMEX WebSocket Channel Definitions
 * Source: https://www.bitmex.com/app/wsAPI
 */

/**
 * All known BitMEX WebSocket channels
 */
export const KNOWN_CHANNELS = [
  // Symbol-required channels - market data
  'orderBookL2',
  'quote',
  'quoteBin1m',
  'quoteBin5m',
  'quoteBin1h',
  'quoteBin1d',
  'trade',
  'tradeBin1m',
  'tradeBin5m',
  'tradeBin1h',
  'tradeBin1d',
  'liquidation',
  'instrument',
  'funding',
  'settlement',
  // Global channels - no symbol required
  'insurance',
  'announcement',
  'chat',
  'publicNotifications',
  'connected',
] as const;

/**
 * Channels that require a symbol parameter for subscription
 * All other channels are global or optional symbol, and don't require symbols
 */
export const SYMBOL_REQUIRED_CHANNELS = [
  'orderBookL2',
  'quote',
  'quoteBin1m',
  'quoteBin5m',
  'quoteBin1h',
  'quoteBin1d',
  'trade',
  'tradeBin1m',
  'tradeBin5m',
  'tradeBin1h',
  'tradeBin1d',
  'liquidation',
  'funding',
  'settlement',
] as const;

/**
 * Global channels that don't require a symbol parameter
 */
export const GLOBAL_CHANNELS = [
  'insurance',
  'announcement',
  'chat',
  'publicNotifications',
  'connected',
] as const;
