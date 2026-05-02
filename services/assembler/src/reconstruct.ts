import { logger } from '@devvir/service-kit';
import { TABLE_SPECS } from '@tradebot/utils';
import type { ReconstructedMessage, WsMessage } from './types';
import { BitmexTable } from '@tradebot/types';

/**
 * Reconstruct a WS message from the WsMessage envelope stored in vault.
 *
 * For `partial` messages, keys/types/filter are added from the static
 * TABLE_SPECS map. The `chat` table additionally gets `filterKey`.
 *
 * Returns null if the table is unknown or the message has no data.
 */
export const reconstruct = (
  table:   BitmexTable,
  message: WsMessage,
): ReconstructedMessage | null => {
  if (message.data.length === 0) return null;

  const spec = TABLE_SPECS[table];

  if (! spec) {
    logger.warn({ table }, 'No table spec — skipping message');
    return null;
  }

  const { data } = message;
  const resolvedData = table === 'orderBookL2' ? fillOrderBookDefaults(data, message.date) : data;
  const [action, filterSymbol] = decodeAction(message.action);
  const timestamp = (spec.types['timestamp'] ? resolvedData[0]['timestamp'] : message.date) as string;

  const result: ReconstructedMessage = { table, action, data: resolvedData, timestamp };

  if (action === 'partial') {
    result.types  = spec.types;
    result.filter = filterSymbol !== undefined ? { symbol: filterSymbol } : spec.filter;
    result.keys   = spec.keys;
  }

  if (table === 'chat') {
    result.keys      = ['id']; // In all Chat actions
    result.filterKey = 'channelID';
  }

  return result;
};

// ── OrderBook defaults ────────────────────────────────────────────────────────

/**
 * Fills in missing `timestamp`, `transactTime`, and `pool` fields on
 * orderBookL2 data items using the message reception date. Fields that are
 * already present are never overwritten — these are defaults, not coercions.
 *
 * Pre-2023 BitMEX orderBookL2 data did not include some or all of these fields.
 */
const fillOrderBookDefaults = (
  data:  Record<string, unknown>[],
  date:  string,
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Decodes a symbol-encoded action string produced by tardy.
 * 'partial:XBTUSD' → ['partial', 'XBTUSD']
 * 'partial'        → ['partial', undefined]
 * 'insert'         → ['insert',  undefined]
 */
const decodeAction = (action: string): [string, string | undefined] => {
  if (! action.startsWith('partial:')) return [action, undefined];

  return ['partial', action.slice('partial:'.length)];
};
