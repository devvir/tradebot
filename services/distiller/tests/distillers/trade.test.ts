import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoClient, Db } from 'mongodb';
import {
  _test_generate1m,
  _test_generate5m,
  _test_generate1h,
  _test_generate1d,
} from '../../src/distillers/trade';
import { startOfDayId } from '../../src/utils/ids';

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

const DATE     = '2020-01-01';
const DATE_P1  = '2020-01-02';   // day N+1
const DATE_P2  = '2020-01-03';   // day N+2 (for gap-fill tests)
const DATE_M1  = '2019-12-31';   // day N-1

const D     = startOfDayId(DATE);
const D_P1  = startOfDayId(DATE_P1);
const D_P2  = startOfDayId(DATE_P2);

/** Insert a raw trade into the source collection. */
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

/** Insert a pre-built 1m bin directly (used to simulate a prior day's output). */
const insertBin1m = (
  db:        Db,
  id:        number,
  ts:        string,
  symbol:    string,
  open:      number,
  close:     number,
  overrides: Record<string, unknown> = {},
) =>
  insertBin(db, BIN1M, id, ts, symbol, open, close, overrides);

/** Insert a pre-built bin into any bin collection. */
const insertBin = (
  db:        Db,
  coll:      string,
  id:        number,
  ts:        string,
  symbol:    string,
  open:      number,
  close:     number,
  overrides: Record<string, unknown> = {},
) =>
  db.collection(coll).insertOne({
    _id:       id as any,
    timestamp: ts,
    symbol,
    open,
    high:  close,
    low:   open,
    close,
    trades: 1,
    volume: 1,
    ...overrides,
  });

describe('distillTrades', () => {
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

  // ── tradeBin1m ────────────────────────────────────────────────────────────

  describe('tradeBin1m', () => {
    it('produces one bin per minute with trades', async () => {
      await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 100, 10);
      await insertTrade(db, D + 2, `${DATE}T10:01:15.000Z`, 120, 5);

      await _test_generate1m(db, DATE);

      const bins = await db.collection(BIN1M).find().sort({ timestamp: 1 }).toArray();

      expect(bins).toHaveLength(2);
      expect(bins[0]!.timestamp).toBe(`${DATE}T10:01:00.000Z`);
      expect(bins[1]!.timestamp).toBe(`${DATE}T10:02:00.000Z`);
    });

    it('computes OHLCV correctly', async () => {
      await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 100, 10);
      await insertTrade(db, D + 2, `${DATE}T10:00:20.000Z`, 130, 5);
      await insertTrade(db, D + 3, `${DATE}T10:00:40.000Z`, 90,  8);
      await insertTrade(db, D + 4, `${DATE}T10:00:55.000Z`, 120, 3);

      await _test_generate1m(db, DATE);

      const bin = await db.collection(BIN1M).findOne({ timestamp: `${DATE}T10:01:00.000Z` });

      expect(bin!.open).toBe(100);
      expect(bin!.high).toBe(130);
      expect(bin!.low).toBe(90);
      expect(bin!.close).toBe(120);
      expect(bin!.trades).toBe(4);
      expect(bin!.volume).toBe(26);
      expect(bin!.lastSize).toBe(3);
    });

    it('sets _id to the first trade _id in the minute', async () => {
      await insertTrade(db, D + 10, `${DATE}T10:00:10.000Z`, 100, 5);
      await insertTrade(db, D + 11, `${DATE}T10:00:30.000Z`, 110, 5);

      await _test_generate1m(db, DATE);

      const bin = await db.collection(BIN1M).findOne({ timestamp: `${DATE}T10:01:00.000Z` });

      expect(bin!._id).toBe(D + 10);
    });

    it('computes vwap as sum(price*size)/volume', async () => {
      // 100*10 + 200*10 = 3000, volume=20, vwap=150
      await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 100, 10);
      await insertTrade(db, D + 2, `${DATE}T10:00:50.000Z`, 200, 10);

      await _test_generate1m(db, DATE);

      const bin = await db.collection(BIN1M).findOne({ timestamp: `${DATE}T10:01:00.000Z` });

      expect(bin!.vwap).toBe(150);
    });

    it('groups symbols independently', async () => {
      await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 100, 5, { symbol: 'XBTUSD' });
      await insertTrade(db, D + 2, `${DATE}T10:00:20.000Z`, 50,  3, { symbol: 'ETHUSD' });

      await _test_generate1m(db, DATE);

      const bins = await db.collection(BIN1M).find().sort({ symbol: 1 }).toArray();

      expect(bins).toHaveLength(2);
      expect(bins.find(b => b.symbol === 'XBTUSD')!.close).toBe(100);
      expect(bins.find(b => b.symbol === 'ETHUSD')!.close).toBe(50);
    });

    it('applies the BitMEX open convention: open = previous close within day', async () => {
      await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 100, 5);
      await insertTrade(db, D + 2, `${DATE}T10:00:50.000Z`, 110, 5);
      await insertTrade(db, D + 3, `${DATE}T10:01:10.000Z`, 200, 5);

      await _test_generate1m(db, DATE);

      const bins = await db.collection(BIN1M).find().sort({ timestamp: 1 }).toArray();

      expect(bins[0]!.close).toBe(110);
      expect(bins[1]!.open).toBe(110);  // open = prev close, not first-trade price 200
    });

    it('cold start: first bin of the dataset keeps its own first trade as open', async () => {
      await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 100, 5);
      await insertTrade(db, D + 2, `${DATE}T10:00:50.000Z`, 110, 5);

      await _test_generate1m(db, DATE);

      const bin = await db.collection(BIN1M).findOne({ timestamp: `${DATE}T10:01:00.000Z` });

      expect(bin!.open).toBe(100);
    });

    it('is idempotent — re-running the same day does not duplicate', async () => {
      await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 100, 5);

      await _test_generate1m(db, DATE);
      await _test_generate1m(db, DATE);

      expect(await db.collection(BIN1M).countDocuments()).toBe(1);
    });

    it('skips trades with missing or empty side', async () => {
      await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 100, 10);
      await insertTrade(db, D + 2, `${DATE}T10:00:50.000Z`, 200, 10, { side: '' });
      await insertTrade(db, D + 3, `${DATE}T10:00:55.000Z`, 300, 10, { side: null });

      await _test_generate1m(db, DATE);

      const bin = await db.collection(BIN1M).findOne({ timestamp: `${DATE}T10:01:00.000Z` });

      expect(bin!.trades).toBe(1);
      expect(bin!.volume).toBe(10);
      expect(bin!.close).toBe(100);
    });

    it('does nothing when there are no trades for the day', async () => {
      await _test_generate1m(db, DATE);

      expect(await db.collection(BIN1M).countDocuments()).toBe(0);
    });

    it('scopes to the given day only', async () => {
      await insertTrade(db, D    + 1, `${DATE}T23:59:10.000Z`,    100, 5);
      await insertTrade(db, D_P1 + 1, `${DATE_P1}T00:00:05.000Z`, 200, 5);

      await _test_generate1m(db, DATE);

      const bins = await db.collection(BIN1M).find().toArray();

      // Only the trade on DATE should produce a bin; the next-day trade is excluded
      // by the _id-range $match.
      expect(bins).toHaveLength(1);
      expect(bins[0]!.close).toBe(100);
    });

    it('does not emit empty bins for periods with no trades', async () => {
      // Trades at 10:00 and 10:02 — minute 10:01 is empty and must NOT produce a bin
      await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 100, 5);
      await insertTrade(db, D + 2, `${DATE}T10:02:10.000Z`, 110, 5);

      await _test_generate1m(db, DATE);

      const bins = await db.collection(BIN1M).find().sort({ timestamp: 1 }).toArray();

      expect(bins).toHaveLength(2);
      expect(bins[0]!.timestamp).toBe(`${DATE}T10:01:00.000Z`);
      expect(bins[1]!.timestamp).toBe(`${DATE}T10:03:00.000Z`);
    });

    it('correctly sums turnover, homeNotional, foreignNotional', async () => {
      // Two trades in the same minute, with controlled notional overrides
      await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 100, 10,
        { grossValue: 1000, homeNotional: 1, foreignNotional: 10 });
      await insertTrade(db, D + 2, `${DATE}T10:00:50.000Z`, 100, 20,
        { grossValue: 2000, homeNotional: 2, foreignNotional: 20 });

      await _test_generate1m(db, DATE);

      const bin = await db.collection(BIN1M).findOne({ timestamp: `${DATE}T10:01:00.000Z` });

      expect(bin!.turnover).toBe(3000);
      expect(bin!.homeNotional).toBe(3);
      expect(bin!.foreignNotional).toBe(30);
    });

    it('chains open across symbols independently within the same day', async () => {
      // XBTUSD and ETHUSD trades interleaved across minutes 0-2.
      // Each symbol's bin chain must use ITS OWN previous close, not the other's.
      await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 100, 5, { symbol: 'XBTUSD' });
      await insertTrade(db, D + 2, `${DATE}T10:00:20.000Z`, 50,  5, { symbol: 'ETHUSD' });
      await insertTrade(db, D + 3, `${DATE}T10:01:10.000Z`, 110, 5, { symbol: 'XBTUSD' });
      await insertTrade(db, D + 4, `${DATE}T10:01:20.000Z`, 55,  5, { symbol: 'ETHUSD' });
      await insertTrade(db, D + 5, `${DATE}T10:02:10.000Z`, 120, 5, { symbol: 'XBTUSD' });
      await insertTrade(db, D + 6, `${DATE}T10:02:20.000Z`, 60,  5, { symbol: 'ETHUSD' });

      await _test_generate1m(db, DATE);

      const xbt = await db.collection(BIN1M)
        .find({ symbol: 'XBTUSD' }).sort({ timestamp: 1 }).toArray();
      const eth = await db.collection(BIN1M)
        .find({ symbol: 'ETHUSD' }).sort({ timestamp: 1 }).toArray();

      // XBTUSD: first bin keeps its own first-trade open (100), then chains 100→110
      expect(xbt[0]!.open).toBe(100);  expect(xbt[0]!.close).toBe(100);
      expect(xbt[1]!.open).toBe(100);  expect(xbt[1]!.close).toBe(110);
      expect(xbt[2]!.open).toBe(110);  expect(xbt[2]!.close).toBe(120);

      // ETHUSD: independent chain, must NOT have been contaminated by XBTUSD's closes
      expect(eth[0]!.open).toBe(50);   expect(eth[0]!.close).toBe(50);
      expect(eth[1]!.open).toBe(50);   expect(eth[1]!.close).toBe(55);
      expect(eth[2]!.open).toBe(55);   expect(eth[2]!.close).toBe(60);
    });
  });

  // ── tradeBin5m ────────────────────────────────────────────────────────────

  describe('tradeBin5m', () => {
    it('aggregates 1m bins into 5m bins', async () => {
      for (let m = 0; m < 5; m++) {
        const mm = String(m).padStart(2, '0');
        await insertTrade(db, D + m + 1, `${DATE}T10:${mm}:10.000Z`, 100 + m, 10);
      }

      await _test_generate1m(db, DATE);
      await _test_generate5m(db, DATE);

      const bins = await db.collection(BIN5M).find().sort({ timestamp: 1 }).toArray();

      expect(bins).toHaveLength(1);
      expect(bins[0]!.timestamp).toBe(`${DATE}T10:05:00.000Z`);
    });

    it('carries high/low/volume correctly from 1m to 5m', async () => {
      await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 50,  10);
      await insertTrade(db, D + 2, `${DATE}T10:00:50.000Z`, 200, 10);
      await insertTrade(db, D + 3, `${DATE}T10:01:10.000Z`, 100, 5);
      await insertTrade(db, D + 4, `${DATE}T10:01:50.000Z`, 150, 5);
      await insertTrade(db, D + 5, `${DATE}T10:04:10.000Z`, 100, 1);

      await _test_generate1m(db, DATE);
      await _test_generate5m(db, DATE);

      const bin = await db.collection(BIN5M).findOne({ timestamp: `${DATE}T10:05:00.000Z` });

      expect(bin!.high).toBe(200);
      expect(bin!.low).toBe(50);
      expect(bin!.volume).toBe(31);
    });

    it('rolls up every field correctly: OHLC, trades, volume, vwap, lastSize, notionals', async () => {
      // One trade per minute for 5 minutes. Sizes are 10 each so 5m volume = 50.
      // Prices chosen so 5m vwap = (100+110+90+120+105)*10 / 50 = 5250 / 50 = 105.
      // Notional overrides chosen to make the sums trivial to verify.
      await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 100, 10,
        { grossValue: 1000, homeNotional: 1, foreignNotional: 10 });
      await insertTrade(db, D + 2, `${DATE}T10:01:10.000Z`, 110, 10,
        { grossValue:  500, homeNotional: 2, foreignNotional: 20 });
      await insertTrade(db, D + 3, `${DATE}T10:02:10.000Z`, 90, 10,
        { grossValue:  800, homeNotional: 3, foreignNotional: 30 });
      await insertTrade(db, D + 4, `${DATE}T10:03:10.000Z`, 120, 10,
        { grossValue:  300, homeNotional: 4, foreignNotional: 40 });
      await insertTrade(db, D + 5, `${DATE}T10:04:10.000Z`, 105, 10,
        { grossValue:  500, homeNotional: 5, foreignNotional: 50 });

      await _test_generate1m(db, DATE);
      await _test_generate5m(db, DATE);

      const bin = await db.collection(BIN5M).findOne({ timestamp: `${DATE}T10:05:00.000Z` });

      // Identity / timestamp
      expect(bin!._id).toBe(D + 1);                            // first 1m bin's _id
      expect(bin!.symbol).toBe('XBTUSD');
      expect(bin!.timestamp).toBe(`${DATE}T10:05:00.000Z`);    // end of 5m period

      // OHLC — open = open of first 1m bin (cold start: 100); close = last 1m bin's close
      expect(bin!.open).toBe(100);
      expect(bin!.high).toBe(120);
      expect(bin!.low).toBe(90);
      expect(bin!.close).toBe(105);

      // Aggregates
      expect(bin!.trades).toBe(5);                             // sum of 1m bin trade counts
      expect(bin!.volume).toBe(50);
      expect(bin!.vwap).toBe(105);                             // Σ(vwap·volume)/Σvolume
      expect(bin!.lastSize).toBe(10);                          // lastSize of last 1m bin

      // Notionals — pure sums across the 5 minutes
      expect(bin!.turnover).toBe(3100);
      expect(bin!.homeNotional).toBe(15);
      expect(bin!.foreignNotional).toBe(150);
    });

    it('does not emit empty 5m bins for periods with no 1m bins', async () => {
      // Trades in 5m window starting at 10:00 and another at 10:15.
      // The 5m windows 10:05 and 10:10 have no 1m bins and must NOT produce 5m bins.
      await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 100, 5);
      await insertTrade(db, D + 2, `${DATE}T10:15:10.000Z`, 110, 5);

      await _test_generate1m(db, DATE);
      await _test_generate5m(db, DATE);

      const bins = await db.collection(BIN5M).find().sort({ timestamp: 1 }).toArray();

      expect(bins).toHaveLength(2);
      expect(bins[0]!.timestamp).toBe(`${DATE}T10:05:00.000Z`);
      expect(bins[1]!.timestamp).toBe(`${DATE}T10:20:00.000Z`);
    });

    it('is idempotent — re-running 5m for the same day does not duplicate', async () => {
      await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 100, 5);

      await _test_generate1m(db, DATE);
      await _test_generate5m(db, DATE);
      await _test_generate5m(db, DATE);

      expect(await db.collection(BIN5M).countDocuments()).toBe(1);
    });
  });

  // ── tradeBin1h field coverage ─────────────────────────────────────────────

  describe('tradeBin1h field coverage', () => {
    it('rolls up every field correctly at the 1h level', async () => {
      // 60 trades, one per minute, alternating prices to control high/low/close.
      for (let m = 0; m < 60; m++) {
        const mm    = String(m).padStart(2, '0');
        const price = 100 + (m % 5);                            // 100..104 repeating
        await insertTrade(db, D + m + 1, `${DATE}T10:${mm}:10.000Z`, price, 1,
          { grossValue: 10, homeNotional: 1, foreignNotional: 1 });
      }

      await _test_generate1m(db, DATE);
      await _test_generate1h(db, DATE);

      const bin = await db.collection(BIN1H).findOne({ timestamp: `${DATE}T11:00:00.000Z` });

      expect(bin!.symbol).toBe('XBTUSD');
      expect(bin!.timestamp).toBe(`${DATE}T11:00:00.000Z`);
      expect(bin!.open).toBe(100);                              // first trade price (cold start)
      expect(bin!.high).toBe(104);
      expect(bin!.low).toBe(100);
      expect(bin!.close).toBe(100 + (59 % 5));                  // last 1m bin's close
      expect(bin!.trades).toBe(60);
      expect(bin!.volume).toBe(60);
      expect(bin!.lastSize).toBe(1);
      expect(bin!.turnover).toBe(600);
      expect(bin!.homeNotional).toBe(60);
      expect(bin!.foreignNotional).toBe(60);
    });
  });

  // ── tradeBin1h ────────────────────────────────────────────────────────────

  describe('tradeBin1h', () => {
    it('aggregates 1m bins into 1h bins', async () => {
      for (let m = 0; m < 60; m++) {
        const mm = String(m).padStart(2, '0');
        await insertTrade(db, D + m + 1, `${DATE}T10:${mm}:10.000Z`, 100, 5);
      }

      await _test_generate1m(db, DATE);
      await _test_generate5m(db, DATE);
      await _test_generate1h(db, DATE);

      const bins = await db.collection(BIN1H).find().sort({ timestamp: 1 }).toArray();

      expect(bins).toHaveLength(1);
      expect(bins[0]!.timestamp).toBe(`${DATE}T11:00:00.000Z`);
    });
  });

  // ── tradeBin1d ────────────────────────────────────────────────────────────

  describe('tradeBin1d', () => {
    it('aggregates 1m bins into a 1d bin timestamped at the next day', async () => {
      for (let h = 0; h < 3; h++) {
        const hh = String(h).padStart(2, '0');
        await insertTrade(db, D + h + 1, `${DATE}T${hh}:00:10.000Z`, 100, 5);
      }

      await _test_generate1m(db, DATE);
      await _test_generate5m(db, DATE);
      await _test_generate1h(db, DATE);
      await _test_generate1d(db, DATE);

      const bins = await db.collection(BIN1D).find().sort({ timestamp: 1 }).toArray();

      expect(bins).toHaveLength(1);
      // 1d bin for DATE is timestamped at DATE+1 per BitMEX end-of-period convention
      expect(bins[0]!.timestamp).toBe(`${DATE_P1}T00:00:00.000Z`);
    });
  });

  // ── patchBoundaries ───────────────────────────────────────────────────────

  describe('patchBoundaries', () => {
    it('anchors the current day first bin open to prev day last close', async () => {
      // Simulate a prev-day bin with close=100. Its timestamp is the last 1m bin
      // of DATE_M1, which per BitMEX convention sits at DATE T00:00:00.000Z.
      await insertBin1m(db, 99, `${DATE}T00:00:00.000Z`, 'XBTUSD', 90, 100);

      await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 200, 5);

      await _test_generate1m(db, DATE);

      const first = await db.collection(BIN1M).findOne(
        { symbol: 'XBTUSD', timestamp: { $gt: `${DATE}T00:00:00.000Z` } },
        { sort: { timestamp: 1 } },
      );

      expect(first!.open).toBe(100);
    });

    it('peeks forward: patches next day first bin when already processed', async () => {
      // Simulate a day N+1 first bin with a stub open
      await insertBin1m(db, 99, `${DATE_P1}T10:01:00.000Z`, 'XBTUSD', 999, 210);

      // Day N trade — its last close becomes 110
      await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 100, 5);
      await insertTrade(db, D + 2, `${DATE}T10:00:50.000Z`, 110, 5);

      await _test_generate1m(db, DATE);

      const next = await db.collection(BIN1M).findOne({ timestamp: `${DATE_P1}T10:01:00.000Z` });

      // Day N's last close (110) should have replaced the stub open (999)
      expect(next!.open).toBe(110);
    });

    it('is order-independent: N then N+1 yields the same first-bin open as N+1 then N', async () => {
      await insertTrade(db, D    + 1, `${DATE}T10:00:10.000Z`,    100, 5);
      await insertTrade(db, D    + 2, `${DATE}T10:00:50.000Z`,    110, 5);
      await insertTrade(db, D_P1 + 1, `${DATE_P1}T10:00:10.000Z`, 200, 5);
      await insertTrade(db, D_P1 + 2, `${DATE_P1}T10:00:50.000Z`, 210, 5);

      // Scenario A: N then N+1
      await _test_generate1m(db, DATE);
      await _test_generate1m(db, DATE_P1);

      const openA = (await db.collection(BIN1M).findOne(
        { symbol: 'XBTUSD', timestamp: { $gt: `${DATE_P1}T00:00:00.000Z` } },
        { sort: { timestamp: 1 } },
      ))!.open;

      // Reset bins, keep trades
      await Promise.all([BIN1M, BIN5M, BIN1H, BIN1D].map(c => db.collection(c).deleteMany({})));

      // Scenario B: N+1 then N
      await _test_generate1m(db, DATE_P1);
      await _test_generate1m(db, DATE);

      const openB = (await db.collection(BIN1M).findOne(
        { symbol: 'XBTUSD', timestamp: { $gt: `${DATE_P1}T00:00:00.000Z` } },
        { sort: { timestamp: 1 } },
      ))!.open;

      expect(openA).toBe(openB);
    });

    it('cold start: no prev day — first bin keeps first trade open', async () => {
      await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 200, 5);

      await _test_generate1m(db, DATE);

      const first = await db.collection(BIN1M).findOne(
        { symbol: 'XBTUSD', timestamp: { $gt: `${DATE}T00:00:00.000Z` } },
        { sort: { timestamp: 1 } },
      );

      expect(first!.open).toBe(200);
    });

    it('only patches symbols that appear in the current day', async () => {
      // ETHUSD has a bin in N+1 with a stub open — but ETHUSD has no trades in day N
      await insertBin1m(db, 99, `${DATE_P1}T10:01:00.000Z`, 'ETHUSD', 999, 500);

      // Only XBTUSD trades on day N
      await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 100, 5, { symbol: 'XBTUSD' });

      await _test_generate1m(db, DATE);

      const ethusdBin = await db.collection(BIN1M).findOne({ timestamp: `${DATE_P1}T10:01:00.000Z` });

      // ETHUSD's N+1 stub must not have been touched
      expect(ethusdBin!.open).toBe(999);
    });
  });

  // ── patchBoundaries — coarser bins ────────────────────────────────────────
  // The same anchor / peek / order-independence properties verified for 1m above
  // must hold for every coarser bin size. Each generate*() runs patchBoundaries
  // independently — a regression in any one would silently produce wrong opens
  // at day boundaries for that size.

  describe('patchBoundaries — coarser bins', () => {

    // ── 5m ────────────────────────────────────────────────────────────────

    describe('5m', () => {
      const PREV_TS     = `${DATE}T00:00:00.000Z`;     // last 5m bin of N-1
      const P1_FIRST_TS = `${DATE_P1}T00:05:00.000Z`;  // first 5m bin of N+1

      const generate = async (date: string) => {
        await _test_generate1m(db, date);
        await _test_generate5m(db, date);
      };

      it('anchors first 5m bin of day N with prev day last 5m close', async () => {
        await insertBin(db, BIN5M, 99, PREV_TS, 'XBTUSD', 90, 100);
        await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 200, 5);

        await generate(DATE);

        const first = await db.collection(BIN5M).findOne(
          { symbol: 'XBTUSD', timestamp: { $gt: PREV_TS } },
          { sort: { timestamp: 1 } },
        );

        expect(first!.open).toBe(100);
      });

      it('peeks forward: patches next-day first 5m bin when already processed', async () => {
        await insertBin(db, BIN5M, 99, P1_FIRST_TS, 'XBTUSD', 999, 210);
        await insertTrade(db, D + 1, `${DATE}T23:59:10.000Z`, 100, 5);
        await insertTrade(db, D + 2, `${DATE}T23:59:50.000Z`, 110, 5);

        await generate(DATE);

        const next = await db.collection(BIN5M).findOne({ timestamp: P1_FIRST_TS });

        expect(next!.open).toBe(110);
      });

      it('is order-independent: N then N+1 == N+1 then N', async () => {
        await insertTrade(db, D    + 1, `${DATE}T23:59:10.000Z`,    100, 5);
        await insertTrade(db, D    + 2, `${DATE}T23:59:50.000Z`,    110, 5);
        await insertTrade(db, D_P1 + 1, `${DATE_P1}T00:00:10.000Z`, 200, 5);
        await insertTrade(db, D_P1 + 2, `${DATE_P1}T00:00:50.000Z`, 210, 5);

        // Scenario A: N then N+1
        await generate(DATE);
        await generate(DATE_P1);
        const openA = (await db.collection(BIN5M).findOne(
          { symbol: 'XBTUSD', timestamp: P1_FIRST_TS },
        ))!.open;

        await Promise.all([BIN1M, BIN5M, BIN1H, BIN1D].map(c => db.collection(c).deleteMany({})));

        // Scenario B: N+1 then N
        await generate(DATE_P1);
        await generate(DATE);
        const openB = (await db.collection(BIN5M).findOne(
          { symbol: 'XBTUSD', timestamp: P1_FIRST_TS },
        ))!.open;

        expect(openA).toBe(openB);
        expect(openA).toBe(110);    // = day N's last 5m close
      });
    });

    // ── 1h ────────────────────────────────────────────────────────────────

    describe('1h', () => {
      const PREV_TS     = `${DATE}T00:00:00.000Z`;     // last 1h bin of N-1
      const P1_FIRST_TS = `${DATE_P1}T01:00:00.000Z`;  // first 1h bin of N+1

      const generate = async (date: string) => {
        await _test_generate1m(db, date);
        await _test_generate1h(db, date);
      };

      it('anchors first 1h bin of day N with prev day last 1h close', async () => {
        await insertBin(db, BIN1H, 99, PREV_TS, 'XBTUSD', 90, 100);
        await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 200, 5);

        await generate(DATE);

        const first = await db.collection(BIN1H).findOne(
          { symbol: 'XBTUSD', timestamp: { $gt: PREV_TS } },
          { sort: { timestamp: 1 } },
        );

        expect(first!.open).toBe(100);
      });

      it('peeks forward: patches next-day first 1h bin when already processed', async () => {
        await insertBin(db, BIN1H, 99, P1_FIRST_TS, 'XBTUSD', 999, 210);
        await insertTrade(db, D + 1, `${DATE}T23:00:10.000Z`, 100, 5);
        await insertTrade(db, D + 2, `${DATE}T23:30:50.000Z`, 110, 5);

        await generate(DATE);

        const next = await db.collection(BIN1H).findOne({ timestamp: P1_FIRST_TS });

        expect(next!.open).toBe(110);
      });

      it('is order-independent: N then N+1 == N+1 then N', async () => {
        await insertTrade(db, D    + 1, `${DATE}T23:00:10.000Z`,    100, 5);
        await insertTrade(db, D    + 2, `${DATE}T23:30:50.000Z`,    110, 5);
        await insertTrade(db, D_P1 + 1, `${DATE_P1}T00:00:10.000Z`, 200, 5);
        await insertTrade(db, D_P1 + 2, `${DATE_P1}T00:30:50.000Z`, 210, 5);

        await generate(DATE);
        await generate(DATE_P1);
        const openA = (await db.collection(BIN1H).findOne({ timestamp: P1_FIRST_TS }))!.open;

        await Promise.all([BIN1M, BIN5M, BIN1H, BIN1D].map(c => db.collection(c).deleteMany({})));

        await generate(DATE_P1);
        await generate(DATE);
        const openB = (await db.collection(BIN1H).findOne({ timestamp: P1_FIRST_TS }))!.open;

        expect(openA).toBe(openB);
        expect(openA).toBe(110);    // = day N's last 1h close
      });
    });

    // ── 1d ────────────────────────────────────────────────────────────────
    // 1d has exactly one bin per day per symbol, timestamped at the *next* day's midnight.

    describe('1d', () => {
      const PREV_TS  = `${DATE}T00:00:00.000Z`;     // 1d bin of N-1
      const DATE_TS  = `${DATE_P1}T00:00:00.000Z`;  // 1d bin of N
      const P1_TS    = `${DATE_P2}T00:00:00.000Z`;  // 1d bin of N+1

      const generate = async (date: string) => {
        await _test_generate1m(db, date);
        await _test_generate1d(db, date);
      };

      it('anchors day N\'s 1d bin open with prev day 1d close', async () => {
        await insertBin(db, BIN1D, 99, PREV_TS, 'XBTUSD', 90, 100);
        await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 200, 5);

        await generate(DATE);

        const bin = await db.collection(BIN1D).findOne({ timestamp: DATE_TS });

        expect(bin!.open).toBe(100);
      });

      it('peeks forward: patches N+1\'s 1d bin when already processed', async () => {
        await insertBin(db, BIN1D, 99, P1_TS, 'XBTUSD', 999, 210);
        await insertTrade(db, D + 1, `${DATE}T10:00:10.000Z`, 100, 5);
        await insertTrade(db, D + 2, `${DATE}T23:30:50.000Z`, 110, 5);

        await generate(DATE);

        const next = await db.collection(BIN1D).findOne({ timestamp: P1_TS });

        expect(next!.open).toBe(110);
      });

      it('is order-independent: N then N+1 == N+1 then N', async () => {
        await insertTrade(db, D    + 1, `${DATE}T10:00:10.000Z`,    100, 5);
        await insertTrade(db, D    + 2, `${DATE}T23:30:50.000Z`,    110, 5);
        await insertTrade(db, D_P1 + 1, `${DATE_P1}T00:00:10.000Z`, 200, 5);
        await insertTrade(db, D_P1 + 2, `${DATE_P1}T23:30:50.000Z`, 210, 5);

        await generate(DATE);
        await generate(DATE_P1);
        const openA = (await db.collection(BIN1D).findOne({ timestamp: P1_TS }))!.open;

        await Promise.all([BIN1M, BIN5M, BIN1H, BIN1D].map(c => db.collection(c).deleteMany({})));

        await generate(DATE_P1);
        await generate(DATE);
        const openB = (await db.collection(BIN1D).findOne({ timestamp: P1_TS }))!.open;

        expect(openA).toBe(openB);
        expect(openA).toBe(110);    // = day N's 1d close
      });
    });
  });

  // ── 3-day gap fill / eventual consistency ─────────────────────────────────
  // The strongest guarantee: regardless of the order in which days are processed,
  // and regardless of gaps (missing days that are filled in later), the final
  // bin state must equal the state produced by strict in-order processing.

  describe('eventual consistency across gaps', () => {
    it('out-of-order processing (N, N+2, N+1) converges to in-order result', async () => {
      // Three consecutive days with distinct closing prices
      await insertTrade(db, D    + 1, `${DATE}T23:30:10.000Z`,    100, 5);
      await insertTrade(db, D    + 2, `${DATE}T23:30:50.000Z`,    110, 5);
      await insertTrade(db, D_P1 + 1, `${DATE_P1}T12:00:00.000Z`, 200, 5);
      await insertTrade(db, D_P1 + 2, `${DATE_P1}T23:30:50.000Z`, 210, 5);
      await insertTrade(db, D_P2 + 1, `${DATE_P2}T12:00:00.000Z`, 300, 5);

      // Scenario A: gap-fill order — N, then N+2 (skipping N+1), then N+1
      await _test_generate1m(db, DATE);
      await _test_generate1m(db, DATE_P2);
      await _test_generate1m(db, DATE_P1);
      const stateA = await db.collection(BIN1M).find().sort({ timestamp: 1 }).toArray();

      // Reset
      await db.collection(BIN1M).deleteMany({});

      // Scenario B: strict in-order
      await _test_generate1m(db, DATE);
      await _test_generate1m(db, DATE_P1);
      await _test_generate1m(db, DATE_P2);
      const stateB = await db.collection(BIN1M).find().sort({ timestamp: 1 }).toArray();

      expect(stateA).toEqual(stateB);
    });

    it('intermediate state with missing N+1: N+2 inherits N\'s close until N+1 arrives', async () => {
      // Documents the *transient* behavior: while N+1 is missing, patchBoundaries
      // cannot distinguish "day not yet processed" from "truly empty day", so it
      // anchors N+2's first bin to N's last close. Once N+1 arrives, its peek
      // patches N+2 to N+1's last close — restoring correctness.
      await insertTrade(db, D    + 1, `${DATE}T23:30:10.000Z`,    100, 5);
      await insertTrade(db, D    + 2, `${DATE}T23:30:50.000Z`,    110, 5);
      await insertTrade(db, D_P1 + 1, `${DATE_P1}T12:00:00.000Z`, 200, 5);
      await insertTrade(db, D_P1 + 2, `${DATE_P1}T23:30:50.000Z`, 210, 5);
      await insertTrade(db, D_P2 + 1, `${DATE_P2}T12:00:00.000Z`, 300, 5);

      // Step 1: process N and N+2 — N+1 still missing
      await _test_generate1m(db, DATE);
      await _test_generate1m(db, DATE_P2);

      const p2Q = {
        symbol: 'XBTUSD',
        timestamp: { $gt: `${DATE_P2}T00:00:00.000Z` },
      };
      const intermediate = (await db.collection(BIN1M).findOne(p2Q, { sort: { timestamp: 1 } }))!.open;

      expect(intermediate).toBe(110);    // = N's last close (best-effort across the gap)

      // Step 2: fill the gap — process N+1
      await _test_generate1m(db, DATE_P1);

      const final = (await db.collection(BIN1M).findOne(p2Q, { sort: { timestamp: 1 } }))!.open;

      expect(final).toBe(210);           // = N+1's last close (correct, eventually-consistent value)
    });
  });
});
