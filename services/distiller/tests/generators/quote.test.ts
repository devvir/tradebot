import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoClient, Db } from 'mongodb';
import { registry } from '@devvir/service-kit';
import { distillQuotes, _test_periodToTimestamp, _test_addDays, _test_buildPipeline } from '../../src/generators/quote';

const { mongoPort } = JSON.parse(
  readFileSync(resolve(__dirname, '../.ports.json'), 'utf8'),
);

const mongoUrl = `mongodb://root:root@localhost:${mongoPort}/test_quote?authSource=admin`;

const SOURCE  = 'quote';
const TARGET  = 'quoteBin1m';
const DB_NAME = 'test_quote';

/** Insert a quote into the source collection. */
const insertQuote = (
  db: Db,
  id: number,
  ts: string,
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
    db = client.db();

    registry.add({
      spec:      () => ({ name: 'distiller' }),
      config:    () => ({ database: DB_NAME }),
      providers: { get: () => client },
    } as any);
  });

  afterAll(async () => {
    registry.clear();
    await client?.close();
  });

  beforeEach(async () => {
    await db.collection(SOURCE).deleteMany({});
    await db.collection(TARGET).deleteMany({});
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

  // ── Unit: addDays ───────────────────────────────────────────────────────

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

  // ── Pipeline: basic aggregation ─────────────────────────────────────────

  describe('pipeline — basic aggregation', () => {
    it('extracts last ask and last bid per minute', async () => {
      await insertQuote(db, 1, '2020-01-01T13:43:10.000000000', { bidPrice: 100, bidSize: 5 });
      await insertQuote(db, 2, '2020-01-01T13:43:30.000000000', { askPrice: 200, askSize: 10, bidPrice: 110, bidSize: 8 });

      const pipeline = _test_buildPipeline('2020-01-01T00:00:00', '2020-01-02T00:00:00');
      const results = await db.collection(SOURCE).aggregate(pipeline).toArray();

      expect(results).toHaveLength(1);

      const r = results[0]!;

      expect(r.group.period).toBe('2020-01-01T13:43');
      expect(r.group.symbol).toBe('XBTUSD');
      expect(r.ask).toEqual({ _id: 2, askPrice: 200, askSize: 10 });
      expect(r.bid).toEqual({ _id: 2, bidPrice: 110, bidSize: 8 });
    });

    it('picks last ask and last bid independently when from different docs', async () => {
      await insertQuote(db, 1, '2020-01-01T13:43:05.000000000', { bidPrice: 100, bidSize: 5 });
      await insertQuote(db, 2, '2020-01-01T13:43:15.000000000', { askPrice: 200, askSize: 10 });
      await insertQuote(db, 3, '2020-01-01T13:43:25.000000000', { bidPrice: 110, bidSize: 8 });

      const pipeline = _test_buildPipeline('2020-01-01T00:00:00', '2020-01-02T00:00:00');
      const results = await db.collection(SOURCE).aggregate(pipeline).toArray();

      expect(results).toHaveLength(1);

      const r = results[0]!;

      expect(r.ask).toEqual({ _id: 2, askPrice: 200, askSize: 10 });
      expect(r.bid).toEqual({ _id: 3, bidPrice: 110, bidSize: 8 });
    });

    it('nulls out ask when no docs have askPrice', async () => {
      await insertQuote(db, 1, '2020-01-01T13:43:05.000000000', { bidPrice: 100, bidSize: 5 });

      const pipeline = _test_buildPipeline('2020-01-01T00:00:00', '2020-01-02T00:00:00');
      const results = await db.collection(SOURCE).aggregate(pipeline).toArray();

      expect(results).toHaveLength(1);
      expect(results[0]!.ask).toBeNull();
      expect(results[0]!.bid).toEqual({ _id: 1, bidPrice: 100, bidSize: 5 });
    });

    it('nulls out bid when no docs have bidPrice', async () => {
      await insertQuote(db, 1, '2020-01-01T13:43:05.000000000', { askPrice: 200, askSize: 10 });

      const pipeline = _test_buildPipeline('2020-01-01T00:00:00', '2020-01-02T00:00:00');
      const results = await db.collection(SOURCE).aggregate(pipeline).toArray();

      expect(results).toHaveLength(1);
      expect(results[0]!.bid).toBeNull();
      expect(results[0]!.ask).toEqual({ _id: 1, askPrice: 200, askSize: 10 });
    });

    it('groups by symbol independently', async () => {
      await insertQuote(db, 1, '2020-01-01T13:43:10.000000000', {
        symbol: 'XBTUSD', bidPrice: 100, bidSize: 5, askPrice: 200, askSize: 10,
      });
      await insertQuote(db, 2, '2020-01-01T13:43:20.000000000', {
        symbol: 'ETHUSD', bidPrice: 50, bidSize: 3, askPrice: 60, askSize: 7,
      });

      const pipeline = _test_buildPipeline('2020-01-01T00:00:00', '2020-01-02T00:00:00');
      const results = await db.collection(SOURCE).aggregate(pipeline).toArray();

      expect(results).toHaveLength(2);

      const xbt = results.find(r => r.group.symbol === 'XBTUSD')!;
      const eth = results.find(r => r.group.symbol === 'ETHUSD')!;

      expect(xbt.bid.bidPrice).toBe(100);
      expect(xbt.ask.askPrice).toBe(200);
      expect(eth.bid.bidPrice).toBe(50);
      expect(eth.ask.askPrice).toBe(60);
    });

    it('separates different minutes into different groups', async () => {
      await insertQuote(db, 1, '2020-01-01T13:43:10.000000000', { bidPrice: 100, bidSize: 5 });
      await insertQuote(db, 2, '2020-01-01T13:44:10.000000000', { bidPrice: 110, bidSize: 8 });

      const pipeline = _test_buildPipeline('2020-01-01T00:00:00', '2020-01-02T00:00:00');
      const results = await db.collection(SOURCE).aggregate(pipeline).toArray();

      expect(results).toHaveLength(2);

      const periods = results.map(r => r.group.period).sort();

      expect(periods).toEqual(['2020-01-01T13:43', '2020-01-01T13:44']);
    });
  });

  // ── Integration: full distillQuotes flow ────────────────────────────────

  describe('integration — full flow', () => {
    it('generates quoteBin1m with correct shape and timestamps', async () => {
      // Two complete minutes (13:43 and 13:44) + one quote in 13:45 to seal 13:44
      await insertQuote(db, 1, '2020-01-01T13:43:10.000000000', {
        bidPrice: 100, bidSize: 5, askPrice: 200, askSize: 10,
      });
      await insertQuote(db, 2, '2020-01-01T13:43:50.000000000', {
        bidPrice: 110, bidSize: 8, askPrice: 210, askSize: 12,
      });
      await insertQuote(db, 3, '2020-01-01T13:44:05.000000000', {
        askPrice: 220, askSize: 15,
      });
      await insertQuote(db, 4, '2020-01-01T13:45:01.000000000', {
        bidPrice: 120, bidSize: 6,
      });

      await distillQuotes(client, DB_NAME);

      const bins = await db.collection(TARGET).find().sort({ timestamp: 1 }).toArray();

      // Minutes 13:43 and 13:44 are complete. Minute 13:45 is the tip (excluded).
      expect(bins).toHaveLength(2);

      // Minute 13:43 — last values from doc 2 (highest _id with both sides)
      const bin0 = bins[0]!;

      expect(bin0._id).toBe(2);
      expect(bin0.timestamp).toBe('2020-01-01T13:44:00.000Z');
      expect(bin0.symbol).toBe('XBTUSD');
      expect(bin0.bidPrice).toBe(110);
      expect(bin0.bidSize).toBe(8);
      expect(bin0.askPrice).toBe(210);
      expect(bin0.askSize).toBe(12);
      expect(bin0.pool).toBe('Primary');

      // Minute 13:44 — only ask from doc 3, no bid
      const bin1 = bins[1]!;

      expect(bin1._id).toBe(3);
      expect(bin1.timestamp).toBe('2020-01-01T13:45:00.000Z');
      expect(bin1.symbol).toBe('XBTUSD');
      expect(bin1.askPrice).toBe(220);
      expect(bin1.askSize).toBe(15);
      expect(bin1.bidPrice).toBeUndefined();
      expect(bin1.bidSize).toBeUndefined();
      expect(bin1.pool).toBe('Primary');
    });

    it('excludes the tip minute (last incomplete minute)', async () => {
      // Only one minute of data — it's the tip, so nothing should be generated
      await insertQuote(db, 1, '2020-01-01T10:00:05.000000000', {
        bidPrice: 100, bidSize: 5, askPrice: 200, askSize: 10,
      });
      await insertQuote(db, 2, '2020-01-01T10:00:55.000000000', {
        bidPrice: 110, bidSize: 8,
      });

      await distillQuotes(client, DB_NAME);

      const bins = await db.collection(TARGET).find().toArray();

      // Both quotes are in the same minute — that minute is the tip → excluded
      expect(bins).toHaveLength(0);
    });

    it('resumes from last bin — does not duplicate', async () => {
      await insertQuote(db, 1, '2020-01-01T10:00:05.000000000', {
        bidPrice: 100, bidSize: 5, askPrice: 200, askSize: 10,
      });
      await insertQuote(db, 2, '2020-01-01T10:01:05.000000000', {
        bidPrice: 110, bidSize: 8,
      });
      await insertQuote(db, 3, '2020-01-01T10:02:05.000000000', {
        askPrice: 220, askSize: 15,
      });

      // First run
      await distillQuotes(client, DB_NAME);

      const firstCount = await db.collection(TARGET).countDocuments();

      // Second run — should not duplicate
      await distillQuotes(client, DB_NAME);

      const secondCount = await db.collection(TARGET).countDocuments();

      expect(secondCount).toBe(firstCount);
    });

    it('handles multi-symbol data', async () => {
      await insertQuote(db, 1, '2020-01-01T10:00:05.000000000', {
        symbol: 'XBTUSD', bidPrice: 100, bidSize: 5,
      });
      await insertQuote(db, 2, '2020-01-01T10:00:15.000000000', {
        symbol: 'ETHUSD', askPrice: 60, askSize: 7,
      });
      // Seal the minute with a quote in the next minute
      await insertQuote(db, 3, '2020-01-01T10:01:00.000000000', {
        symbol: 'XBTUSD', bidPrice: 105, bidSize: 6,
      });

      await distillQuotes(client, DB_NAME);

      const bins = await db.collection(TARGET).find().sort({ symbol: 1 }).toArray();

      // Minute 10:00 is complete (sealed by doc 3 in 10:01). Both symbols get a bin.
      expect(bins).toHaveLength(2);

      const eth = bins.find(b => b.symbol === 'ETHUSD')!;
      const xbt = bins.find(b => b.symbol === 'XBTUSD')!;

      expect(eth.askPrice).toBe(60);
      expect(eth.bidPrice).toBeUndefined();
      expect(xbt.bidPrice).toBe(100);
      expect(xbt.askPrice).toBeUndefined();
    });

    it('skips quotes with neither ask nor bid', async () => {
      // Minute 10:00: doc with no ask/bid
      await insertQuote(db, 1, '2020-01-01T10:00:05.000000000', {});
      // Minute 10:01: doc with ask
      await insertQuote(db, 2, '2020-01-01T10:01:05.000000000', { askPrice: 200, askSize: 10 });
      // Minute 10:02: seal minute 10:01
      await insertQuote(db, 3, '2020-01-01T10:02:01.000000000', { bidPrice: 100, bidSize: 5 });

      await distillQuotes(client, DB_NAME);

      const bins = await db.collection(TARGET).find().sort({ timestamp: 1 }).toArray();

      // Minute 10:00 has no ask/bid → skipped. Minute 10:01 has ask → bin.
      // Minute 10:02 is the tip → excluded.
      expect(bins).toHaveLength(1);
      expect(bins[0]!.timestamp).toBe('2020-01-01T10:02:00.000Z');
      expect(bins[0]!.askPrice).toBe(200);
    });

    it('returns early when source collection is empty', async () => {
      await distillQuotes(client, DB_NAME);

      const bins = await db.collection(TARGET).find().toArray();

      expect(bins).toHaveLength(0);
    });

    it('processes data spanning multiple days', async () => {
      await insertQuote(db, 1, '2020-01-01T23:59:10.000000000', {
        bidPrice: 100, bidSize: 5,
      });
      await insertQuote(db, 2, '2020-01-02T00:00:05.000000000', {
        askPrice: 200, askSize: 10,
      });
      await insertQuote(db, 3, '2020-01-02T00:01:01.000000000', {
        bidPrice: 110, bidSize: 8,
      });

      await distillQuotes(client, DB_NAME);

      const bins = await db.collection(TARGET).find().sort({ timestamp: 1 }).toArray();

      // Minute 23:59 (Jan 1) and 00:00 (Jan 2) are complete. 00:01 is tip.
      expect(bins).toHaveLength(2);
      expect(bins[0]!.timestamp).toBe('2020-01-02T00:00:00.000Z'); // Jan 1, 23:59 bin
      expect(bins[1]!.timestamp).toBe('2020-01-02T00:01:00.000Z'); // Jan 2, 00:00 bin
    });
  });
});
