import { brotliCompressSync, constants } from 'node:zlib';
import { logger } from '@devvir/service';
import {
  encodeInstrument,
  encodeQuote,
  encodeOrderBookL2,
  encodeTrade,
  isBitmexDataWithSymbol,
  type EncodedMessage,
  type BitmexDataItem,
  type InstrumentData,
  type OrderBookL2Data,
  type QuoteDataFull,
  type TradeData,
  type BitmexDataMessage,
} from '..';

const BROTLI_QUALITY = parseInt(process.env.CODEC_BROTLI_QUALITY || '1');
const BROTLI_OPTIONS = { params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } };

/**
 * Encode and brotli-compress an AMQP message's data array.
 *
 * Other root items pass through unchanged.
 */
export default (message: BitmexDataMessage): EncodedMessage | BitmexDataMessage => {
  const { table, data, ...rest } = message;

  try {
    const encoded = encodePayload(table, data);
    const compressed = brotliCompressSync(JSON.stringify(encoded), BROTLI_OPTIONS);

    return { table, b: compressed, ...rest };
  } catch (err) {
    logger.error({ err, table }, 'Failed to encode message, falling back to raw payload');
  }

  return message;
};

/**
 * Encode payload (doc.data) by table, applying the appropriate packing strategy.
 *
 * Output shape:
 *  - Tables without symbol: { _: dataGroup }
 *  - Tables with symbol:    { [symbol]: dataGroup, ... }
 */
const encodePayload = (table: string, data: BitmexDataItem[]): Record<string, unknown[]> => {
  const encoded = data.map(item => encodeItem(table, item));

  if (! isBitmexDataWithSymbol(data))
    return { _: encoded };

  return Object.groupBy(encoded, (_, i) => data[i].symbol) as Record<string, unknown[]>;
};

/**
 * Delegate encoding of each data item to the appropriate encoder.
 */
const encodeItem = (table: string, item: BitmexDataItem): unknown => {
  switch (table) {
    case 'instrument':  return encodeInstrument(item as InstrumentData);
    case 'quote':       return encodeQuote(item as QuoteDataFull);
    case 'orderBookL2': return encodeOrderBookL2(item as OrderBookL2Data);
    case 'trade':       return encodeTrade(item as TradeData);
    default:            return item;
  }
};
