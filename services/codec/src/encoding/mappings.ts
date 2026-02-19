/**
 * Encoding mappings for BitMEX message compression
 * These define how fields are encoded to minimize storage requirements
 */

import { BitmexAction, BitmexDataItem, OrderBookL2Data, QuoteData } from "../../../../shared/types/src";
import { codecStrategy } from "../config";

/**
 * Encoded value with bit width specification, describing what and how much space is needed.
 */
export interface EncodedField {
  encoded: number | bigint;
  bits: number;
}

/**
 * Action identifiers (2 bits: 0-3)
 */
export const ACTION_ID = {
  partial: 0,
  insert: 1,
  update: 2,
  delete: 3,
} as const;

/**
 * Start of encoded timestamp range (2000-01-01 00:00:00.000Z)
 */
const EPOCH_2000 = 946684800000;

/**
 * Semver string encoding (9 bits: 2 major + 3 minor + 4 patch)
 */
export const encodeVersion = (version: string): EncodedField => {
  const [major, minor, patch] = version.split('.').map(Number);
  const encoded = ((major & 0b11) << 7)
                | ((minor & 0b111) << 4)
                | (patch & 0b1111);

  return { encoded, bits: 9 };
};

/**
 * Semver string decoding (9 bits: 2 major + 3 minor + 4 patch)
 */
export const decodeVersion = (encoded: number): string => {
  const major = (encoded >> 7) & 0b11;
  const minor = (encoded >> 4) & 0b111;
  const patch = encoded & 0b1111;

  return `${major}.${minor}.${patch}`;
};

/**
 * Timestamp encoding (42 bits: ms since Jan 1, 2000 - covers up to 2100).
 */
export const encodeTimestamp = (isoString: string): EncodedField => {
  const ms = new Date(isoString).getTime();
  const offset = ms - EPOCH_2000;

  if (offset < 0 || offset > 0x3ffffffffff) {
    throw new Error(`Timestamp ${isoString} out of valid range (2000-2100)`);
  }

  return { encoded: BigInt(offset), bits: 42 };
};

export const decodeTimestamp = (encoded: number | bigint): string => {
  const ms = Number(encoded) + EPOCH_2000;

  return new Date(ms).toISOString();
};


/**
 * Per-table encoding strategies
 * Defines which fields are encoded and how for each table type
 */

/**
 * INSURANCE DATA ENCODING
 * Fields: currency (string), timestamp, walletBalance (number)
 * Strategy: Store raw for now (limited data, rarely changes)
 */
export const insuranceEncoding = {
  fields: ['currency', 'timestamp', 'walletBalance'],
  // TODO: Define bit packing if compression becomes necessary
} as const;

/**
 * ORDERBOOK L2 DATA ENCODING
 * Fields: symbol, id, side, size, price, pool, timestamp, transactTime
 * Hot path: symbol, id, side, size, price
 * Strategy: Pack id, side, size, price. Side can be mapped (Buy=0, Sell=1)
 */
export const orderBookL2Encoding = {
  fields: ['symbol', 'id', 'side', 'size', 'price', 'pool', 'timestamp', 'transactTime'],
  sideMap: { Buy: 0, Sell: 1 } as const,
  // id: 32 bits (long)
  // side: 1 bit (Buy/Sell)
  // size: 32 bits (long)
  // price: 32 bits float (IEEE 754)
  // Packs to 3x 64-bit integers
} as const;

/**
 * QUOTE DATA ENCODING
 * Fields: timestamp, symbol, bidSize, bidPrice, askPrice, askSize, pool
 * Strategy: All 4 numeric fields (bidSize, bidPrice, askPrice, askSize) packed into 2x 64-bit ints
 */
export const quoteEncoding = {
  fields: ['timestamp', 'symbol', 'bidSize', 'bidPrice', 'askPrice', 'askSize', 'pool'],
  // bidSize: 32 bits (long)
  // bidPrice: 32 bits float
  // askPrice: 32 bits float (or can be calculated from bid + spread)
  // askSize: 32 bits (long)
  // Packs to 2x 64-bit integers
} as const;

/**
 * TRADE DATA ENCODING
 * Fields: timestamp, symbol, side, size, price, tickDirection, trdMatchID, grossValue, homeNotional, foreignNotional, trdType, pool
 * Hot path: timestamp, symbol, side, size, price, trdMatchID
 * Strategy: Pack side (1 bit), size (32 bits), price (32 bits). Keep trdMatchID as string for uniqueness
 */
export const tradeEncoding = {
  fields: ['timestamp', 'symbol', 'side', 'size', 'price', 'tickDirection', 'trdMatchID', 'grossValue', 'homeNotional', 'foreignNotional', 'trdType', 'pool'],
  sideMap: { Buy: 0, Sell: 1 } as const,
  tickMap: { MinusTick: 0, ZeroMinusTick: 1, ZeroPlusTick: 2, PlusTick: 3 } as const,
  trdTypeMap: { RegularTrade: 0, RftTrade: 1, 'Settlement Only': 2, TransferOrder: 3 } as const,
  // Same as orderBookL2, but includes trdMatchID (stored as-is)
} as const;

/**
 * QUOTE BIN DATA ENCODING (quoteBin1m, quoteBin5m, quoteBin1h, quoteBin1d)
 * Fields: timestamp, symbol, bidSize, bidPrice, askPrice, askSize, pool
 * Strategy: Same as QUOTE (binned rather than real-time)
 */
export const quoteBinEncoding = {
  fields: ['timestamp', 'symbol', 'bidSize', 'bidPrice', 'askPrice', 'askSize', 'pool'],
  // Same as quoteEncoding
} as const;

/**
 * TRADE BIN DATA ENCODING (tradeBin1m, tradeBin5m, tradeBin1h, tradeBin1d)
 * Fields: timestamp, symbol, open, high, low, close, trades, volume, vwap, lastSize, turnover, homeNotional, foreignNotional, pool
 * Hot path: timestamp, symbol, open, high, low, close (OHLC)
 * Strategy: Pack open, high, low, close as 32-bit floats. Store trade count, volume, etc.
 */
export const tradeBinEncoding = {
  fields: ['timestamp', 'symbol', 'open', 'high', 'low', 'close', 'trades', 'volume', 'vwap', 'lastSize', 'turnover', 'homeNotional', 'foreignNotional', 'pool'],
  // OHLC: 4x 32-bit floats = 128 bits (2x 64-bit ints)
  // trades: 16 bits (short)
  // volume: 32 bits (long)
  // Packs to 3-4x 64-bit integers
} as const;

/**
 * LIQUIDATION DATA ENCODING
 * Fields: orderID, symbol, side, price, leavesQty
 * Sparse data, simple structure
 * Strategy: Keep mostly as-is (orderID is critical for tracking)
 */
export const liquidationEncoding = {
  fields: ['orderID', 'symbol', 'side', 'price', 'leavesQty'],
  sideMap: { Buy: 0, Sell: 1 } as const,
  // side: 1 bit
  // price: 32 bits float
  // leavesQty: 32 bits (long)
  // Packs to 1x 64-bit int + orderID (string)
} as const;

/**
 * FUNDING DATA ENCODING
 * Fields: symbol, timestamp, fundingInterval, fundingRate, fundingRateDaily
 * Strategy: Pack funding rates (floats, typically small numbers like -0.0005)
 */
export const fundingEncoding = {
  fields: ['symbol', 'timestamp', 'fundingInterval', 'fundingRate', 'fundingRateDaily'],
  // fundingInterval: timestamp (keep as-is or encode like main timestamp)
  // fundingRate: 32 bits float
  // fundingRateDaily: 32 bits float
  // Packs to 1x 64-bit int
} as const;

/**
 * SETTLEMENT DATA ENCODING
 * Fields: timestamp, symbol, settlementType, settledPrice, optionStrikePrice, optionUnderlyingPrice, bankrupt, taxBase, taxRate
 * Strategy: Sparse data, keep mostly as-is (prices vary widely)
 */
export const settlementEncoding = {
  fields: ['timestamp', 'symbol', 'settlementType', 'settledPrice', 'optionStrikePrice', 'optionUnderlyingPrice', 'bankrupt', 'taxBase', 'taxRate'],
  // settlementType is low-cardinality string (can be mapped if known values exist)
  // Prices and tax fields can be packed but vary widely
} as const;

/**
 * INSTRUMENT DATA ENCODING
 * Fields: ~80 fields, mostly sparse metadata
 * Strategy: Keep mostly as-is (too many optional fields to pack efficiently)
 * TODO: Review if any subsets should be encoded
 */
export const instrumentEncoding = {
  fields: ['symbol', 'rootSymbol', 'state', 'typ', /* ~ 76 more fields */],
  // Metadata-heavy, compression not priority
} as const;

export const extractPayload = (data: BitmexDataItem[], table: string, action: BitmexAction): unknown => {
  switch (table) {
    case 'orderBookL2':
      return data.map(item => orderBookL2Payload(item as OrderBookL2Data, action));

    case 'quote':
      return data.map(item => QuotePayload(item as QuoteData));

    default:
      return data;
  }
}

const orderBookL2Payload = ({ id, side, size, price, transactTime }: OrderBookL2Data, action: BitmexAction): PackedDataItem => {
  const ts = codecStrategy.pack() ? encodeTimestamp(transactTime).encoded : transactTime;
  const sideId = codecStrategy.pack() ? orderBookL2Encoding.sideMap[side] : side;

  return (action === 'delete') ? [id, sideId, ts] : [id, sideId, size!, price, ts];
}

const QuotePayload = ({ bidSize, bidPrice, askSize, askPrice }: QuoteData): PackedDataItem => {
  return [bidSize, bidPrice, askPrice, askSize];
}

type PackedDataItem = (string | number | bigint)[];
