import type { Db } from '@devvir/service-kit';

export interface HistoryState {
  _id: string;                      // sub-table key, e.g. 'trade' or 'quote:XBTUSD'
  start: number;                    // next start offset within the current block
  lastFetchedAt: Date | null;       // wall-clock time of last successful fetch; null = never fetched
  totalFetched: number;             // cumulative row count across all blocks (monitoring only)
  firstTimestamp: string | null;    // timestamp of the very first row ever (block 0, start=0); drift detection
  block: number;                    // current time-block index, 0-based
  blockStartTime: string | null;    // startTime API param for the current block; null for block 0
  lastSeenTimestamp: string | null; // timestamp of the last saved row; seeds in-memory lastTimestamp on resume
  complete: boolean;                // one-way flag — once true, this sub-table is never fetched again
  stallWarned?: boolean;            // true after the "cannot advance" warning fires; reset when new data arrives
}

const STATE_COLLECTION = '_state';

export const buildSubTableId = (tableName: string, symbol?: string): string =>
  symbol ? `${tableName}:${symbol}` : tableName;

export const makeInitialState = (id: string): HistoryState => ({
  _id: id,
  start: 0,
  lastFetchedAt: null,
  totalFetched: 0,
  firstTimestamp: null,
  block: 0,
  blockStartTime: null,
  lastSeenTimestamp: null,
  complete: false,
});

export const loadAllStates = async (db: Db): Promise<Map<string, HistoryState>> => {
  const docs = await db.collection<HistoryState>(STATE_COLLECTION).find({}).toArray();

  return new Map(docs.map((doc) => [doc._id as string, doc]));
};

export const saveState = async (db: Db, state: HistoryState): Promise<void> => {
  await db.collection<HistoryState>(STATE_COLLECTION).replaceOne(
    { _id: state._id },
    state,
    { upsert: true }
  );
};
