import type { AckResult, Venue } from '../src/venues/types';

/**
 * A venue that exists only for the tests of the core: the pool, the subscriber
 * and the relay are written against the `Venue` interface, and what they have
 * to cope with is more than any one real venue asks of them at once.
 *
 * So this one asks for all of it: two endpoints, with some channels on each;
 * several sockets on one endpoint, told apart by a `::<shard>` suffix on the
 * channel; an ack that names the channel without its shard and carries the
 * shard beside it; and control frames of three kinds.
 */
export const twin: Venue = {
  name: 'twin',

  endpoints: () => [
    { name: 'realtime', url: 'wss://twin.test/realtime' },
    { name: 'platform', url: 'wss://twin.test/platform' },
  ],

  endpointFor: (channel) => (PLATFORM.includes(split(channel).base) ? 'platform' : 'realtime'),

  subscribeFrame:   (channels) => JSON.stringify({ op: 'subscribe',   args: channels }),
  unsubscribeFrame: (channels) => JSON.stringify({ op: 'unsubscribe', args: channels }),

  matchAck: (frame, channel): AckResult => {
    const ack = frame as { subscribe?: string; pool?: string; success?: boolean };

    if (typeof ack.subscribe !== 'string') return null;

    const { base, shard } = split(channel);

    if (ack.subscribe !== base)      return null;
    if (shard && ack.pool !== shard) return null;

    return ack.success ? 'ok' : 'failed';
  },

  isData: (frame) => {
    const msg = frame as { table?: unknown; action?: unknown };

    return typeof msg.table === 'string' && typeof msg.action === 'string';
  },

  describeControl: (frame) => {
    const msg = frame as { info?: string; version?: string; subscribe?: string; unsubscribe?: string; success?: boolean };

    if (typeof msg.info === 'string')        return `info: ${msg.info} (API ${msg.version})`;
    if (typeof msg.subscribe === 'string')   return `subscribed: ${msg.subscribe} (success=${msg.success})`;
    if (typeof msg.unsubscribe === 'string') return `unsubscribed: ${msg.unsubscribe} (success=${msg.success})`;

    return null;
  },

  socketKey: (channel) => split(channel).shard ?? '',
};

/** The registry as the core sees it, with the twin added to the venues there are. */
export const withTwin = async <T extends typeof import('../src/venues')>(load: () => Promise<T>): Promise<T> => {
  const real = await load();

  return {
    ...real,
    venueFor:    (name: string) => (name === twin.name ? twin : real.venueFor(name)),
    channelsFor: (name: string) => (name === twin.name ? [] : real.channelsFor(name)),
  };
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** The channels that ride the second endpoint. */
const PLATFORM = ['announcement', 'chat', 'connected', 'publicNotifications'];

const split = (channel: string): { base: string; shard?: string } => {
  const [base, shard] = channel.split('::');

  return shard ? { base: base!, shard } : { base: base! };
};
