import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoClient, Db } from 'mongodb';
import { startOfDayMongoId } from '@tradebot/utils';

import {
  distillPartials,
  _test_nextDay,
  _test_synthesizeBinMidnight,
} from '../../src/distillers/partials';

const { mongoPort } = JSON.parse(
  readFileSync(resolve(__dirname, '../.ports.json'), 'utf8'),
);

const DB_NAME  = 'test_partials';
const mongoUrl = `mongodb://root:root@localhost:${mongoPort}/${DB_NAME}?authSource=admin`;

const PARTIALS = '_partials_';

const SOURCE_COLLS = [
  'orderBookL2', 'instrument',
  'trade', 'quote', 'funding', 'settlement', 'insurance',
  'tradeBin1m', 'tradeBin5m', 'tradeBin1h', 'tradeBin1d',
  'quoteBin1m', 'quoteBin5m', 'quoteBin1h', 'quoteBin1d',
];

/** Small helper: an _id inside `day` (dayStart + offset). */
const idIn = (day: string, offset: number): number => startOfDayMongoId(day) + offset;

describe('distillPartials', () => {
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
    await Promise.all(
      [...SOURCE_COLLS, PARTIALS].map(c => db.collection(c).deleteMany({})),
    );
  });

  /* ────────────────────────────────────────────────────────────────────
     Pure helpers
     ──────────────────────────────────────────────────────────────────── */

  describe('nextDay', () => {
    it('increments within a month', () => {
      expect(_test_nextDay('2020-05-10')).toBe('2020-05-11');
    });

    it('rolls over month boundary', () => {
      expect(_test_nextDay('2020-01-31')).toBe('2020-02-01');
    });

    it('rolls over year boundary', () => {
      expect(_test_nextDay('2020-12-31')).toBe('2021-01-01');
    });
  });

  describe('synthesizeBinMidnight', () => {
    const midnight = '2020-01-02T00:00:00.000Z';

    it('trade flavor: zeroes volume fields, carries close as OHLC', () => {
      const out = _test_synthesizeBinMidnight(
        [{ symbol: 'XBTUSD', timestamp: '2020-01-01T22:00:00.000Z', open: 10, high: 12, low: 9, close: 11, volume: 500, trades: 3, vwap: 10.5, lastSize: 7, turnover: 100, homeNotional: 1, foreignNotional: 2 }],
        midnight,
        'trade',
      );

      expect(out).toEqual([{
        symbol:          'XBTUSD',
        timestamp:       midnight,
        open:            11,
        high:            11,
        low:             11,
        close:           11,
        volume:          0,
        trades:          0,
        vwap:            11,
        lastSize:        0,
        turnover:        0,
        homeNotional:    0,
        foreignNotional: 0,
      }]);
    });

    it('quote flavor: carries bid/ask forward with midnight timestamp', () => {
      const out = _test_synthesizeBinMidnight(
        [{ symbol: 'XBTUSD', timestamp: '2020-01-01T22:00:00.000Z', bidPrice: 100, bidSize: 5, askPrice: 101, askSize: 4 }],
        midnight,
        'quote',
      );

      expect(out).toEqual([{
        symbol:    'XBTUSD',
        timestamp: midnight,
        bidPrice:  100,
        bidSize:   5,
        askPrice:  101,
        askSize:   4,
      }]);
    });

    it('leaves rows already at midnight untouched', () => {
      const row = { symbol: 'XBTUSD', timestamp: midnight, close: 7 };
      const out = _test_synthesizeBinMidnight([row], midnight, 'trade');

      expect(out[0]).toBe(row);
    });

    it('skips rows without a symbol', () => {
      const row = { timestamp: '2020-01-01T22:00:00.000Z', close: 7 };
      const out = _test_synthesizeBinMidnight([row] as any, midnight, 'trade');

      expect(out[0]).toBe(row);
    });
  });

  /* ────────────────────────────────────────────────────────────────────
     Empty source
     ──────────────────────────────────────────────────────────────────── */

  it('writes no partials when sources are empty', async () => {
    await distillPartials(db);

    const count = await db.collection(PARTIALS).countDocuments();

    expect(count).toBe(0);
  });

  /* ────────────────────────────────────────────────────────────────────
     Fresh start — item shape (trade)
     ──────────────────────────────────────────────────────────────────── */

  it('trade: emits one partial per closed day, never for the trailing day', async () => {
    const dayA = '2020-01-01';
    const dayB = '2020-01-02';
    const dayC = '2020-01-03';

    await db.collection('trade').insertMany([
      { _id: idIn(dayA, 1) as any, timestamp: `${dayA}T10:00:00.000Z`, symbol: 'XBTUSD', side: 'Buy',  price: 100, size: 1 },
      { _id: idIn(dayA, 2) as any, timestamp: `${dayA}T20:00:00.000Z`, symbol: 'XBTUSD', side: 'Sell', price: 105, size: 2 },
      { _id: idIn(dayA, 3) as any, timestamp: `${dayA}T21:00:00.000Z`, symbol: 'ETHUSD', side: 'Buy',  price:  40, size: 3 },
      { _id: idIn(dayB, 1) as any, timestamp: `${dayB}T09:00:00.000Z`, symbol: 'XBTUSD', side: 'Buy',  price: 110, size: 1 },
      { _id: idIn(dayC, 1) as any, timestamp: `${dayC}T08:00:00.000Z`, symbol: 'XBTUSD', side: 'Sell', price: 120, size: 1 },
    ]);

    await distillPartials(db);

    const partials = await db.collection(PARTIALS).find({ table: 'trade' }).sort({ _id: 1 }).toArray();

    // One for day A (stored as nextDay=dayB), one for day B (stored as nextDay=dayC). None for dayC.
    expect(partials.map(p => p._id)).toEqual([`trade-${dayB}`, `trade-${dayC}`]);

    const pA = partials[0]!;

    expect(pA.date).toBe(dayB);
    expect(pA.keys).toEqual([]);

    // Last-per-symbol at midnight of dayB
    const midB = `${dayB}T00:00:00.000Z`;
    const dataA = (pA.data as any[]).sort((a, b) => a.symbol.localeCompare(b.symbol));

    expect(dataA).toEqual([
      { symbol: 'ETHUSD', side: 'Buy',  price:  40, size: 3, timestamp: midB },
      { symbol: 'XBTUSD', side: 'Sell', price: 105, size: 2, timestamp: midB },
    ]);
  });

  /* ────────────────────────────────────────────────────────────────────
     Fresh start — no trailing emit for incomplete day
     ──────────────────────────────────────────────────────────────────── */

  it('trade: writes nothing when all data is within a single incomplete day', async () => {
    const day = '2020-06-15';

    await db.collection('trade').insertMany([
      { _id: idIn(day, 1) as any, timestamp: `${day}T10:00:00.000Z`, symbol: 'XBTUSD', side: 'Buy', price: 100, size: 1 },
      { _id: idIn(day, 2) as any, timestamp: `${day}T11:00:00.000Z`, symbol: 'XBTUSD', side: 'Buy', price: 101, size: 1 },
    ]);

    await distillPartials(db);

    const partials = await db.collection(PARTIALS).find({ table: 'trade' }).toArray();

    expect(partials).toEqual([]);
  });

  /* ────────────────────────────────────────────────────────────────────
     Resume — item shape (trade)
     ──────────────────────────────────────────────────────────────────── */

  it('trade: resume applies the stored partial and merges with new deltas', async () => {
    const dayA = '2020-03-01';
    const dayB = '2020-03-02';
    const dayC = '2020-03-03';

    // Stored partial covering day A (date=dayB, the start of dayB).
    await db.collection(PARTIALS).insertOne({
      _id:   `trade-${dayB}`,
      table: 'trade',
      date:  dayB,
      keys:  [],
      types: {},
      data:  [
        { symbol: 'XBTUSD', side: 'Buy', price: 200, size: 4, timestamp: `${dayB}T00:00:00.000Z` },
        { symbol: 'ETHUSD', side: 'Buy', price:  50, size: 7, timestamp: `${dayB}T00:00:00.000Z` },
      ],
    } as any);

    // Source docs: only on day B (to advance XBTUSD) + a dayC doc to close day B.
    await db.collection('trade').insertMany([
      { _id: idIn(dayA, 1) as any, timestamp: `${dayA}T08:00:00.000Z`, symbol: 'XBTUSD', side: 'Buy', price: 111, size: 1 }, // pre-seed era, should be skipped
      { _id: idIn(dayB, 1) as any, timestamp: `${dayB}T10:00:00.000Z`, symbol: 'XBTUSD', side: 'Buy', price: 210, size: 2 },
      { _id: idIn(dayC, 1) as any, timestamp: `${dayC}T09:00:00.000Z`, symbol: 'XBTUSD', side: 'Buy', price: 220, size: 1 },
    ]);

    await distillPartials(db);

    const partials = await db.collection(PARTIALS).find({ table: 'trade' }).sort({ _id: 1 }).toArray();

    // Stored partial (trade-dayB) remains, plus a new one for day B → dayC.
    expect(partials.map(p => p._id)).toEqual([`trade-${dayB}`, `trade-${dayC}`]);

    const pNew = partials[1]!;

    expect(pNew.date).toBe(dayC);

    const midC = `${dayC}T00:00:00.000Z`;
    const data = (pNew.data as any[]).sort((a, b) => a.symbol.localeCompare(b.symbol));

    // ETHUSD carried over from the pre-seed; XBTUSD advanced by the dayB insert.
    expect(data).toEqual([
      { symbol: 'ETHUSD', side: 'Buy', price:  50, size: 7, timestamp: midC },
      { symbol: 'XBTUSD', side: 'Buy', price: 210, size: 2, timestamp: midC },
    ]);
  });

  /* ────────────────────────────────────────────────────────────────────
     Bin tables — trade flavor synthesis
     ──────────────────────────────────────────────────────────────────── */

  it('tradeBin1m: synthesizes midnight carry with zero volume', async () => {
    const dayA = '2020-04-10';
    const dayB = '2020-04-11';

    await db.collection('tradeBin1m').insertMany([
      { _id: idIn(dayA, 1) as any, timestamp: `${dayA}T23:00:00.000Z`, symbol: 'XBTUSD', open: 100, high: 110, low: 95, close: 105, volume: 500, trades: 3, vwap: 102, lastSize: 7, turnover: 100, homeNotional: 1, foreignNotional: 2 },
      { _id: idIn(dayB, 1) as any, timestamp: `${dayB}T00:30:00.000Z`, symbol: 'XBTUSD', open: 105, high: 106, low: 104, close: 106, volume: 100, trades: 1, vwap: 105, lastSize: 1, turnover: 10, homeNotional: 1, foreignNotional: 1 },
    ]);

    await distillPartials(db);

    const partial = await db.collection(PARTIALS).findOne({ _id: `tradeBin1m-${dayB}` } as any);

    expect(partial).not.toBeNull();
    expect(partial!.data).toEqual([{
      symbol:          'XBTUSD',
      timestamp:       `${dayB}T00:00:00.000Z`,
      open:            105,
      high:            105,
      low:             105,
      close:           105,
      volume:          0,
      trades:          0,
      vwap:            105,
      lastSize:        0,
      turnover:        0,
      homeNotional:    0,
      foreignNotional: 0,
    }]);
  });

  /* ────────────────────────────────────────────────────────────────────
     Bin tables — quote flavor synthesis
     ──────────────────────────────────────────────────────────────────── */

  it('quoteBin1m: carries bid/ask forward at midnight', async () => {
    const dayA = '2020-05-05';
    const dayB = '2020-05-06';

    await db.collection('quoteBin1m').insertMany([
      { _id: idIn(dayA, 1) as any, timestamp: `${dayA}T22:00:00.000Z`, symbol: 'XBTUSD', bidPrice: 100, bidSize: 10, askPrice: 101, askSize: 8 },
      { _id: idIn(dayB, 1) as any, timestamp: `${dayB}T01:00:00.000Z`, symbol: 'XBTUSD', bidPrice: 200, bidSize:  5, askPrice: 201, askSize: 3 },
    ]);

    await distillPartials(db);

    const partial = await db.collection(PARTIALS).findOne({ _id: `quoteBin1m-${dayB}` } as any);

    expect(partial).not.toBeNull();
    expect(partial!.data).toEqual([{
      symbol:    'XBTUSD',
      timestamp: `${dayB}T00:00:00.000Z`,
      bidPrice:  100,
      bidSize:   10,
      askPrice:  101,
      askSize:   8,
    }]);
  });

  /* ────────────────────────────────────────────────────────────────────
     Message shape — orderBookL2 partial + deltas
     ──────────────────────────────────────────────────────────────────── */

  it('orderBookL2: emits a book snapshot at midnight from partial + deltas', async () => {
    const dayA = '2020-07-01';
    const dayB = '2020-07-02';

    await db.collection('orderBookL2').insertMany([
      {
        _id: idIn(dayA, 1) as any,
        timestamp: `${dayA}T10:00:00.000Z`,
        action:    'partial',
        data: [
          { symbol: 'XBTUSD', id: 1, side: 'Buy',  price:  99, size: 10, timestamp: `${dayA}T10:00:00.000Z` },
          { symbol: 'XBTUSD', id: 2, side: 'Sell', price: 101, size:  5, timestamp: `${dayA}T10:00:00.000Z` },
        ],
      },
      {
        _id: idIn(dayA, 2) as any,
        timestamp: `${dayA}T11:00:00.000Z`,
        action:    'update',
        data: [
          { symbol: 'XBTUSD', id: 1, side: 'Buy', size: 20 },
        ],
      },
      {
        _id: idIn(dayA, 3) as any,
        timestamp: `${dayA}T12:00:00.000Z`,
        action:    'delete',
        data: [
          { symbol: 'XBTUSD', id: 2, side: 'Sell' },
        ],
      },
      {
        _id: idIn(dayB, 1) as any,
        timestamp: `${dayB}T09:00:00.000Z`,
        action:    'insert',
        data: [
          { symbol: 'XBTUSD', id: 3, side: 'Sell', price: 102, size: 7, timestamp: `${dayB}T09:00:00.000Z` },
        ],
      },
    ]);

    await distillPartials(db);

    const partial = await db.collection(PARTIALS).findOne({ _id: `orderBookL2-${dayB}` } as any);

    expect(partial).not.toBeNull();
    expect(partial!.date).toBe(dayB);
    expect(partial!.keys).toEqual(['symbol', 'id', 'side']);

    const midB = `${dayB}T00:00:00.000Z`;
    const data = (partial!.data as any[]).sort((a, b) => a.id - b.id);

    // id=2 was deleted; id=1 reflects the update (size:20); id=3 not yet included (it's a dayB event).
    expect(data).toEqual([
      { symbol: 'XBTUSD', id: 1, side: 'Buy', price: 99, size: 20, timestamp: midB },
    ]);
  });
});
