import { restKind } from '../catalog';
import { historicalRecords } from './historical';
import { recentRecords } from './recent';
import { stateRecords } from './state';
import type { BitmexTable } from '@tradebot/types';
import type { Librarian } from '../librarian';
import type { DataItem, RestParams } from '../types';

/**
 * The REST surface — records for every served table, dispatched by the table's
 * BitMEX REST semantics (see `restKind`):
 *
 *   historical — trade, quote, funding, settlement, insurance, bins.
 *   recent     — chat, announcement.
 *   state      — orderBookL2, instrument, liquidation (reconstructed at the clock).
 *
 * Digger has already resolved "now" and capped the bounds, so this works in
 * absolute time only.
 */
export const restRecords = async (
  lib: Librarian, table: BitmexTable, params: RestParams,
): Promise<DataItem[]> => {
  switch (restKind(table)) {
    case 'historical': return historicalRecords(lib, table, params);
    case 'recent':     return recentRecords(lib, table, params);
    case 'state':      return stateRecords(lib, table, params);
    default:           return [];
  }
};
