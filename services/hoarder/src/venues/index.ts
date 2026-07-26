import { binance } from './binance';
import { bitmex } from './bitmex';
import { bybit } from './bybit';
import { kraken } from './kraken';
import { okx } from './okx';
import { VENUE_CHANNELS } from './channels';
import type { Venue } from './types';

/**
 * Every venue hoarder knows how to speak to. Adding a venue is adding one
 * file next to `bitmex.ts`, its channels in `channels.ts`, and one line here —
 * the core never learns its name.
 */
const VENUES: readonly Venue[] = [
  binance,
  bitmex,
  bybit,
  kraken,
  okx,
];

export const VENUE_NAMES: readonly string[] = VENUES.map(v => v.name);

/** Look up a venue by id, or throw naming the ones that exist. */
export const venueFor = (name: string): Venue => {
  const found = VENUES.find(v => v.name === name);

  if (! found)
    throw new Error(`Unknown venue '${name}' — known: ${VENUE_NAMES.join(', ')}`);

  return found;
};

/** Startup subscriptions for a venue. A venue with no entry subscribes to nothing. */
export const channelsFor = (name: string): readonly string[] => VENUE_CHANNELS[name] ?? [];

export type { Venue } from './types';
