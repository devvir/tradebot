import type { MongoClient, Collection, Db } from 'mongodb';
import { logger } from '@devvir/service-kit';
import { ensureIndex } from '../indexes';
import type { QuoteBin } from '../types';

const POOL       = 'Primary';
const SOURCE     = 'quote';
const TARGET     = 'quoteBin1m';
const BATCH_DAYS = 5;
const COPY_BATCH = 10_000;
const POLL_MS    = 5_000;

type CoarserConfig = {
  target:  string;
  pattern: RegExp;
  floor:   (ts: string) => string;
};

const COARSER_BINS: CoarserConfig[] = [
  { target: 'quoteBin5m', pattern: /:(?:00|05|10|15|20|25|30|35|40|45|50|55):00\.000Z$/, floor: floorTo5m },
  { target: 'quoteBin1h', pattern: /:00:00\.000Z$/, floor: floorTo1h },
  { target: 'quoteBin1d', pattern: /T00:00:00\.000Z$/, floor: floorTo1d },
];

export async function distillQuotes(mongo: MongoClient, database: string): Promise<void> {
  const collections = [ 'quote', 'quoteBin1m', 'quoteBin5m', 'quoteBin1h', 'quoteBin1d' ];

  await Promise.all(collections.map(collection => ensureIndex(collection, [
    { timestamp: 1 },
    { action: 1, timestamp: 1 },
    { symbol: 1, timestamp: 1 },
  ])));

  const db = mongo.db(database);

  let done1m = false;

  const p1m      = distill1mBins(db).finally(() => { done1m = true; });
  const pCoarser = distillCoarserBins(db, () => done1m, p1m);

  await Promise.all([p1m, pCoarser]);
}

/* ------------------------------------------------------------------ */
/*  1-minute bins                                                     */
/* ------------------------------------------------------------------ */

async function distill1mBins(db: Db): Promise<void> {
  const source = db.collection(SOURCE);
  const target = db.collection<QuoteBin>(TARGET);

  const range = await findRange(source, target);

  if (! range) {
    logger.info('No quotes found — nothing to distill');
    return;
  }

  const { startDay, cutoff } = range;
  const cutoffDay = cutoff.slice(0, 10);

  if (startDay > cutoffDay) {
    logger.info('Table quoteBin1m is up to date');
    return;
  }

  let currentDay = startDay;
  let totalBins  = 0;

  while (currentDay <= cutoffDay) {
    const batchEnd = addDays(currentDay, BATCH_DAYS);

    logger.info(`Distilling quoteBin1m from ${currentDay} to ${batchEnd}`);

    const bins = await processBatch(source, currentDay, batchEnd, cutoff);

    if (bins.length > 0) {
      await target.insertMany(bins, { ordered: false }).catch(ignoreDuplicateKeyErrors);
      totalBins += bins.length;
      logger.debug({ from: currentDay, to: batchEnd, count: bins.length }, 'Generating quoteBin1m');
    }

    currentDay = batchEnd;
  }

  logger.info({ totalBins }, 'Table quoteBin1m — distillation complete');
}

async function findRange(
  source: Collection,
  target: Collection<QuoteBin>,
): Promise<{ startDay: string; cutoff: string } | null> {
  const earliest = await source.findOne<{ timestamp: string }>({}, { sort: { timestamp: 1 } });

  if (! earliest) return null;

  const latest = await source.findOne<{ timestamp: string }>({}, { sort: { timestamp: -1 } });

  // The latest quote's minute is potentially incomplete — exclude it entirely.
  // "2014-11-22T16:59:11.784728000" → period "2014-11-22T16:59" → cutoff "2014-11-22T16:59:00"
  // Everything with timestamp < cutoff belongs to a complete minute.
  const cutoff = latest!.timestamp.slice(0, 16) + ':00.000000000';

  const lastBin = await target.findOne<QuoteBin>({}, { sort: { timestamp: -1 } });

  const startDay = lastBin
    ? lastBin.timestamp.slice(0, 10)
    : earliest.timestamp.slice(0, 10);

  return { startDay, cutoff };
}

function buildPipeline(from: string, to: string) {
  return [
    {
      $match: {
        timestamp: { $gte: from, $lt: to },
      },
    },

    // Sort keys: _id when the doc has ask/bid, null otherwise.
    // MongoDB sorts null below numbers, so descending $top naturally
    // picks the highest-_id doc that actually has the field.
    {
      $addFields: {
        _period: { $substrCP: ['$timestamp', 0, 16] },
        _askKey: { $cond: [{ $gt: ['$askPrice', null] }, '$_id', null] },
        _bidKey: { $cond: [{ $gt: ['$bidPrice', null] }, '$_id', null] },
      },
    },

    // Per (minute, symbol): last doc with ask, last doc with bid
    {
      $group: {
        _id: { period: '$_period', symbol: '$symbol' },
        ask: {
          $top: {
            sortBy: { _askKey: -1 },
            output: { _id: '$_id', askPrice: '$askPrice', askSize: '$askSize' },
          },
        },
        bid: {
          $top: {
            sortBy: { _bidKey: -1 },
            output: { _id: '$_id', bidPrice: '$bidPrice', bidSize: '$bidSize' },
          },
        },
      },
    },

    // Null out ask/bid if $top picked a doc that lacked the field
    {
      $addFields: {
        ask: { $cond: [{ $gt: ['$ask.askPrice', null] }, '$ask', null] },
        bid: { $cond: [{ $gt: ['$bid.bidPrice', null] }, '$bid', null] },
      },
    },

    // Shape output
    {
      $project: {
        _id: 0,
        group: '$_id',
        ask: 1,
        bid: 1,
      },
    },
  ];
}

async function processBatch(
  source: Collection,
  batchStart: string,
  batchEnd: string,
  cutoff: string,
): Promise<QuoteBin[]> {
  const from = `${batchStart}T00:00:00`;
  const to   = `${batchEnd}T00:00:00` < cutoff ? `${batchEnd}T00:00:00` : cutoff;

  const pipeline = buildPipeline(from, to);
  const results  = await source.aggregate(pipeline).toArray();
  const bins: QuoteBin[] = [];

  for (const { group, ask, bid } of results) {

    if (! ask && ! bid) continue;

    const bin: QuoteBin = {
      _id:       Math.max(ask?._id ?? 0, bid?._id ?? 0),
      timestamp: periodToTimestamp(group.period),
      symbol:    group.symbol,
      pool:      POOL,
    };

    if (bid) {
      bin.bidPrice = bid.bidPrice;
      bin.bidSize  = bid.bidSize;
    }

    if (ask) {
      bin.askPrice = ask.askPrice;
      bin.askSize  = ask.askSize;
    }

    bins.push(bin);
  }

  return bins;
}

/** "2014-11-22T16:59" → "2014-11-22T17:00:00.000Z" (end of minute) */
function periodToTimestamp(period: string): string {
  const date = new Date(period + ':00.000Z');

  date.setUTCMinutes(date.getUTCMinutes() + 1);

  return date.toISOString();
}

function addDays(day: string, n: number): string {
  const date = new Date(day + 'T00:00:00.000Z');

  date.setUTCDate(date.getUTCDate() + n);

  return date.toISOString().slice(0, 10);
}

function ignoreDuplicateKeyErrors(err: unknown): void {
  const e = err as { code?: number; writeErrors?: { code: number }[] };

  if (e.code === 11000) return;

  if (e.writeErrors?.every(w => w.code === 11000)) return;

  throw err;
}

/* ------------------------------------------------------------------ */
/*  Coarser bins (5m, 1h, 1d) — run in parallel with 1m               */
/* ------------------------------------------------------------------ */

/**
 * Copies 1m bins at 5m/1h/1d boundaries into their coarser targets.
 * Runs concurrently with the 1m loop — `isDone` flips when 1m finishes.
 * Exits only after a full drain pass produces no new data AND 1m is done,
 * guaranteeing nothing is left behind.
 */
async function distillCoarserBins(db: Db, isDone: () => boolean, wakeup: Promise<void>): Promise<void> {
  const source = db.collection<QuoteBin>(TARGET);
  const raw    = db.collection(SOURCE);
  const cursors: Record<string, string> = {};

  for (const { target } of COARSER_BINS) {
    const dest = db.collection<QuoteBin>(target);
    const last = await dest.findOne<QuoteBin>({}, { sort: { timestamp: -1 } });

    cursors[target] = last?.timestamp ?? '';
  }

  while (true) {
    // Cap coarser work at the last complete boundary per binSize, derived
    // from the raw source's latest timestamp. This keeps completeness
    // explicit and independent of 1m's tip policy.
    const latest = await raw.findOne<{ timestamp: string }>(
      {},
      { sort: { timestamp: -1 }, projection: { timestamp: 1 } },
    );
    const srcMax = latest?.timestamp ?? null;

    let processedAny = false;

    if (srcMax) {
      for (const { target, pattern, floor } of COARSER_BINS) {
        const dest     = db.collection<QuoteBin>(target);
        const cap      = floor(srcMax);
        let   inserted = 0;

        while (true) {
          logger.info(`Distilling coarser quote bins: ${cursors[target].slice(0, 10)}`);

          const docs = await source
            .find({ timestamp: { $gt: cursors[target], $lte: cap, $regex: pattern } })
            .sort({ timestamp: 1 })
            .limit(COPY_BATCH)
            .toArray();

          if (docs.length === 0) break;

          await dest.insertMany(docs, { ordered: false }).catch(ignoreDuplicateKeyErrors);

          cursors[target] = docs[docs.length - 1]!.timestamp;
          inserted       += docs.length;
          processedAny    = true;
        }

        if (inserted > 0) logger.info({ target, count: inserted }, `${target} — ${inserted} bins inserted`);
      }
    }

    if (isDone() && ! processedAny) return;

    // Wait for either a poll tick or p1m finishing — whichever comes first.
    if (! processedAny) await Promise.race([sleep(POLL_MS), wakeup.catch(() => {})]);
  }
}

/**
 * String-based floor helpers — robust to nanosecond-precision timestamps
 * (e.g. "2014-11-22T16:59:11.784728000") without requiring Date parsing.
 * Output format matches quoteBin1m timestamps: "YYYY-MM-DDTHH:MM:SS.000Z".
 */
function floorTo5m(ts: string): string {
  const minute  = parseInt(ts.slice(14, 16), 10);
  const floored = Math.floor(minute / 5) * 5;

  return ts.slice(0, 14) + String(floored).padStart(2, '0') + ':00.000Z';
}

function floorTo1h(ts: string): string {
  return ts.slice(0, 13) + ':00:00.000Z';
}

function floorTo1d(ts: string): string {
  return ts.slice(0, 10) + 'T00:00:00.000Z';
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/*  Test-only exports                                                 */
/* ------------------------------------------------------------------ */

export const _test_periodToTimestamp = periodToTimestamp;
export const _test_addDays          = addDays;
export const _test_buildPipeline    = buildPipeline;
