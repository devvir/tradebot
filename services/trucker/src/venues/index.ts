import { binance } from './binance';
import { bitget } from './bitget';
import { bybit } from './bybit';
import { htx } from './htx';
import { gate } from './gate';
import { kucoin } from './kucoin';
import { okx } from './okx';
import type { VenueArchive } from './types';

/**
 * Every venue whose archive trucker can fetch unattended. Venues whose data is
 * behind a JS portal (OKX's non-trades categories, Bitget) or a manual
 * distribution (Kraken's Drive links) are absent until their access is solved —
 * see docs/services/TRUCKER.md.
 */
const VENUES: readonly VenueArchive[] = [binance, bitget, bybit, gate, htx, kucoin, okx];

export const VENUE_NAMES: readonly string[] = VENUES.map(v => v.name);

export const venueFor = (name: string): VenueArchive => {
  const found = VENUES.find(v => v.name === name);

  if (! found)
    throw new Error(`Unknown venue '${name}' — known: ${VENUE_NAMES.join(', ')}`);

  return found;
};

export type { VenueArchive } from './types';
