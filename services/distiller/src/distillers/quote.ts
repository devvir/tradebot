import type { Db } from 'mongodb';
import { logger } from '@devvir/service-kit';
import type { Service } from '@devvir/service-kit';
import { startOfDayMongoId } from '@tradebot/utils';
import { ensureIndex } from '../utils/indexes';
import { dateWalker } from '../utils/dates';
import type { QuoteBin } from '../types';

const POOL   = 'Primary';
const SOURCE = 'quote';
const TARGET = 'quoteBin1m';

type CoarserConfig = {
  target:  string;
  pattern: RegExp;
};

const COARSER_BINS: CoarserConfig[] = [
  { target: 'quoteBin5m', pattern: /:(?:00|05|10|15|20|25|30|35|40|45|50|55):00\.000Z$/ },
  { target: 'quoteBin1h', pattern: /:00:00\.000Z$/ },
  { target: 'quoteBin1d', pattern: /T00:00:00\.000Z$/ },
];

export async function distillQuotes(db: Db, service: Service): Promise<void> {
  const collections = ['quoteBin1m', 'quoteBin5m', 'quoteBin1h', 'quoteBin1d'];

  await Promise.all(collections.map(c => ensureIndex(db, c, [
    { timestamp: 1 },
    { action: 1, timestamp: 1 },
    { symbol: 1, timestamp: 1 },
  ])));

  const walker = dateWalker('quoteBins', 'quote');

  logger.info('Distilling quoteBins...');

  service.increment('distillers');

  while (true) {
    const date = await walker.next();

    if (service.state('stopping')) {
      service.decrement('distillers');
      break;
    }

    logger.info(`Distilling ${date} quoteBins`);

    await generate1m(db, date);

    for (const cfg of COARSER_BINS)
      await generateCoarser(db, date, cfg);
  }
}

/* ------------------------------------------------------------------ */
/*  Per-day generators                                                */
/* ------------------------------------------------------------------ */

async function generate1m(db: Db, date: string): Promise<void> {
  const from     = `${date}T00:00:00`;
  const to       = `${addDays(date, 1)}T00:00:00`;
  const pipeline = buildPipeline(from, to);
  const results  = await db.collection(SOURCE).aggregate(pipeline).toArray();
  const bins: QuoteBin[] = [];

  for (const { group, ask, bid } of results) {
    if (! ask && ! bid) continue;

    const bin: QuoteBin = {
      _id:       Math.max(ask?._id ?? 0, bid?._id ?? 0),
      timestamp: periodToTimestamp(group.period),
      symbol:    group.symbol,
      pool:      POOL,
    };

    if (bid) { bin.bidPrice = bid.bidPrice; bin.bidSize = bid.bidSize; }
    if (ask) { bin.askPrice = ask.askPrice; bin.askSize = ask.askSize; }

    bins.push(bin);
  }

  if (bins.length === 0) return;

  await db.collection<QuoteBin>(TARGET)
    .insertMany(bins, { ordered: false })
    .catch(ignoreDuplicateKeyErrors);

  logger.debug({ date, count: bins.length }, 'quoteBin1m generated');
}

async function generateCoarser(db: Db, date: string, cfg: CoarserConfig): Promise<void> {
  const from = `${date}T00:00:00.000Z`;
  const to   = `${addDays(date, 1)}T00:00:00.000Z`;
  const docs  = await db.collection<QuoteBin>(TARGET)
    .find({ timestamp: { $gt: from, $lte: to, $regex: cfg.pattern } })
    .sort({ timestamp: 1 })
    .toArray();

  if (docs.length === 0) return;

  await db.collection<QuoteBin>(cfg.target)
    .insertMany(docs, { ordered: false })
    .catch(ignoreDuplicateKeyErrors);

  logger.debug({ date, count: docs.length, target: cfg.target }, `${cfg.target} generated`);
}

/* ------------------------------------------------------------------ */
/*  Pipeline                                                          */
/* ------------------------------------------------------------------ */

function buildPipeline(from: string, to: string) {
  return [
    {
      $match: {
        _id: { $gte: startOfDayMongoId(from), $lt: startOfDayMongoId(to) },
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
/*  Test-only exports                                                 */
/* ------------------------------------------------------------------ */

export const _test_periodToTimestamp = periodToTimestamp;
export const _test_addDays           = addDays;
export const _test_buildPipeline     = buildPipeline;
export const _test_generate1m        = generate1m;
export const _test_generateCoarser   = generateCoarser;
export const _test_COARSER_BINS      = COARSER_BINS;
