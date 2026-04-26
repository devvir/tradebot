import type { MongoClient } from 'mongodb';
import * as snapshots from '../snapshots';
import type { BitmexTable, Config } from '../types';
import type { RestParams } from './params';

/**
 * Two query strategies, picked per table:
 *
 *   queryRecords  — REST-origin tables (trade, quote, funding, bins, …):
 *                   timestamp range over MongoDB; cheap with the symbol+timestamp
 *                   index ensured at startup.
 *
 *   querySnapshot — WS-origin tables (instrument, orderBookL2, …): the current
 *                   in-memory accumulator state; the replay clock guarantees it
 *                   reflects the moment the request was received.
 */

// ── REST-origin: range query against MongoDB ─────────────────────────────────

export const queryRecords = async (
  table:  BitmexTable,
  params: RestParams,
  config: Config,
  mongo:  MongoClient,
): Promise<unknown[]> => {
  const collection = mongo.db(config.database).collection(table);
  const filter     = buildFilter(params);
  const sortDir    = params.reverse ? -1 : 1;

  const docs = await collection
    .find(filter)
    .sort({ timestamp: sortDir })
    .skip(params.start)
    .limit(params.count)
    .project({ _id: 0 })
    .toArray();

  return params.columns ? docs.map(d => pickColumns(d, params.columns!)) : docs;
};

// ── WS-origin: read from the snapshots accumulator ───────────────────────────

export const querySnapshot = (table: BitmexTable, params: RestParams): unknown[] => {
  const partial = snapshots.buildSnapshot(table);

  if (! partial) return [];

  const data = filterBySymbol(partial.data, params.symbol);
  const sliced = sliceWithDirection(data, params);

  return params.columns ? sliced.map(d => pickColumns(d, params.columns!)) : sliced;
};

// ── Internal ──────────────────────────────────────────────────────────────────

const buildFilter = (params: RestParams): Record<string, unknown> => {
  const filter: Record<string, unknown> = {};

  if (params.symbol) filter.symbol = params.symbol;

  const range = buildTimestampRange(params);

  if (range) filter.timestamp = range;

  return filter;
};

const buildTimestampRange = (params: RestParams): Record<string, string> | null => {
  const range: Record<string, string> = {};

  if (params.startTime !== undefined) range.$gte = new Date(params.startTime).toISOString();
  if (params.endTime   !== undefined) range.$lte = new Date(params.endTime  ).toISOString();

  return Object.keys(range).length > 0 ? range : null;
};

const filterBySymbol = (data: unknown[], symbol: string | undefined): unknown[] => {
  if (! symbol) return data;

  return data.filter(item =>
    typeof item === 'object' && item !== null &&
    (item as Record<string, unknown>).symbol === symbol,
  );
};

const sliceWithDirection = (data: unknown[], params: RestParams): unknown[] => {
  const ordered = params.reverse ? [...data].reverse() : data;

  return ordered.slice(params.start, params.start + params.count);
};

const pickColumns = (doc: unknown, columns: string[]): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  const src    = doc as Record<string, unknown>;

  for (const col of columns) {
    if (col in src) result[col] = src[col];
  }

  return result;
};
