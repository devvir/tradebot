import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoClient, Db } from 'mongodb';
import {
  _test_periodToTimestamp,
  _test_addDays,
  _test_buildPipeline,
  _test_generate1m,
  _test_generateCoarser,
  _test_COARSER_BINS,
} from '../../src/distillers/quote';
import { startOfDayId } from '../../src/utils/ids';

const { mongoPort } = JSON.parse(
  readFileSync(resolve(__dirname, '../.ports.json'), 'utf8'),
);

const mongoUrl = `mongodb://root:root@localhost:${mongoPort}/test_quote?authSource=admin`;
const DB_NAME  = 'test_quote';

const SOURCE  = 'quote';
const BIN1M   = 'quoteBin1m';
const BIN5M   = 'quoteBin5m';
const BIN1H   = 'quoteBin1h';
const BIN1D   = 'quoteBin1d';

const ALL_COLLS = [SOURCE, BIN1M, BIN5M, BIN1H, BIN1D];

const DATE  = '2020-01-01';
const D     = startOfDayId(DATE);
const D_P1  = startOfDayId('2020-01-02');

/** Insert a quote into the source collection. */
const insertQuote = (
  db:        Db,
  id:        number,
  ts:        string,
  overrides: Record<string, unknown> = {},
) =>
  db.collection(SOURCE).insertOne({
    _id:       id as any,
    timestamp: ts,
    symbol:    'XBTUSD',
    ...overrides,
  });

describe('distillQuotes', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    client = new MongoClient(mongoUrl);
    await client.connect();
    db = client.db(DB_NAME);
  });

  afterAll(async () => {
    await client?.close();
  });

  beforeEach(async () => {
    await Promise.all(ALL_COLLS.map(c => db.collection(c).deleteMany({})));
  });

  // ── Unit: periodToTimestamp ──────────────────────────────────────────────

  describe('periodToTimestamp', () => {
    it('converts period to bin timestamp (end of minute)', () => {
      expect(_test_periodToTimestamp('2014-11-22T16:59')).toBe('2014-11-22T17:00:00.000Z');
    });

    it('handles midnight rollover', () => {
      expect(_test_periodToTimestamp('2014-11-22T23:59')).toBe('2014-11-23T00:00:00.000Z');
    });

    it('handles start of day', () => {
      expect(_test_periodToTimestamp('2014-11-22T00:00')).toBe('2014-11-22T00:01:00.000Z');
    });
  });

  // ── Unit: addDays ────────────────────────────────────────────────────────

  describe('addDays', () => {
    it('adds N days to a date string', () => {
      expect(_test_addDays('2024-01-15', 15)).toBe('2024-01-30');
    });

    it('handles month boundary', () => {
      expect(_test_addDays('2024-01-25', 15)).toBe('2024-02-09');
    });

    it('handles year boundary', () => {
      expect(_test_addDays('2024-12-25', 15)).toBe('2025-01-09');
    });

    it('works with 1 day', () => {
      expect(_test_addDays('2024-01-31', 1)).toBe('2024-02-01');
    });
  });

  // ── Unit: pipeline aggregation ───────────────────────────────────────────

  describe('pipeline', () => {
    it('extracts last ask and last bid per minute', async () => {
      await insertQuote(db, D + 1, `${DATE}T13:43:10.000000000`, { bidPrice: 100, bidSize: 5 });
      await insertQuote(db, D + 2, `${DATE}T13:43:30.000000000`, { askPrice: 200, askSize: 10, bidPrice: 110, bidSize: 8 });

      const pipeline = _test_buildPipeline(`${DATE}T00:00:00`, '2020-01-02T00:00:00');
      const results  = await db.collection(SOURCE).aggregate(pipeline).toArray();

      expect(results).toHaveLength(1);

      const r = results[0]!;

      expect(r.group.period).toBe(`${DATE}T13:43`);
      expect(r.group.symbol).toBe('XBTUSD');
      expect(r.ask).toEqual({ _id: D + 2, askPrice: 200, askSize: 10 });
      expect(r.bid).toEqual({ _id: D + 2, bidPrice: 110, bidSize: 8 });
    });

    it('picks last ask and last bid independently when from different docs', async () => {
      await insertQuote(db, D + 1, `${DATE}T13:43:05.000000000`, { bidPrice: 100, bidSize: 5 });
      await insertQuote(db, D + 2, `${DATE}T13:43:15.000000000`, { askPrice: 200, askSize: 10 });
      await insertQuote(db, D + 3, `${DATE}T13:43:25.000000000`, { bidPrice: 110, bidSize: 8 });

      const pipeline = _test_buildPipeline(`${DATE}T00:00:00`, '2020-01-02T00:00:00');
      const results  = await db.collection(SOURCE).aggregate(pipeline).toArray();

      expect(results[0]!.ask).toEqual({ _id: D + 2, askPrice: 200, askSize: 10 });
      expect(results[0]!.bid).toEqual({ _id: D + 3, bidPrice: 110, bidSize: 8 });
    });

    it('nulls out ask when no docs have askPrice', async () => {
      await insertQuote(db, D + 1, `${DATE}T13:43:05.000000000`, { bidPrice: 100, bidSize: 5 });

      const pipeline = _test_buildPipeline(`${DATE}T00:00:00`, '2020-01-02T00:00:00');
      const results  = await db.collection(SOURCE).aggregate(pipeline).toArray();

      expect(results[0]!.ask).toBeNull();
      expect(results[0]!.bid).toEqual({ _id: D + 1, bidPrice: 100, bidSize: 5 });
    });

    it('nulls out bid when no docs have bidPrice', async () => {
      await insertQuote(db, D + 1, `${DATE}T13:43:05.000000000`, { askPrice: 200, askSize: 10 });

      const pipeline = _test_buildPipeline(`${DATE}T00:00:00`, '2020-01-02T00:00:00');
      const results  = await db.collection(SOURCE).aggregate(pipeline).toArray();

      expect(results[0]!.bid).toBeNull();
      expect(results[0]!.ask).toEqual({ _id: D + 1, askPrice: 200, askSize: 10 });
    });

    it('groups by symbol independently', async () => {
      await insertQuote(db, D + 1, `${DATE}T13:43:10.000000000`, { symbol: 'XBTUSD', bidPrice: 100, askPrice: 200 });
      await insertQuote(db, D + 2, `${DATE}T13:43:20.000000000`, { symbol: 'ETHUSD', bidPrice: 50,  askPrice: 60  });

      const pipeline = _test_buildPipeline(`${DATE}T00:00:00`, '2020-01-02T00:00:00');
      const results  = await db.collection(SOURCE).aggregate(pipeline).toArray();

      expect(results).toHaveLength(2);

      const xbt = results.find(r => r.group.symbol === 'XBTUSD')!;
      const eth = results.find(r => r.group.symbol === 'ETHUSD')!;

      expect(xbt.bid.bidPrice).toBe(100);
      expect(eth.bid.bidPrice).toBe(50);
    });

    it('separates different minutes into different groups', async () => {
      await insertQuote(db, D + 1, `${DATE}T13:43:10.000000000`, { bidPrice: 100 });
      await insertQuote(db, D + 2, `${DATE}T13:44:10.000000000`, { bidPrice: 110 });

      const pipeline = _test_buildPipeline(`${DATE}T00:00:00`, '2020-01-02T00:00:00');
      const results  = await db.collection(SOURCE).aggregate(pipeline).toArray();

      expect(results).toHaveLength(2);
      expect(results.map(r => r.group.period).sort()).toEqual([`${DATE}T13:43`, `${DATE}T13:44`]);
    });
  });

  // ── Integration: quoteBin1m ──────────────────────────────────────────────

  describe('quoteBin1m', () => {
    it('generates bins with correct shape and timestamps', async () => {
      await insertQuote(db, D + 1, `${DATE}T13:43:10.000000000`, { bidPrice: 100, bidSize: 5, askPrice: 200, askSize: 10 });
      await insertQuote(db, D + 2, `${DATE}T13:43:50.000000000`, { bidPrice: 110, bidSize: 8, askPrice: 210, askSize: 12 });
      await insertQuote(db, D + 3, `${DATE}T13:44:05.000000000`, { askPrice: 220, askSize: 15 });

      await _test_generate1m(db, DATE);

      const bins = await db.collection(BIN1M).find().sort({ timestamp: 1 }).toArray();

      expect(bins).toHaveLength(2);

      // Minute 13:43 — last values from doc 2
      expect(bins[0]!._id).toBe(D + 2);
      expect(bins[0]!.timestamp).toBe(`${DATE}T13:44:00.000Z`);
      expect(bins[0]!.bidPrice).toBe(110);
      expect(bins[0]!.askPrice).toBe(210);
      expect(bins[0]!.pool).toBe('Primary');

      // Minute 13:44 — only ask from doc 3, no bid
      expect(bins[1]!.timestamp).toBe(`${DATE}T13:45:00.000Z`);
      expect(bins[1]!.askPrice).toBe(220);
      expect(bins[1]!.bidPrice).toBeUndefined();
    });

    it('handles multi-symbol data', async () => {
      await insertQuote(db, D + 1, `${DATE}T10:00:05.000000000`, { symbol: 'XBTUSD', bidPrice: 100 });
      await insertQuote(db, D + 2, `${DATE}T10:00:15.000000000`, { symbol: 'ETHUSD', askPrice: 60 });

      await _test_generate1m(db, DATE);

      const bins = await db.collection(BIN1M).find().sort({ symbol: 1 }).toArray();

      expect(bins).toHaveLength(2);
      expect(bins.find(b => b.symbol === 'ETHUSD')!.askPrice).toBe(60);
      expect(bins.find(b => b.symbol === 'XBTUSD')!.bidPrice).toBe(100);
    });

    it('skips quotes with neither ask nor bid', async () => {
      await insertQuote(db, D + 1, `${DATE}T10:00:05.000000000`, {});
      await insertQuote(db, D + 2, `${DATE}T10:01:05.000000000`, { askPrice: 200, askSize: 10 });

      await _test_generate1m(db, DATE);

      const bins = await db.collection(BIN1M).find().sort({ timestamp: 1 }).toArray();

      expect(bins).toHaveLength(1);
      expect(bins[0]!.askPrice).toBe(200);
    });

    it('does nothing when source collection is empty', async () => {
      await _test_generate1m(db, DATE);

      expect(await db.collection(BIN1M).countDocuments()).toBe(0);
    });

    it('is idempotent — re-running the same day does not duplicate', async () => {
      await insertQuote(db, D + 1, `${DATE}T10:00:05.000000000`, { bidPrice: 100, bidSize: 5 });

      await _test_generate1m(db, DATE);
      await _test_generate1m(db, DATE);

      expect(await db.collection(BIN1M).countDocuments()).toBe(1);
    });

    it('scopes to the given day only', async () => {
      await insertQuote(db, D + 1,    `${DATE}T23:59:10.000000000`,      { bidPrice: 100 });
      await insertQuote(db, D_P1 + 1, '2020-01-02T00:00:05.000000000', { bidPrice: 110 });

      await _test_generate1m(db, DATE);

      const bins = await db.collection(BIN1M).find().toArray();

      // Only the quote from DATE should produce a bin; the next-day quote is excluded
      expect(bins).toHaveLength(1);
      expect(bins[0]!.bidPrice).toBe(100);
    });
  });

  // ── Integration: coarser bins ────────────────────────────────────────────

  describe('coarser bins', () => {
    const cfg5m  = _test_COARSER_BINS.find(c => c.target === 'quoteBin5m')!;
    const cfg1h  = _test_COARSER_BINS.find(c => c.target === 'quoteBin1h')!;
    const cfg1d  = _test_COARSER_BINS.find(c => c.target === 'quoteBin1d')!;

    it('quoteBin5m: selects 1m bins at 5-minute timestamps', async () => {
      // Insert 1m bins directly at known timestamps
      await db.collection(BIN1M).insertMany([
        { _id: 1, timestamp: `${DATE}T10:01:00.000Z`, symbol: 'XBTUSD', bidPrice: 100 },  // not 5m
        { _id: 2, timestamp: `${DATE}T10:05:00.000Z`, symbol: 'XBTUSD', bidPrice: 105 },  // 5m
        { _id: 3, timestamp: `${DATE}T10:10:00.000Z`, symbol: 'XBTUSD', bidPrice: 110 },  // 5m
      ] as any[]);

      await _test_generateCoarser(db, DATE, cfg5m);

      const bins = await db.collection(BIN5M).find().sort({ timestamp: 1 }).toArray();

      expect(bins).toHaveLength(2);
      expect(bins[0]!.timestamp).toBe(`${DATE}T10:05:00.000Z`);
      expect(bins[1]!.timestamp).toBe(`${DATE}T10:10:00.000Z`);
    });

    it('quoteBin1h: selects 1m bins at hour timestamps', async () => {
      await db.collection(BIN1M).insertMany([
        { _id: 1, timestamp: `${DATE}T10:05:00.000Z`, symbol: 'XBTUSD', bidPrice: 100 },  // not 1h
        { _id: 2, timestamp: `${DATE}T10:00:00.000Z`, symbol: 'XBTUSD', bidPrice: 105 },  // 1h
        { _id: 3, timestamp: `${DATE}T11:00:00.000Z`, symbol: 'XBTUSD', bidPrice: 110 },  // 1h
      ] as any[]);

      await _test_generateCoarser(db, DATE, cfg1h);

      const bins = await db.collection(BIN1H).find().sort({ timestamp: 1 }).toArray();

      expect(bins).toHaveLength(2);
      expect(bins[0]!.timestamp).toBe(`${DATE}T10:00:00.000Z`);
      expect(bins[1]!.timestamp).toBe(`${DATE}T11:00:00.000Z`);
    });

    it('quoteBin1d: selects the single day-boundary bin', async () => {
      await db.collection(BIN1M).insertMany([
        { _id: 1, timestamp: `${DATE}T10:05:00.000Z`, symbol: 'XBTUSD', bidPrice: 100 },       // not 1d
        { _id: 2, timestamp: '2020-01-02T00:00:00.000Z', symbol: 'XBTUSD', bidPrice: 110 },    // 1d boundary bin for DATE
      ] as any[]);

      await _test_generateCoarser(db, DATE, cfg1d);

      const bins = await db.collection(BIN1D).find().toArray();

      expect(bins).toHaveLength(1);
      expect(bins[0]!.timestamp).toBe('2020-01-02T00:00:00.000Z');
    });

    it('coarser bins are idempotent', async () => {
      await db.collection(BIN1M).insertOne(
        { _id: 1, timestamp: `${DATE}T10:05:00.000Z`, symbol: 'XBTUSD', bidPrice: 105 } as any,
      );

      await _test_generateCoarser(db, DATE, cfg5m);
      await _test_generateCoarser(db, DATE, cfg5m);

      expect(await db.collection(BIN5M).countDocuments()).toBe(1);
    });
  });
});
