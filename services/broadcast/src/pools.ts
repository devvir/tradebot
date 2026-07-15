import { POOL_FANOUT_CHANNELS } from '@tradebot/utils';
import type { Pool, PoolFilter, ParsedChannel } from './types';

// ── Pool subscription handling ────────────────────────────────────────────────

/**
 * Parse the `BROADCAST_POOLS` env (csv of `default,primary,secondary,aggregated`,
 * case-insensitive) into normalized pool filters. Empty/unset → `['default']`,
 * which keeps today's bare-subscription behaviour. Throws on an unknown value.
 */
export const parsePools = (raw?: string): PoolFilter[] => {
  const tokens = (raw ?? '').split(',').map(token => token.trim()).filter(Boolean);

  if (tokens.length === 0)
    return ['default'];

  return tokens.map(normalizePool);
};

/**
 * Expand a preset's channels into the actual subscription args for the requested
 * pools. A **fan-out** channel (`POOL_FANOUT_CHANNELS` — books and bins, whose
 * default stream is fused `Aggregated`) becomes one arg per pool
 * (`orderBookL2::Primary`, using the empty-symbol form so a single subscription
 * covers every symbol); `default` keeps the bare channel. Every other channel is
 * emitted once regardless of how many pools are requested — non-pooled tables
 * (e.g. `liquidation`) have no pool, and `trade`/`quote` already tag each row
 * Primary/Secondary on the bare subscription. Exact duplicates are collapsed.
 */
export const expandChannels = (
  channels: readonly string[],
  pools:    readonly PoolFilter[],
): string[] => {
  const expanded = channels.flatMap(channel =>
    fanByPool(channel)
      ? pools.map(pool => pool === 'default' ? channel : `${channel}::${pool}`)
      : [channel],
  );

  return [...new Set(expanded)];
};

/**
 * Split a subscription arg into its base channel and pool. BitMEX's subscribe ack
 * drops the pool suffix (acking `orderBookL2::Primary` as `subscribe: "orderBookL2"`
 * with the pool in `ack.pool`), so confirmation must match on the base plus the
 * ack's pool — see `waitForSubscription`.
 */
export const parseChannel = (channel: string): ParsedChannel => {
  const segments = channel.split(':');
  const last     = segments[segments.length - 1];

  if (segments.length >= 2 && (POOL_NAMES as readonly string[]).includes(last)) {
    segments.pop();

    // Drop the empty symbol slot left by the all-symbol form (`table::Pool`).
    while (segments.length > 1 && segments[segments.length - 1] === '')
      segments.pop();

    return { base: segments.join(':'), pool: last as Pool };
  }

  return { base: channel };
};

// ── Internals ─────────────────────────────────────────────────────────────────

const POOL_NAMES: readonly Pool[] = ['Primary', 'Secondary', 'Aggregated'];

/** Channels fanned into one subscription per pool — see `POOL_FANOUT_CHANNELS`. */
const FANOUT = new Set<string>(POOL_FANOUT_CHANNELS);

/** Whether a channel should be fanned into one subscription per pool. */
const fanByPool = (channel: string): boolean => FANOUT.has(channel);

const normalizePool = (token: string): PoolFilter => {
  switch (token.toLowerCase()) {
    case 'default':    return 'default';
    case 'primary':    return 'Primary';
    case 'secondary':  return 'Secondary';
    case 'aggregated': return 'Aggregated';
    default:
      throw new Error(`Invalid BROADCAST_POOLS value '${token}' — expected default, primary, secondary, or aggregated`);
  }
};
