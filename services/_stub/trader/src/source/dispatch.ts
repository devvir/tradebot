/**
 * Map BitMEX WS table messages onto cache updates.
 *
 * One handler per table — dispatched by name. New tables are added by extending
 * the HANDLERS map; nothing else needs to change.
 *
 * The handlers tolerate sparse/partial payloads: BitMEX sends only the changed
 * fields in `update` messages, so missing fields keep their previous values.
 */

import type { QuoteDataFull, InstrumentData } from '@tradebot/types';
import type { DataCache } from './cache';
import type { Quote, Position, Instrument } from '../types';

/**
 * Subset of BitMEX `position` table fields that the cache exposes.
 * BitMEX has ~50 fields per row but strategies only need these.
 */
interface PositionWire {
  symbol?:           string;
  currentQty?:       number;
  markPrice?:        number;
  liquidationPrice?: number;
  unrealisedPnl?:    number;
  marginCallPrice?:  number;
}

type Handler = (data: unknown[], cache: DataCache) => void;

const HANDLERS: Record<string, Handler> = {
  quote:      handleQuote,
  instrument: handleInstrument,
  position:   handlePosition,
};

export function dispatch(table: string, data: unknown[], cache: DataCache): void {
  const handler = HANDLERS[table];

  if (! handler || data.length === 0) return;

  handler(data, cache);
}

// ---- Handlers ----------------------------------------------------------

/**
 * Quotes are top-of-book. Take the most recent item from the batch — earlier
 * items in the same message are already superseded.
 */
function handleQuote(data: unknown[], cache: DataCache): void {
  const item = data[data.length - 1] as QuoteDataFull;

  if (item.bidPrice == null || item.askPrice == null) return;

  const quote: Quote = {
    symbol:    item.symbol,
    timestamp: item.timestamp,
    bidPrice:  item.bidPrice,
    bidSize:   item.bidSize,
    askPrice:  item.askPrice,
    askSize:   item.askSize,
  };

  cache.updateQuote(quote);
}

/**
 * Instrument metadata (tickSize, lotSize, multiplier) drives planner rounding.
 * Updates are merged onto the cached snapshot since BitMEX sends sparse updates.
 */
function handleInstrument(data: unknown[], cache: DataCache): void {
  const item = data[0] as InstrumentData;
  const prev = cache.getInstrument();

  // Need tickSize and lotSize at minimum. If the first message is a sparse update
  // and we don't have a baseline yet, drop it.
  if (! prev && (item.tickSize == null || item.lotSize == null)) return;

  const merged: Instrument = {
    symbol:      item.symbol      ?? prev?.symbol      ?? '',
    markPrice:   item.markPrice   ?? prev?.markPrice   ?? 0,
    tickSize:    item.tickSize    ?? prev?.tickSize    ?? 0,
    lotSize:     item.lotSize     ?? prev?.lotSize     ?? 0,
    multiplier:  item.multiplier  ?? prev?.multiplier  ?? 1,
    fundingRate: item.fundingRate ?? prev?.fundingRate,
  };

  cache.updateInstrument(merged);
}

/**
 * Position is single-row per symbol. Merge sparse updates onto the cached row.
 */
function handlePosition(data: unknown[], cache: DataCache): void {
  const item = data[0] as PositionWire;
  const prev = cache.getPosition();

  const merged: Position = {
    symbol:           item.symbol           ?? prev?.symbol           ?? '',
    currentQty:       item.currentQty       ?? prev?.currentQty       ?? 0,
    markPrice:        item.markPrice        ?? prev?.markPrice        ?? 0,
    liquidationPrice: item.liquidationPrice ?? prev?.liquidationPrice,
    unrealizedPnl:    item.unrealisedPnl    ?? prev?.unrealizedPnl,
    marginCallPrice:  item.marginCallPrice  ?? prev?.marginCallPrice,
  };

  cache.updatePosition(merged);
}

// ---- Test exports ------------------------------------------------------

export const _test_HANDLERS = HANDLERS;
