/**
 * Reconstruct a BitMEX WS message envelope from the data-only form vault
 * stores. Adds back the metadata BitMEX only ships on `partial` (keys,
 * types, filter), decodes symbol-tagged actions (`partial:XBTUSD`), fills
 * the `chat` table's keys/filterKey, and backfills legacy
 * `orderBookL2` rows missing `timestamp`/`transactTime`/`pool`.
 *
 *   - Returns null when `data` is empty — these envelopes carry no state
 *     and the replay engine synthesizes them on subscription, so storing
 *     them is wasted space.
 *   - Throws `UnknownTableError` when no `TABLE_SPECS` entry exists —
 *     config drift between vault contents and code. Caller should treat
 *     this as fatal (shut the service down).
 */

import { TABLE_SPECS } from '@tradebot/utils';
import type { BitmexFieldType, BitmexTable } from '@tradebot/types';

export interface WsMessage {
  action: string;
  date:   string;
  data:   Record<string, unknown>[];
}

export interface ReconstructedMessage {
  table:      string;
  action:     string;
  data:       Record<string, unknown>[];
  keys?:      string[];
  types?:     Record<string, BitmexFieldType>;
  filter?:    Record<string, unknown>;
  filterKey?: string;
  timestamp:  string;
}

export class UnknownTableError extends Error {
  constructor(public readonly table: string) {
    super(`Unknown table: ${table}`);

    this.name = 'UnknownTableError';
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export const reconstruct = (
  table:   BitmexTable,
  message: WsMessage,
): ReconstructedMessage | null => {
  if (message.data.length === 0) return null;

  const spec = TABLE_SPECS[table];

  if (! spec) throw new UnknownTableError(table);

  const { data }            = message;
  const resolvedData        = table === 'orderBookL2' ? fillOrderBookDefaults(data, message.date) : data;
  const [action, filterSym] = decodeAction(message.action);
  const timestamp           = (spec.types['timestamp'] ? resolvedData[0]!['timestamp'] : message.date) as string;

  const result: ReconstructedMessage = { table, action, data: resolvedData, timestamp };

  if (action === 'partial') {
    result.types  = spec.types;
    result.filter = filterSym !== undefined ? { symbol: filterSym } : spec.filter;
    result.keys   = spec.keys;
  }

  if (table === 'chat') {
    result.keys      = ['id'];
    result.filterKey = 'channelID';
  }

  return result;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Fills in missing `timestamp`, `transactTime`, and `pool` fields on
 * orderBookL2 rows using the message reception date. Pre-2023 BitMEX
 * orderBookL2 data did not include some or all of these fields. Fields
 * already present are never overwritten.
 */
const fillOrderBookDefaults = (
  data: Record<string, unknown>[],
  date: string,
): Record<string, unknown>[] =>
  data.map(item => {
    if (item.timestamp && item.transactTime && item.pool)
      return item;

    return {
      ...item,
      timestamp:    item.timestamp    ?? date,
      transactTime: item.transactTime ?? date,
      pool:         item.pool         ?? 'Primary',
    };
  });

/**
 * Decodes a symbol-encoded action string produced by tardy.
 *   'partial:XBTUSD' → ['partial', 'XBTUSD']
 *   'partial'        → ['partial', undefined]
 *   'insert'         → ['insert',  undefined]
 */
const decodeAction = (action: string): [string, string | undefined] => {
  if (! action.startsWith('partial:')) return [action, undefined];

  return ['partial', action.slice('partial:'.length)];
};
