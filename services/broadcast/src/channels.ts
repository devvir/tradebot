/**
 * BitMEX WebSocket Channel Definitions and Presets
 */

export const REALTIME_PRIMARY_CHANNELS = [
  'instrument',
  'orderBookL2',
  'quote',
  'trade',
] as const;

export const REALTIME_SECONDARY_CHANNELS = [
  'liquidation',
  'settlement',
  'funding',
  'insurance',
] as const;

export const REALTIME_REDUNDANT_CHANNELS = [
  'orderBookL2_25',
  'orderBook10',
  'quoteBin1m',
  'quoteBin5m',
  'quoteBin1h',
  'quoteBin1d',
  'tradeBin1m',
  'tradeBin5m',
  'tradeBin1h',
  'tradeBin1d',
] as const;

export const REALTIME_CHANNELS = [
  ...REALTIME_PRIMARY_CHANNELS,
  ...REALTIME_SECONDARY_CHANNELS,
  ...REALTIME_REDUNDANT_CHANNELS,
] as const;

export const PLATFORM_CHANNELS = [
  'announcement',
  'chat',
  'connected',
  'publicNotifications',
] as const;

export const REALTIME_CHANNEL_PRESETS = {
  none: [],
  core: [ 'quote', 'trade', 'orderBookL2_25' ],
  feed: REALTIME_CHANNELS,
  primary: REALTIME_PRIMARY_CHANNELS,
  secondary: REALTIME_SECONDARY_CHANNELS,
  redundant: REALTIME_REDUNDANT_CHANNELS,
  archive: [ ...REALTIME_PRIMARY_CHANNELS, ...REALTIME_SECONDARY_CHANNELS ],
} as const;

export type RealtimeChannelPreset = keyof typeof REALTIME_CHANNEL_PRESETS;
