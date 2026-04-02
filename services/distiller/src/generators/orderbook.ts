import type { MongoClient } from 'mongodb';
import { createTable, BitmexTable } from '@devvir/bitmex-database';
import type { BitmexMessage, Table, TableTypeMap } from '@devvir/bitmex-database';
import { logger } from '@devvir/service-kit';

type OBL2Item  = TableTypeMap[BitmexTable.OrderBookL2];
type OBL2Table = Table<TableTypeMap[BitmexTable.OrderBookL2]>;

const COLLECTION_IN = 'orderBookL2';
const BATCH_SIZE    = 1_000;

const OUTPUTS = [
  { topN: 10, collection: 'orderBook10' },
  { topN: 25, collection: 'orderBookL2_25' },
] as const;

interface StoredOrderBook {
  _id:       number;
  symbol:    string;
  bids:      [number, number][];
  asks:      [number, number][];
  timestamp: string;
}

/** Extract top-N bids (desc) and asks (asc) for a given symbol from the table view. */
const extractTop = (
  table:  OBL2Table,
  symbol: string,
  topN:   number,
): { bids: [number, number][]; asks: [number, number][] } => {
  const bids: [number, number][] = [];
  const asks: [number, number][] = [];

  for (const level of table.view().data) {
    if (level.symbol !== symbol) continue;
    if (level.side === 'Buy')  bids.push([level.price!, level.size!]);
    if (level.side === 'Sell') asks.push([level.price!, level.size!]);
  }

  bids.sort((a, b) => b[0] - a[0]);
  asks.sort((a, b) => a[0] - b[0]);

  return { bids: bids.slice(0, topN), asks: asks.slice(0, topN) };
};

const topChanged = (
  prev: { bids: [number, number][]; asks: [number, number][] } | undefined,
  next: { bids: [number, number][]; asks: [number, number][] },
): boolean => {
  if (! prev) return true;
  if (prev.bids.length !== next.bids.length || prev.asks.length !== next.asks.length) return true;

  for (let i = 0; i < next.bids.length; i++) {
    if (prev.bids[i]![0] !== next.bids[i]![0] || prev.bids[i]![1] !== next.bids[i]![1]) return true;
  }

  for (let i = 0; i < next.asks.length; i++) {
    if (prev.asks[i]![0] !== next.asks[i]![0] || prev.asks[i]![1] !== next.asks[i]![1]) return true;
  }

  return false;
};

const getResumeId = async (
  mongo:    MongoClient,
  database: string,
): Promise<number> => {
  // Resume from the minimum across all output collections so no data is missed.
  const ids = await Promise.all(
    OUTPUTS.map(({ collection }) =>
      mongo.db(database).collection(collection)
        .findOne({}, { sort: { _id: -1 }, projection: { _id: 1 } })
        .then(doc => (doc ? (doc._id as unknown as number) : 0)),
    ),
  );
  return Math.min(...ids);
};

export const distillOrderBook = async (
  mongo:    MongoClient,
  database: string,
): Promise<void> => {
  const resumeId = await getResumeId(mongo, database);

  logger.debug({ resumeId }, 'orderBook: resuming from');

  const table: OBL2Table = createTable(BitmexTable.OrderBookL2);

  // Per-output tracking state
  const state = OUTPUTS.map(() => ({
    lastTop:     new Map<string, { bids: [number, number][]; asks: [number, number][] }>(),
    seenPartial: new Set<string>(),
    toInsert:    [] as StoredOrderBook[],
  }));

  let lastId    = 0;
  let processed = 0;

  while (true) {
    const batch = await mongo
      .db(database)
      .collection(COLLECTION_IN)
      .find({ _id: { $gt: lastId } } as any)
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .toArray() as Record<string, unknown>[];

    if (batch.length === 0) break;

    for (const s of state) s.toInsert = [];

    for (const doc of batch) {
      const id     = doc['_id'] as number;
      const action = doc['action'] as string;
      const data   = doc['data'] as OBL2Item[];

      const msg = action === 'partial'
        ? {
            table:  BitmexTable.OrderBookL2,
            action: 'partial' as const,
            keys:   ['symbol', 'id', 'side'] as (keyof OBL2Item & string)[],
            types:  {} as any,
            filter: {} as any,
            data,
          }
        : {
            table:  BitmexTable.OrderBookL2,
            action: action as 'insert' | 'update' | 'delete',
            data,
          };

      table.apply(msg as BitmexMessage<TableTypeMap[BitmexTable.OrderBookL2]>);

      const symbol = data[0]?.symbol;
      if (! symbol) { lastId = id; continue; }

      for (const [i, { topN }] of OUTPUTS.entries()) {
        const s = state[i]!;

        if (action === 'partial') s.seenPartial.add(symbol);
        if (! s.seenPartial.has(symbol)) continue;

        const top = extractTop(table, symbol, topN);

        if (topChanged(s.lastTop.get(symbol), top)) {
          s.lastTop.set(symbol, top);

          if (id > resumeId) {
            s.toInsert.push({
              _id:       id,
              symbol,
              bids:      top.bids,
              asks:      top.asks,
              timestamp: (data[0] as any)?.timestamp ?? new Date().toISOString(),
            });
          }
        }
      }

      lastId = id;
    }

    for (const [i, { collection }] of OUTPUTS.entries()) {
      const { toInsert } = state[i]!;
      if (toInsert.length === 0) continue;

      await mongo.db(database).collection(collection)
        .insertMany(toInsert as any[], { ordered: false })
        .catch((err: any) => {
          if (err?.code !== 11000) throw err;
        });

      logger.debug({ collection, count: toInsert.length }, 'orderBook docs inserted');
    }

    processed += batch.length;
  }

  logger.info({ processed }, 'Finished distilling orderBooks');
};
