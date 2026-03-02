import type { BitmexDataMessage, BitmexDataItem, BitmexTable, BitmexAction } from '@tradebot/types';
import { unpackDocumentId } from './documentId';
import { decodeOrderBookL2 } from './tables/orderBookL2';
import { decodeQuote } from './tables/quote';
import { decodeTrade } from './tables/trade';
import { decodeInstrument } from './tables/instrument';

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Decode a stored document back to a BitmexDataMessage.
 *
 * @param table    - Collection / table name
 * @param payload  - Pre-parsed JSON object
 * @param id       - The document _id (number)
 */
export const decodeMessage = (
  table: BitmexTable,
  payload: Record<string, unknown[]>,
  id: number,
): Partial<BitmexDataMessage> => {
  const { action, timestamp } = unpackDocumentId(id);
  const data = decodeTableData(table, payload, action, timestamp);

  return { table, action, data };
};

// ── Routing ────────────────────────────────────────────────────────────────────

const decodeTableData = (
  table: BitmexTable,
  payload: Record<string, unknown[]>,
  action: BitmexAction,
  timestamp: string,
): BitmexDataItem[] => {
  switch (table) {
    case 'orderBookL2': return decodeOrderBookL2(payload, action);
    case 'quote':       return decodeQuote(payload, timestamp);
    case 'trade':       return decodeTrade(payload, timestamp);
    case 'instrument':  return decodeInstrument(payload);
    default:            return [];
  }
};
