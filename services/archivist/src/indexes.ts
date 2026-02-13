/**
 * BitMEX Table Index Definitions
 * Based on the 'keys' field from BitMEX WebSocket API partial messages
 * Source: Direct observation from wss://www.bitmex.com/realtime
 */

import { IndexSpecification, CreateIndexesOptions } from 'mongodb';

/**
 * Index definition combining field specification and options
 */
interface IndexDefinition {
  spec: IndexSpecification;
  options: CreateIndexesOptions;
}

/**
 * Extract base table name from collection name
 * e.g. "trade_XBTUSD" -> "trade", "instrument" -> "instrument"
 */
const getBaseTableName = (collectionName: string): string => {
  const parts = collectionName.split('_');
  return parts[0];
};

/**
 * Index definitions per BitMEX table
 * Keys from BitMEX indicate compound unique keys
 * Empty keys arrays require reasonable unique constraints based on data structure
 */
const TABLE_INDEX_DEFINITIONS: Record<string, IndexDefinition> = {
  // OrderBook channels - keys: ["symbol", "id", "side"]
  orderBookL2: {
    spec: { symbol: 1, id: 1, side: 1 },
    options: { unique: true },
  },

  // Trade - keys: [] but has trdMatchID (GUID) which is unique per trade
  trade: {
    spec: { trdMatchID: 1 },
    options: { unique: true },
  },

  // Quote channels - keys: [] so use timestamp + symbol
  quote: {
    spec: { timestamp: 1, symbol: 1 },
    options: { unique: true },
  },
  quoteBin1m: {
    spec: { timestamp: 1, symbol: 1 },
    options: { unique: true },
  },
  quoteBin5m: {
    spec: { timestamp: 1, symbol: 1 },
    options: { unique: true },
  },
  quoteBin1h: {
    spec: { timestamp: 1, symbol: 1 },
    options: { unique: true },
  },
  quoteBin1d: {
    spec: { timestamp: 1, symbol: 1 },
    options: { unique: true },
  },

  // TradeBin channels - keys: [] so use timestamp + symbol
  tradeBin1m: {
    spec: { timestamp: 1, symbol: 1 },
    options: { unique: true },
  },
  tradeBin5m: {
    spec: { timestamp: 1, symbol: 1 },
    options: { unique: true },
  },
  tradeBin1h: {
    spec: { timestamp: 1, symbol: 1 },
    options: { unique: true },
  },
  tradeBin1d: {
    spec: { timestamp: 1, symbol: 1 },
    options: { unique: true },
  },

  // Liquidation - keys: ["orderID"]
  liquidation: {
    spec: { orderID: 1 },
    options: { unique: true },
  },

  // Funding - keys: ["timestamp", "symbol"]
  funding: {
    spec: { timestamp: 1, symbol: 1 },
    options: { unique: true },
  },

  // Settlement - keys: ["timestamp", "symbol"]
  settlement: {
    spec: { timestamp: 1, symbol: 1 },
    options: { unique: true },
  },

  // Insurance - keys: ["currency", "timestamp"]
  insurance: {
    spec: { currency: 1, timestamp: 1 },
    options: { unique: true },
  },

  // Instrument - keys: ["symbol"]
  instrument: {
    spec: { symbol: 1 },
    options: { unique: true },
  },
};

/**
 * Get index specification for a collection
 * @param collectionName Full collection name (e.g., "trade_XBTUSD" or "instrument")
 * @returns Index definition or null if not defined
 */
export const getIndexForCollection = (
  collectionName: string
): IndexDefinition | null => {
  const baseTable = getBaseTableName(collectionName);
  return TABLE_INDEX_DEFINITIONS[baseTable] || null;
};
