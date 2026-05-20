import type { Db }            from 'mongodb';
import { startOfDayMongoId }  from '@tradebot/utils';

import type { HourBuckets, SourceTable } from './types';

/** Rows fetched per query before bucketing — tune for round-trip vs. memory. */
const READ_BATCH_SIZE = 100_000;

/** Hourly buckets kept warm per table; > 1 guarantees the served bucket is full. */
const MIN_BUCKET_BUFFER = 3;

const TABLES: SourceTable[] = ['instrument', 'compositeIndex', 'tick', 'quote', 'trade', 'funding', 'settlement'];

/** A source row — only the fields the Reader itself touches are typed. */
type RawRow = { _id: number; timestamp: string; [key: string]: unknown };

interface TableState {
  cursor:  number;
  done:    boolean;
  buckets: Map<string, RawRow[]>;
}

/**
 * Serves the seven source tables in hourly buckets. Streams each table by `_id`,
 * keeps `MIN_BUCKET_BUFFER` buckets warm so the served one is always complete,
 * and filters `instrument` to original (farmer) documents.
 */
export class Reader {
  private readonly db:        Db;
  private readonly startHour: string;
  private readonly state = new Map<SourceTable, TableState>();

  constructor(db: Db, startHour: string) {
    this.db        = db;
    this.startHour = startHour;

    const fromId = startOfDayMongoId(startHour.slice(0, 10));

    for (const table of TABLES) {
      this.state.set(table, { cursor: fromId - 1, done: false, buckets: new Map() });
    }
  }

  /** Every source table's documents for `hour` (`YYYY-MM-DDTHH`). */
  async pop(hour: string): Promise<HourBuckets> {
    await Promise.all(TABLES.map(table => this.warm(table)));

    const take = (table: SourceTable): RawRow[] => {
      const st  = this.state.get(table)!;
      const out = st.buckets.get(hour) ?? [];

      st.buckets.delete(hour);

      return out;
    };

    return {
      instrument:     take('instrument')     as unknown as HourBuckets['instrument'],
      compositeIndex: take('compositeIndex') as unknown as HourBuckets['compositeIndex'],
      tick:           take('tick')           as unknown as HourBuckets['tick'],
      quote:          take('quote')          as unknown as HourBuckets['quote'],
      trade:          take('trade')          as unknown as HourBuckets['trade'],
      funding:        take('funding')        as unknown as HourBuckets['funding'],
      settlement:     take('settlement')     as unknown as HourBuckets['settlement'],
    };
  }

  /** Read ahead until `MIN_BUCKET_BUFFER` buckets are warm, or the table ends. */
  private async warm(table: SourceTable): Promise<void> {
    const st = this.state.get(table)!;

    while (st.buckets.size < MIN_BUCKET_BUFFER && ! st.done) {
      const batch = await this.fetch(table, st.cursor);

      if (batch.length < READ_BATCH_SIZE) st.done = true;

      for (const row of batch) {
        st.cursor = row._id;

        const key = row.timestamp.slice(0, 13);

        if (key < this.startHour) continue;

        const bucket = st.buckets.get(key);

        if (bucket) {
          bucket.push(row);
        } else {
          st.buckets.set(key, [row]);
        }
      }
    }
  }

  /** One `_id`-ordered batch from `table`, after `cursor`. */
  private async fetch(table: SourceTable, cursor: number): Promise<RawRow[]> {
    const filter: Record<string, unknown> = { _id: { $gt: cursor } };

    // `instrument` holds the distiller's own output too — read only originals.
    if (table === 'instrument') {
      filter.$expr = { $eq: [{ $mod: ['$_id', 4] }, 0] };
    }

    return this.db.collection<RawRow>(table)
      .find(filter)
      .sort({ _id: 1 })
      .limit(READ_BATCH_SIZE)
      .toArray();
  }
}
