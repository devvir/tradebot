// BitMEX WebSocket channel definitions and presets.
// See docs/BitMEX/WS_TABLES.md for full channel documentation.

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

export const ARCHIVE_CHANNELS = [
  'announcement',
  'chat',
  'connected',
  'instrument',
  'liquidation',
  'orderBookL2',
  'publicNotifications',
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

/**
 * Channels whose *default* (unfiltered) subscription streams the fused
 * `Aggregated` pool, so their per-pool data can only be obtained by subscribing
 * with an explicit pool filter (`::Primary`/`::Secondary`). Verified against the
 * live WS: books emit only `Aggregated`; bins emit a mix that includes it.
 *
 * `trade`/`quote` are deliberately absent — their default already tags every row
 * `Primary`/`Secondary` (never `Aggregated`), so they collect unfiltered.
 * `instrument` carries no pool in the feed at all.
 */
export const POOL_FANOUT_CHANNELS = [
  'orderBookL2', 'orderBookL2_25', 'orderBook10',
  'tradeBin1m', 'tradeBin5m', 'tradeBin1h', 'tradeBin1d',
  'quoteBin1m', 'quoteBin5m', 'quoteBin1h', 'quoteBin1d',
] as const;

export const PLATFORM_CHANNELS = [
  'announcement',
  'chat',
  'connected',
  'publicNotifications',
] as const;

export const PRIVATE_CHANNELS = [
  'execution', 'order', 'transact',
  'position', 'margin', 'wallet',
  'affiliate', 'privateNotifications',
  /** Undocumented private channels */
  'csastate', 'isolation', 'leverage', 'mamAllocation', 'voucher',
] as const;

export const CHANNEL_PRESETS = {
  none: [],
  core: REALTIME_PRIMARY_CHANNELS,
  feed: REALTIME_CHANNELS,
  archive: ARCHIVE_CHANNELS,
  primary: REALTIME_PRIMARY_CHANNELS,
  secondary: REALTIME_SECONDARY_CHANNELS,
  redundant: REALTIME_REDUNDANT_CHANNELS,
  platform: PLATFORM_CHANNELS,
  private: PRIVATE_CHANNELS,
} as const;

export type RealtimeChannelPreset = keyof typeof CHANNEL_PRESETS;

export const channelPreset = (
  preset: RealtimeChannelPreset,
): readonly string[] => CHANNEL_PRESETS[preset] ?? [];
