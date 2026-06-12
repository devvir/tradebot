import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoClient, Db } from 'mongodb';
import { startOfDayMongoId, makeMongoId } from '@tradebot/utils';

import { discoverPartitions, _test_discover as discover } from '../../../src/distillers/instrument/partitions';

const { mongoPort } = JSON.parse(readFileSync(resolve(__dirname, '../../.ports.json'), 'utf8'));
const DB_NAME  = 'test_partitions';
const mongoUrl = `mongodb://root:root@localhost:${mongoPort}/${DB_NAME}?authSource=admin`;

const DAY     = '2020-01-01';
const nextDay = new Date(`${DAY}T00:00:00.000Z`);
nextDay.setUTCDate(nextDay.getUTCDate() + 1);

const dayLo = startOfDayMongoId(DAY);
const dayHi = startOfDayMongoId(nextDay.toISOString().slice(0, 10));

describe('partitions — index-less discovery', () => {
  let client: MongoClient;
  let db:     Db;

  beforeAll(async () => {
    client = new MongoClient(mongoUrl);
    await client.connect();
    db = client.db(DB_NAME);
  });

  afterAll(async () => {
    await client?.close();
  });

  beforeEach(async () => {
    await db.collection('compositeIndex').deleteMany({});
  });

  /**
   * Insert one compositeIndex row per entry of `indexSymbols` at sequential `_id`s,
   * returning the `_id` each landed at so tests can assert exact partition bounds.
   * `compositeIndex` clusters by `indexSymbol`, so `symbol` is deliberately set to a
   * per-row constituent that varies *within* a block — keying on `symbol` would
   * shred these runs, keying on `indexSymbol` keeps them whole.
   */
  const insert = async (indexSymbols: string[]): Promise<number[]> => {
    const ids  = indexSymbols.map((_, i) => makeMongoId(DAY, i + 1, 0));
    const docs = indexSymbols.map((indexSymbol, i) => ({
      _id: ids[i], timestamp: `${DAY}T00:00:00.000Z`, indexSymbol, symbol: `.CONSTITUENT${i % 3}`,
    }));

    await db.collection('compositeIndex').insertMany(docs as Record<string, unknown>[]);

    return ids;
  };

  it('returns a single whole-day partition for a time-ordered table without querying', async () => {
    const parts = await discoverPartitions(db, 'instrument', DAY, dayLo, dayHi);

    expect(parts).toEqual([{ lo: dayLo, hiExcl: dayHi }]);
  });

  it('returns no partitions for an empty clustered day', async () => {
    expect(await discoverPartitions(db, 'compositeIndex', DAY, dayLo, dayHi)).toEqual([]);
  });

  it('keys on indexSymbol, not symbol — one block of mixed symbols is one partition', async () => {
    // Three rows, one indexSymbol, three different `symbol`s. Keying on `symbol`
    // would split this into pieces; keying on `indexSymbol` keeps it a single run.
    const ids   = await insert(['A', 'A', 'A']);
    const parts = await discoverPartitions(db, 'compositeIndex', DAY, dayLo, dayHi);

    expect(parts).toEqual([{ lo: ids[0], hiExcl: ids[2]! + 1 }]);
  });

  it('splits clustered runs at their exact boundaries', async () => {
    // A A A | B B | Z Z Z Z — three contiguous indexSymbol runs.
    const ids   = await insert(['A', 'A', 'A', 'B', 'B', 'Z', 'Z', 'Z', 'Z']);
    const parts = await discoverPartitions(db, 'compositeIndex', DAY, dayLo, dayHi);

    expect(parts).toEqual([
      { lo: ids[0], hiExcl: ids[3]  },   // A: [0..3)
      { lo: ids[3], hiExcl: ids[5]  },   // B: [3..5)
      { lo: ids[5], hiExcl: ids[8]! + 1 }, // Z: [5..8]
    ]);
  });

  it('tiles the day — partitions are disjoint and cover every document', async () => {
    const ids   = await insert(['A', 'A', 'B', 'C', 'C', 'C', 'D']);
    const parts = await discoverPartitions(db, 'compositeIndex', DAY, dayLo, dayHi);

    expect(parts[0]!.lo).toBe(ids[0]);
    expect(parts.at(-1)!.hiExcl).toBe(ids.at(-1)! + 1);

    for (let i = 1; i < parts.length; i++) expect(parts[i]!.lo).toBe(parts[i - 1]!.hiExcl);
  });

  it('falls back to one partition when the run budget is exceeded', async () => {
    // Every document a distinct symbol — a boundary at every adjacency, so the run
    // count climbs without bound. A tiny `maxRuns` makes the classifier bail exactly
    // as it would on a real time-ordered day with too many transitions to be worth
    // partitioning; the day is then read as a single (still time-monotone) stream.
    const ids = await insert(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);

    const parts = await discover(db, 'compositeIndex', DAY, dayLo, dayHi, 2, 1_000);

    expect(parts).toEqual([{ lo: ids[0], hiExcl: ids.at(-1)! + 1 }]);
  });
});
