import { brotliDecompressSync } from 'node:zlib';
import { logger } from '@devvir/service-kit';
import {
  decodeOrderBookL2,
  decodeQuote,
  decodeTrade,
  decodeInstrument,
  type Message,
  type DecodedMessage,
  type BitmexTable,
  type BitmexDataItem,
  DecodedMessageData,
} from '..';

/**
 * Decompress and decode an encoded document, back to a BitmexDataMessage.
 *
 *   encoded → { table, action, b: "<base64>" }
 *   decoded → { table, action, data: [...] }   (passthrough, no-op)
 *
 * All root fields except `b` are passed through unchanged.
 */
export default (message: Message): DecodedMessage | void => {
  if (! message.b)
    return message as unknown as DecodedMessage;

  const { b, ...rest } = message;

  try {
    // doc.b arrives as a base64 string from RabbitMQ
    const compressed = Buffer.from(b as string, 'base64');
    const encoded = JSON.parse(brotliDecompressSync(compressed).toString());
    const data = decodeMessage(message.table, encoded);

    return { ...rest, data };
  } catch (err) {
    logger.error({ err, table: message.table }, 'Failed to decode message');
  }
};


/**
 * Decode a stored document back to a BitmexDataMessage.
 */
const decodeMessage = (table: BitmexTable, encodedData: DecodedMessageData): DecodedMessage['data'] => {
  switch (table) {
    case 'orderBookL2': return decodeOrderBookL2(encodedData);
    case 'quote':       return decodeQuote(encodedData);
    case 'trade':       return decodeTrade(encodedData);
    case 'instrument':  return decodeInstrument(encodedData);
    default:            return decodePassthrough(encodedData);
  }
};

/**
 * Passthrough decode: reverse the groupBy applied by encodePayload for unknown tables.
 * Items were stored unchanged (not packed), grouped by symbol key or under '_'.
 * Since items are stored with their symbol field intact, just flatten all groups.
 */
const decodePassthrough = (encodedData: DecodedMessageData): BitmexDataItem[] => {
  if (! encodedData || typeof encodedData !== 'object') {
    logger.warn({ encodedData }, 'Invalid encoded data. Skipping.');
    return [];
  }

  return Object.values(encodedData as Record<string, unknown[]>).flat() as BitmexDataItem[];
};
