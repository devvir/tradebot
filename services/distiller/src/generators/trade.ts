import type { MongoClient, Collection, Db, Document } from 'mongodb';
import { logger } from '@devvir/service-kit';
import { trades2bins, bins2bins, matchDocs, floorToBin } from './trade.bins';
import { ensureIndex } from '../indexes';
import type { BinSize, Range } from './types';

const COLL_TRADE = 'trade';
const COLL_BIN1M = 'tradeBin1m';
const BATCH_SIZE = 30; // minutes for 1m bins, days for coarser bins
const POLL_MS    = 5_000;

export async function distillTrades(mongo: MongoClient, database: string): Promise<void> {
  const collections = [ 'trade', 'tradeBin1m', 'tradeBin5m', 'tradeBin1h', 'tradeBin1d' ];

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

/* -------------------------------------------------------------------- */
/*  1-minute bins                                                       */
/* -------------------------------------------------------------------- */

async function distill1mBins(db: Db): Promise<void> {
  const trades = db.collection(COLL_TRADE);
  const bins1m = db.collection(COLL_BIN1M);

  let range: Range | null = await firstRange(trades, bins1m);

  if (range)
    logger.info(`Distilling tradeBin1m from ${range.from.slice(0, 10)}`);

  while (range) {

    if (/00:[0-2]/.test(range.from.slice(11, 15))) /** Log once per day */
      logger.info(`Distilling tradeBin1m: ${range.from.slice(0, 10)}`);

    await create1mBins(db, range);

    range = await nextRange(trades, range, BATCH_SIZE);
  }
}

async function create1mBins(db: Db, range: Range): Promise<void> {
  const trades = db.collection(COLL_TRADE);
  const bins1m = db.collection(COLL_BIN1M);

  await createBins(trades, bins1m, range, '1m', trades2bins);
  await patchBoundaryOpen(bins1m, range, '1m');
}

/* -------------------------------------------------------------------- */
/*  Coarser bins (5m, 1h, 1d) — run in parallel with 1m                 */
/* -------------------------------------------------------------------- */

/**
 * Aggregates 1m bins into 5m/1h/1d bins, running concurrently with the 1m loop.
 * `isDone` flips when 1m finishes. Exits only after a full drain pass produces
 * no new range AND 1m is done, guaranteeing nothing is left behind.
 *
 * Uses $merge: replace, so partial coarser buckets at the trailing edge are
 * safely updated on subsequent passes as more 1m bins arrive. The 1m source
 * already excludes the tip minute, so only complete minutes ever contribute.
 */
async function distillCoarserBins(db: Db, isDone: () => boolean, wakeup: Promise<void>): Promise<void> {
  const trades = db.collection(COLL_TRADE);
  const bins1m = db.collection(COLL_BIN1M);
  const bins5m = db.collection('tradeBin5m');
  const bins1h = db.collection('tradeBin1h');
  const bins1d = db.collection('tradeBin1d');

  const minutes = BATCH_SIZE * 24 * 60;

  let resumeFrom: string | null = null;

  while (true) {
    // Use the raw trades collection as the upper bound so coarser
    // completeness is derived from the source of truth, not from 1m's
    // (mutable) tip policy. matchDocs floors per binSize, so each
    // coarser size naturally caps at its own last-complete boundary.
    let range: Range | null = resumeFrom === null
      ? await firstCoarseRange(bins1m, [bins5m, bins1h, bins1d], bins1m, trades)
      : await nextCoarseRange(bins1m, trades, { from: '', to: resumeFrom }, minutes);

    let processedAny = false;

    while (range) {
      logger.info(`Distilling coarser trade bins: ${range.from.slice(0, 10)}`);

      await createBins(bins1m, bins5m, range, '5m', bins2bins);
      await patchBoundaryOpen(bins5m, range, '5m');
      await createBins(bins1m, bins1h, range, '1h', bins2bins);
      await patchBoundaryOpen(bins1h, range, '1h');
      await createBins(bins1m, bins1d, range, '1d', bins2bins);
      await patchBoundaryOpen(bins1d, range, '1d');

      resumeFrom   = range.to;
      range        = await nextCoarseRange(bins1m, trades, range, minutes);
      processedAny = true;
    }

    if (isDone() && ! processedAny) return;

    // Wait for either a poll tick or p1m finishing — whichever comes first.
    if (! processedAny) await Promise.race([sleep(POLL_MS), wakeup.catch(() => {})]);
  }
}

/* -------------------------------------------------------------------- */
/*  Shared internals                                                    */
/* -------------------------------------------------------------------- */

async function createBins(
  source:    Collection,
  target:    Collection,
  range:     Range,
  binSize:   BinSize,
  transform: (binSize: BinSize) => Document[],
): Promise<void> {
  const pipeline = [
    ...matchDocs(transform, range, binSize),  // Match full buckets of docs in range
    ...transform(binSize),                    // Aggregate into output bins
    { $merge: {
      into: target.collectionName,
      whenMatched: 'replace',
      whenNotMatched: 'insert',
    } },
  ];

  await source.aggregate(pipeline).toArray();

  logger.debug({ from: range.from, to: range.to, target: target.collectionName }, 'createBins complete');
}

const firstRange = async (trades: Collection, bins1m: Collection): Promise<Range | null> => {
  const lastBin = await bins1m.findOne({}, { sort: { timestamp: -1 }, projection: { timestamp: 1 } });

  let from: string;

  if (lastBin) {
    from = lastBin.timestamp as string;
  } else {
    const firstTrade = await trades.findOne({}, { sort: { _id: 1 }, projection: { timestamp: 1 } });

    if (! firstTrade) return null;

    from = (firstTrade.timestamp as string).slice(0, 10) + 'T00:00:00.000Z';
  }

  const maxTs = await maxTimestamp(trades);

  if (! maxTs || from >= maxTs) return null;

  const to = addMinutes(from, BATCH_SIZE) < maxTs ? addMinutes(from, BATCH_SIZE) : maxTs;

  return { from, to };
};

const firstCoarseRange = async (source: Collection, targets: Collection[], binsSource: Collection, rawSource: Collection): Promise<Range | null> => {
  const maxTs = await effectiveMax(binsSource, rawSource);

  if (! maxTs) return null;

  const lastDocs = await Promise.all(
    targets.map(t => t.findOne({}, { sort: { timestamp: -1 }, projection: { timestamp: 1 } })),
  );

  let from: string;

  const lastTimestamps = lastDocs.filter(Boolean).map(doc => doc!.timestamp as string);

  if (lastTimestamps.length === targets.length) {
    from = lastTimestamps.reduce((min, ts) => ts < min ? ts : min);
  } else {
    const firstBin = await source.findOne({}, { sort: { _id: 1 }, projection: { timestamp: 1 } });

    if (! firstBin) return null;

    from = (firstBin.timestamp as string).slice(0, 10) + 'T00:00:00.000Z';
  }

  if (from >= maxTs) return null;

  const minutes = BATCH_SIZE * 24 * 60;
  const to = addMinutes(from, minutes) < maxTs ? addMinutes(from, minutes) : maxTs;

  return { from, to };
};

const nextRange = async (source: Collection, range: Range, minutes: number): Promise<Range | null> => {
  const from     = range.to;
  const maxTs    = await maxTimestamp(source);
  const batchEnd = addMinutes(from, minutes);

  if (! maxTs || from >= maxTs) return null;

  return { from, to: batchEnd < maxTs ? batchEnd : maxTs };
};

/**
 * Cap for coarser processing — min of the 1m bin table's max and the raw
 * source's max. Ensures we don't race ahead of 1m (no skipped ranges) while
 * still grounding completeness in the raw source (tip-policy independent).
 */
const effectiveMax = async (binsSource: Collection, rawSource: Collection): Promise<string | null> => {
  const [binsMax, rawMax] = await Promise.all([maxTimestamp(binsSource), maxTimestamp(rawSource)]);

  if (! binsMax || ! rawMax) return null;

  return binsMax < rawMax ? binsMax : rawMax;
};

const nextCoarseRange = async (binsSource: Collection, rawSource: Collection, range: Range, minutes: number): Promise<Range | null> => {
  const from  = range.to;
  const maxTs = await effectiveMax(binsSource, rawSource);

  if (! maxTs || from >= maxTs) return null;

  const batchEnd = addMinutes(from, minutes);

  return { from, to: batchEnd < maxTs ? batchEnd : maxTs };
};

const maxTimestamp = async (source: Collection): Promise<string | null> => {
  const doc = await source.findOne({}, { sort: { _id: -1 }, projection: { timestamp: 1 } });

  return doc ? doc.timestamp as string : null;
};

const addMinutes = (ts: string, minutes: number): string => {
  const d = new Date(ts);

  d.setUTCMinutes(d.getUTCMinutes() + minutes);

  return d.toISOString();
};

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/**
 * $shift in fixOpen() only sees documents in the current pipeline run, so the
 * first bin of each batch has no predecessor. Patch it: copy the close of the
 * last bin before range.from into the open of the first new bin after range.from.
 *
 * Uses strict $gt so we skip past the previous run's last bin (whose timestamp
 * equals range.from) and land on the actual first bin produced by this run.
 */
async function patchBoundaryOpen(bins: Collection, range: Range, binSize: BinSize): Promise<void> {
  const from = floorToBin(range.from, binSize);

  const symbols: string[] = await bins.distinct('symbol', { timestamp: { $gt: from } });

  await Promise.all(symbols.map(async (symbol) => {
    const prev  = await bins.findOne({ symbol, timestamp: { $lte: from } }, { sort: { timestamp: -1 }, projection: { close: 1 } });
    const first = await bins.findOne({ symbol, timestamp: { $gt:  from } }, { sort: { timestamp:  1 }, projection: { timestamp: 1 } });

    if (prev && first)
      await bins.updateOne({ _id: first._id }, { $set: { open: prev.close } });
  }));
}
