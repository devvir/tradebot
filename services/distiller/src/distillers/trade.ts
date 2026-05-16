import type { Collection, Db } from 'mongodb';
import { logger } from '@devvir/service-kit';
import type { Service } from '@devvir/service-kit';
import { trades2bins, bins2bins, matchDocs, floorToBin } from './trade/bins';
import { ensureIndex } from '../utils/indexes';
import { dateWalker } from '../utils/dates';
import type { BinSize, Range } from './types';

const COLL_TRADE = 'trade';
const COLL_BIN1M = 'tradeBin1m';

export async function distillTrades(db: Db, service: Service): Promise<void> {
  const collections = ['tradeBin1m', 'tradeBin5m', 'tradeBin1h', 'tradeBin1d'];

  await Promise.all(collections.map(c => ensureIndex(db, c, [
    { timestamp: 1 },
    { action: 1, timestamp: 1 },
    { symbol: 1, timestamp: 1 },
  ])));

  const walker = dateWalker('tradeBins', 'trade');

  logger.info('Distilling tradeBins...');
  service.increment('distillers');

  while (true) {
    const date = await walker.next();

    if (service.state('stopping')) {
      service.decrement('distillers');
      break;
    }

    logger.info(`Distilling ${date} tradeBins`);

    await generate1m(db, date);
    await generate5m(db, date);
    await generate1h(db, date);
    await generate1d(db, date);
  }
}

/* -------------------------------------------------------------------- */
/*  Per-day generators                                                  */
/* -------------------------------------------------------------------- */

async function generate1m(db: Db, date: string): Promise<void> {
  const source = db.collection(COLL_TRADE);
  const target = db.collection(COLL_BIN1M);
  const range  = dayRange(date);

  await createBins(source, target, range, '1m', trades2bins);
  await patchBoundaries(target, range, '1m');

  logger.debug({ date }, 'tradeBin1m generated');
}

async function generate5m(db: Db, date: string): Promise<void> {
  const source = db.collection(COLL_BIN1M);
  const target = db.collection('tradeBin5m');
  const range  = dayRange(date);

  await createBins(source, target, range, '5m', bins2bins);
  await patchBoundaries(target, range, '5m');

  logger.debug({ date }, 'tradeBin5m generated');
}

async function generate1h(db: Db, date: string): Promise<void> {
  const source = db.collection(COLL_BIN1M);
  const target = db.collection('tradeBin1h');
  const range  = dayRange(date);

  await createBins(source, target, range, '1h', bins2bins);
  await patchBoundaries(target, range, '1h');

  logger.debug({ date }, 'tradeBin1h generated');
}

async function generate1d(db: Db, date: string): Promise<void> {
  const source = db.collection(COLL_BIN1M);
  const target = db.collection('tradeBin1d');
  const range  = dayRange(date);

  await createBins(source, target, range, '1d', bins2bins);
  await patchBoundaries(target, range, '1d');

  logger.debug({ date }, 'tradeBin1d generated');
}

/* -------------------------------------------------------------------- */
/*  Shared internals                                                    */
/* -------------------------------------------------------------------- */

async function createBins(
  source:    Collection,
  target:    Collection,
  range:     Range,
  binSize:   BinSize,
  transform: (binSize: BinSize) => import('mongodb').Document[],
): Promise<void> {
  const pipeline = [
    ...matchDocs(transform, range, binSize),
    ...transform(binSize),
    { $merge: {
      into: target.collectionName,
      whenMatched: 'replace',
      whenNotMatched: 'insert',
    } },
  ];

  await source.aggregate(pipeline).toArray();
}

/**
 * Patches first-bin opens at both day boundaries (current day's first bin and,
 * if already processed, next day's first bin) for every symbol that appears in
 * the day we just generated. Symbols outside day N can't have been affected by
 * this run, so they're skipped.
 */
async function patchBoundaries(bins: Collection, range: Range, binSize: BinSize): Promise<void> {
  const dayFloor  = floorToBin(range.from, binSize);
  const nextFloor = floorToBin(range.to,   binSize);

  const symbols = await bins.distinct('symbol', {
    timestamp: { $gt: dayFloor, $lte: nextFloor },
  });

  await Promise.all(symbols.map(symbol => Promise.all([
    patchOpen(bins, symbol, dayFloor),
    patchOpen(bins, symbol, nextFloor),
  ])));
}

async function patchOpen(bins: Collection, symbol: string, floor: string): Promise<void> {
  const [prev, first] = await Promise.all([
    bins.findOne({ symbol, timestamp: { $lte: floor } }, { sort: { timestamp: -1 }, projection: { close: 1 } }),
    bins.findOne({ symbol, timestamp: { $gt:  floor } }, { sort: { timestamp:  1 }, projection: { timestamp: 1 } }),
  ]);

  if (prev && first)
    await bins.updateOne({ _id: first._id }, { $set: { open: prev.close } });
}

/* -------------------------------------------------------------------- */
/*  Date helpers                                                        */
/* -------------------------------------------------------------------- */

function dayRange(date: string): Range {
  return {
    from: `${date}T00:00:00.000Z`,
    to:   nextDay(date),
  };
}

function nextDay(date: string): string {
  const d = new Date(date + 'T00:00:00.000Z');

  d.setUTCDate(d.getUTCDate() + 1);

  return d.toISOString();
}

/* ------------------------------------------------------------------ */
/*  Test-only exports                                                 */
/* ------------------------------------------------------------------ */

export const _test_generate1m = generate1m;
export const _test_generate5m = generate5m;
export const _test_generate1h = generate1h;
export const _test_generate1d = generate1d;
