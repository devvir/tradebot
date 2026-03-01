import type { BitmexDataMessage, BitmexDataItem, BitmexTable, BitmexAction } from '@tradebot/types';
import { unpackDocumentId } from './document-id';
import { decodeOrderBookL2 } from './orderBookL2';
import { decodeQuote } from './quote';
import { decodeTrade } from './trade';
import { decodeInstrument } from './instrument';

// ── Routing ────────────────────────────────────────────────────────────────────

const decodeTableData = (
  table: BitmexTable,
  payload: Record<string, unknown[]>,
  action: BitmexAction,
  encoderVersion: string,
  timestamp: string,
): BitmexDataItem[] => {
  if (encoderVersion !== '1.0.0') {
    throw new Error(`Unsupported encoder version ${encoderVersion} for table "${table}"`);
  }

  switch (table) {
    case 'orderBookL2': return decodeOrderBookL2(payload, action);
    case 'quote':       return decodeQuote(payload, timestamp);
    case 'trade':       return decodeTrade(payload, timestamp);
    case 'instrument':  return decodeInstrument(payload);
    default:            return [];
  }
};

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Decode a stored document back to a BitmexDataMessage.
 *
 * @param table    - Collection / table name
 * @param payload  - Pre-parsed JSON object
 * @param idBuffer - The 8-byte MongoDB _id that carries action, version, and timestamp
 */
export const decodeMessage = (
  table: BitmexTable,
  payload: Record<string, unknown[]>,
  idBuffer: Buffer | ArrayBuffer,
): Partial<BitmexDataMessage> => {
  const { encoderVersion, action, timestamp } = unpackDocumentId(idBuffer);

  return {
    table,
    action,
    data: decodeTableData(table, payload, action, encoderVersion, timestamp),
  };
};
