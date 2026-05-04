import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoClient, Db } from 'mongodb';
import { registry } from '@devvir/service-kit';
import { distillTrades } from '../../src/generators/trade';

const { mongoPort } = JSON.parse(
  readFileSync(resolve(__dirname, '../.ports.json'), 'utf8'),
);

const mongoUrl = `mongodb://root:root@localhost:${mongoPort}/test_trade?authSource=admin`;
const DB_NAME  = 'test_trade';

const SOURCE   = 'trade';
const BIN1M    = 'tradeBin1m';
const BIN5M    = 'tradeBin5m';
const BIN1H    = 'tradeBin1h';
const BIN1D    = 'tradeBin1d';

const ALL_COLLS = [SOURCE, BIN1M, BIN5M, BIN1H, BIN1D];

/** Insert a raw trade. _id is the sequencing key used for open/close ordering. */
const insertTrade = (
  db:        Db,
  id:        number,
  ts:        string,
  price:     number,
  size:      number,
  overrides: Record<string, unknown> = {},
) =>
  db.collection(SOURCE).insertOne({
    _id:             id as any,
    timestamp:       ts,
    symbol:          'XBTUSD',
    side:            'Buy',
    price,
    size,
    grossValue:      Math.round(size / price * 1e8),
    homeNotional:    size / price,
    foreignNotional: size,
    ...overrides,
  });

describe('distillTrades', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    client = new MongoClient(mongoUrl);
    await client.connect();
    db = client.db(DB_NAME);

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
    await Promise.all(ALL_COLLS.map(c => db.collection(c).deleteMany({})));
  });

  // ── Empty source ─────────────────────────────────────────────────────────

  it('does nothing when there are no trades', async () => {
    await distillTrades(client, DB_NAME);

    const count = await db.collection(BIN1M).countDocuments();

    expect(count).toBe(0);
  });

  // ── 1m bins ──────────────────────────────────────────────────────────────

  describe('tradeBin1m', () => {
    it('produces one bin per complete minute', async () => {
      // Two complete minutes + one trade sealing the second
      await insertTrade(db, 1, '2020-01-01T10:00:10.000000000Z', 100, 10);
      await insertTrade(db, 2, '2020-01-01T10:00:50.000000000Z', 110, 20);
      await insertTrade(db, 3, '2020-01-01T10:01:15.000000000Z', 120, 5);
      await insertTrade(db, 4, '2020-01-01T10:02:00.000000000Z', 130, 1); // seals 10:01

      await distillTrades(client, DB_NAME);

      const bins = await db.collection(BIN1M).find().sort({ timestamp: 1 }).toArray();

      expect(bins).toHaveLength(2);

      expect(bins[0]!.timestamp).toBe('2020-01-01T10:01:00.000Z');
      expect(bins[1]!.timestamp).toBe('2020-01-01T10:02:00.000Z');
    });

    it('excludes the tip minute (last incomplete minute)', async () => {
      // All trades in the same minute — that minute is the tip, nothing emitted
      await insertTrade(db, 1, '2020-01-01T10:00:05.000000000Z', 100, 10);
      await insertTrade(db, 2, '2020-01-01T10:00:55.000000000Z', 110, 5);

      await distillTrades(client, DB_NAME);

      expect(await db.collection(BIN1M).countDocuments()).toBe(0);
    });

    it('computes OHLCV correctly', async () => {
      await insertTrade(db, 1, '2020-01-01T10:00:10.000000000Z', 100, 10);
      await insertTrade(db, 2, '2020-01-01T10:00:20.000000000Z', 130, 5);
      await insertTrade(db, 3, '2020-01-01T10:00:40.000000000Z', 90,  8);
      await insertTrade(db, 4, '2020-01-01T10:00:55.000000000Z', 120, 3);
      await insertTrade(db, 5, '2020-01-01T10:01:00.000000000Z', 200, 1); // seals 10:00

      await distillTrades(client, DB_NAME);

      const bin = await db.collection(BIN1M).findOne({ timestamp: '2020-01-01T10:01:00.000Z' });

      expect(bin).not.toBeNull();
      expect(bin!.open).toBe(100);   // first trade
      expect(bin!.high).toBe(130);   // max
      expect(bin!.low).toBe(90);     // min
      expect(bin!.close).toBe(120);  // last trade
      expect(bin!.trades).toBe(4);
      expect(bin!.volume).toBe(26);  // 10+5+8+3
      expect(bin!.lastSize).toBe(3);
    });

    it('sets _id to the first trade _id in the minute', async () => {
      await insertTrade(db, 10, '2020-01-01T10:00:10.000000000Z', 100, 5);
      await insertTrade(db, 11, '2020-01-01T10:00:30.000000000Z', 110, 5);
      await insertTrade(db, 12, '2020-01-01T10:01:00.000000000Z', 120, 1);

      await distillTrades(client, DB_NAME);

      const bin = await db.collection(BIN1M).findOne({ timestamp: '2020-01-01T10:01:00.000Z' });

      expect(bin!._id).toBe(10);
    });

    it('computes vwap as sum(price*size)/volume', async () => {
      // 100*10 + 200*10 = 3000, volume = 20, vwap = 150
      await insertTrade(db, 1, '2020-01-01T10:00:10.000000000Z', 100, 10);
      await insertTrade(db, 2, '2020-01-01T10:00:50.000000000Z', 200, 10);
      await insertTrade(db, 3, '2020-01-01T10:01:00.000000000Z', 150, 1);

      await distillTrades(client, DB_NAME);

      const bin = await db.collection(BIN1M).findOne({ timestamp: '2020-01-01T10:01:00.000Z' });

      expect(bin!.vwap).toBe(150);
    });

    it('groups symbols independently', async () => {
      await insertTrade(db, 1, '2020-01-01T10:00:10.000000000Z', 100, 5, { symbol: 'XBTUSD' });
      await insertTrade(db, 2, '2020-01-01T10:00:20.000000000Z', 50,  3, { symbol: 'ETHUSD' });
      await insertTrade(db, 3, '2020-01-01T10:01:00.000000000Z', 101, 1, { symbol: 'XBTUSD' });
      await insertTrade(db, 4, '2020-01-01T10:01:00.000000000Z', 51,  1, { symbol: 'ETHUSD' });

      await distillTrades(client, DB_NAME);

      const bins = await db.collection(BIN1M).find().sort({ symbol: 1 }).toArray();

      expect(bins).toHaveLength(2);
      expect(bins.find(b => b.symbol === 'XBTUSD')!.close).toBe(100);
      expect(bins.find(b => b.symbol === 'ETHUSD')!.close).toBe(50);
    });

    it('is idempotent — re-running does not duplicate', async () => {
      await insertTrade(db, 1, '2020-01-01T10:00:10.000000000Z', 100, 5);
      await insertTrade(db, 2, '2020-01-01T10:01:00.000000000Z', 110, 1);

      await distillTrades(client, DB_NAME);
      await distillTrades(client, DB_NAME);

      expect(await db.collection(BIN1M).countDocuments()).toBe(1);
    });

    it('resumes from last bin on second run', async () => {
      await insertTrade(db, 1, '2020-01-01T10:00:10.000000000Z', 100, 5);
      await insertTrade(db, 2, '2020-01-01T10:01:00.000000000Z', 110, 1);

      await distillTrades(client, DB_NAME);

      // Add a new complete minute
      await insertTrade(db, 3, '2020-01-01T10:01:30.000000000Z', 120, 3);
      await insertTrade(db, 4, '2020-01-01T10:02:00.000000000Z', 130, 1);

      await distillTrades(client, DB_NAME);

      expect(await db.collection(BIN1M).countDocuments()).toBe(2);
    });

    it('applies the BitMEX open convention: open = previous close', async () => {
      // Minute 10:00: close = 110. Minute 10:01: first trade price = 200, but open should be 110.
      await insertTrade(db, 1, '2020-01-01T10:00:10.000000000Z', 100, 5);
      await insertTrade(db, 2, '2020-01-01T10:00:50.000000000Z', 110, 5);
      await insertTrade(db, 3, '2020-01-01T10:01:10.000000000Z', 200, 5);
      await insertTrade(db, 4, '2020-01-01T10:02:00.000000000Z', 210, 1);

      await distillTrades(client, DB_NAME);

      const bins = await db.collection(BIN1M).find().sort({ timestamp: 1 }).toArray();

      expect(bins[0]!.close).toBe(110);
      expect(bins[1]!.open).toBe(110); // open = prev close, not 200
    });

    it('skips trades with missing or empty side', async () => {
      await insertTrade(db, 1, '2020-01-01T10:00:10.000000000Z', 100, 10);
      await insertTrade(db, 2, '2020-01-01T10:00:50.000000000Z', 200, 10, { side: '' });    // empty
      await insertTrade(db, 3, '2020-01-01T10:00:55.000000000Z', 300, 10, { side: null });  // null
      await insertTrade(db, 4, '2020-01-01T10:01:00.000000000Z', 150, 1);

      await distillTrades(client, DB_NAME);

      const bin = await db.collection(BIN1M).findOne({ timestamp: '2020-01-01T10:01:00.000Z' });

      // Only the trade with side='Buy' (id=1) should contribute
      expect(bin!.trades).toBe(1);
      expect(bin!.volume).toBe(10);
      expect(bin!.close).toBe(100);
    });

    it('first bin of the dataset keeps its own first trade as open', async () => {
      await insertTrade(db, 1, '2020-01-01T10:00:10.000000000Z', 100, 5);
      await insertTrade(db, 2, '2020-01-01T10:00:50.000000000Z', 110, 5);
      await insertTrade(db, 3, '2020-01-01T10:01:00.000000000Z', 120, 1);

      await distillTrades(client, DB_NAME);

      const bin = await db.collection(BIN1M).findOne({ timestamp: '2020-01-01T10:01:00.000Z' });

      expect(bin!.open).toBe(100);
    });
  });

  // ── 5m bins ──────────────────────────────────────────────────────────────

  describe('tradeBin5m', () => {
    it('aggregates 1m bins into 5m bins', async () => {
      // 5 complete minutes (10:00–10:04), sealed by a trade in 10:05
      for (let m = 0; m < 5; m++) {
        await insertTrade(db, m * 2 + 1, `2020-01-01T10:0${m}:10.000000000Z`, 100 + m, 10);
        await insertTrade(db, m * 2 + 2, `2020-01-01T10:0${m}:50.000000000Z`, 105 + m, 5);
      }

      await insertTrade(db, 11, '2020-01-01T10:05:00.000000000Z', 200, 1);

      await distillTrades(client, DB_NAME);

      const bins = await db.collection(BIN5M).find().sort({ timestamp: 1 }).toArray();

      expect(bins).toHaveLength(1);
      expect(bins[0]!.timestamp).toBe('2020-01-01T10:05:00.000Z');
    });

    it('spans minute boundaries correctly — 10:01–10:05 bin', async () => {
      // 5 complete minutes starting at 10:01, fitting in the 10:00–10:05 bucket
      for (let m = 1; m <= 5; m++) {
        const mm = String(m).padStart(2, '0');

        await insertTrade(db, m,      `2020-01-01T10:${mm}:10.000000000Z`, 100 + m, 5);
      }

      await insertTrade(db, 10, '2020-01-01T10:06:00.000000000Z', 200, 1);

      await distillTrades(client, DB_NAME);

      const bins5m = await db.collection(BIN5M).find().sort({ timestamp: 1 }).toArray();

      // Minutes 10:01–10:05 belong to the 10:05 5m bucket
      expect(bins5m).toHaveLength(1);
      expect(bins5m[0]!.timestamp).toBe('2020-01-01T10:05:00.000Z');
    });

    it('carries high/low/volume correctly from 1m to 5m', async () => {
      // minute 10:00: high=200, low=50, volume=20
      await insertTrade(db, 1, '2020-01-01T10:00:10.000000000Z', 50,  10);
      await insertTrade(db, 2, '2020-01-01T10:00:50.000000000Z', 200, 10);
      // minute 10:01: high=150, low=100, volume=10
      await insertTrade(db, 3, '2020-01-01T10:01:10.000000000Z', 100, 5);
      await insertTrade(db, 4, '2020-01-01T10:01:50.000000000Z', 150, 5);
      // filler in minute 10:04 — produces a 1m bin at 10:05:00.000Z so the
      // 5m aggregation range reaches the full 10:00–10:05 window
      await insertTrade(db, 5, '2020-01-01T10:04:10.000Z', 100, 1);
      // seal — must be past the 10:05 boundary
      await insertTrade(db, 6, '2020-01-01T10:05:30.000Z', 120, 1);

      await distillTrades(client, DB_NAME);

      const bin = await db.collection(BIN5M).findOne({ timestamp: '2020-01-01T10:05:00.000Z' });

      expect(bin!.high).toBe(200);
      expect(bin!.low).toBe(50);
      expect(bin!.volume).toBe(31); // 20 + 10 + 1 (filler)
    });
  });

  // ── 1h bins ──────────────────────────────────────────────────────────────

  describe('tradeBin1h', () => {
    it('aggregates 5m bins into 1h bins', async () => {
      // Fill minutes 00–59, seal with a trade in the next hour
      for (let m = 0; m < 60; m++) {
        const mm = String(m).padStart(2, '0');

        await insertTrade(db, m + 1, `2020-01-01T10:${mm}:10.000000000Z`, 100, 5);
      }

      await insertTrade(db, 61, '2020-01-01T11:00:00.000000000Z', 200, 1);

      await distillTrades(client, DB_NAME);

      const bins = await db.collection(BIN1H).find().sort({ timestamp: 1 }).toArray();

      expect(bins).toHaveLength(1);
      expect(bins[0]!.timestamp).toBe('2020-01-01T11:00:00.000Z');
    });
  });

  // ── 1d bins ──────────────────────────────────────────────────────────────

  describe('tradeBin1d', () => {
    it('aggregates 1h bins into 1d bins', async () => {
      // One trade per hour for 24 hours (nanosecond timestamps — testing ns handling)
      for (let h = 0; h < 24; h++) {
        const hh = String(h).padStart(2, '0');

        await insertTrade(db, h + 1, `2020-01-01T${hh}:00:10.000000000Z`, 100, 5);
      }

      // Trade in minute 23:59 — produces a 1m bin at 2020-01-02T00:00:00.000Z,
      // which is needed for the 5m→1h→1d chain to reach the day boundary
      await insertTrade(db, 25, '2020-01-01T23:59:30.000Z', 100, 5);
      // seal — well past the boundary so 23:59 is a completed minute
      await insertTrade(db, 26, '2020-01-02T00:01:00.000Z', 200, 1);

      await distillTrades(client, DB_NAME);

      const bins = await db.collection(BIN1D).find().sort({ timestamp: 1 }).toArray();

      expect(bins).toHaveLength(1);
      expect(bins[0]!.timestamp).toBe('2020-01-02T00:00:00.000Z');
    });
  });
});
