import {
  type BitmexDataItem,
  type BitmexAction,
  type InstrumentData,
  type OrderBookL2Data,
  type QuoteData,
  type TradeData,
  isBitmexDataWithSymbol,
} from '@tradebot/types';

import { encodeQuote } from './tables/quote';
import { encodeOrderBookL2 } from './tables/orderBookL2';
import { encodeTrade } from './tables/trade';
import { encodeInstrument } from './tables/instrument';

/**
 * Encode payload (doc.data) by table, applying the appropriate packing strategy.
 *
 * Output shape:
 *  - Tables without symbol: { _: dataGroup }
 *  - Tables with symbol:    { [symbol]: dataGroup, ... }
 */
export const encodePayload = (
  data: BitmexDataItem[],
  table: string,
  action: BitmexAction,
): Record<string, unknown[]> => {
  const encoded = data.map(item => encodeItem(table, item, action));

  if (! isBitmexDataWithSymbol(data)) {
    return { _: encoded };
  }

  return Object.groupBy(encoded, (_, i) => data[i].symbol) as Record<string, unknown[]>;
};

const encodeItem = (table: string, item: BitmexDataItem, action: BitmexAction): unknown => {
  switch (table) {
    case 'instrument':  return encodeInstrument(item as InstrumentData);
    case 'quote':       return encodeQuote(item as QuoteData);
    case 'orderBookL2': return encodeOrderBookL2(item as OrderBookL2Data, action);
    case 'trade':       return encodeTrade(item as TradeData);
    default:            return item;
  }
};
