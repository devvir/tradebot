import type { Collection, Db } from 'mongodb';import { logger } from '@devvir/service-kit';
import { ensureIndex } from '../utils/indexes';
import { INSTRUMENT_KEYS, INSTRUMENT_TYPES, INSTRUMENT_FILTER } from './instrument/seeds';
import { fetchDayEvents, processDayEvents } from './instrument/events';
import { createRunState, seedRunState, applyMonthlyReset } from './instrument/state';
import { DAY_ID_STRIDE, addDay, makeId, offsetToDate } from './instrument/ids';
import type { InstrumentItem, InstrumentMsg } from '../types';

/**
 * Generate `instrument` WebSocket-shaped messages from the five vault sources
 * (compositeIndex, quote, trade, funding, settlement).
 *
 * Output shape per day:
 *  - one start-of-day `partial` snapshot at msgIndex 0
 *  - N `insert`/`update` deltas (first appearance of a symbol → insert,
 *    subsequent events → update)
 *
 * The partial on the very first day is intentionally empty when no prior
 * Tardis snapshot covers the coverage-start date — the table then converges
 * organically as inserts arrive. Tardis monthly anchors (April 2019 onwards)
 * reset the accumulator to the full snapshot and fill in semi-static fields
 * that no vault source captures.
 *
 * Re-runs are safe: `_id`s are deterministic, the write uses `ordered: false`,
 * and duplicate-key errors are ignored.
 */
export async function distillInstrument(db: Db): Promise<void> {
  const collections = [ 'compositeIndex', 'settlement', 'funding', 'instrument' ];

  await Promise.all(collections.map(collection => ensureIndex(db, collection, [
    { timestamp: 1 },
    { action: 1, timestamp: 1 },
    { symbol: 1, timestamp: 1 },
  ])));

  const coll = db.collection<InstrumentMsg>('instrument');

  const window = await findCoverageWindow(db);

  if (! window) {
    logger.info('Distilling instrument: no vault data — skipping');
    return;
  }

  const { start: coverageStart, end: lastDay } = window;
  const resumeDay = await findResumeDay(coll, coverageStart, lastDay);

  if (resumeDay >= lastDay) {
    logger.info('Distilling instrument: already up to date');
    return;
  }

  logger.info({ resumeDay, lastDay }, 'Distilling instrument (resume)');

  const state = createRunState();

  await seedRunState(coll, state, resumeDay, coverageStart);

  let currentDay = resumeDay;
  let batch:     InstrumentMsg[] = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;

    const toWrite = batch;

    batch = [];
    await coll.insertMany(toWrite, { ordered: false }).catch(ignoreDuplicateKeyErrors);
  };

  while (currentDay < lastDay) {
    if (currentDay.slice(8) === '01')
      logger.info(`Distilling instrument: month of ${currentDay}`);

    applyMonthlyReset(state, currentDay);

    batch.push({
      _id:    makeId(currentDay, 0),
      action: 'partial',
      keys:   INSTRUMENT_KEYS,
      types:  INSTRUMENT_TYPES,
      filter: INSTRUMENT_FILTER,
      data:   state.table.snapshot() as Partial<InstrumentItem>[],
    });

    const dayStart = `${currentDay}T00:00:00.000Z`;
    const dayEnd   = `${addDay(currentDay)}T00:00:00.000Z`;
    const events   = await fetchDayEvents(db, dayStart, dayEnd);

    let dayDocs = 1;

    for (const doc of processDayEvents(state, currentDay, events)) {
      batch.push(doc);
      dayDocs++;

      if (batch.length >= BATCH_SIZE) await flush();
    }

    logger.debug({ day: currentDay, docs: dayDocs }, 'Distilling instrument: day written');

    currentDay = addDay(currentDay);
  }

  await flush();

  logger.info('Distilling instrument: complete');
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

const BATCH_SIZE = 10_000;

/**
 * Coverage starts at the latest first-timestamp across all five sources,
 * and ends at the earliest last-timestamp — only days with data from every
 * source are produced.
 */
async function findCoverageWindow(db: Db): Promise<{ start: string; end: string } | null> {
  const sources = ['compositeIndex', 'quote', 'trade', 'funding', 'settlement'];

  const [firstDocs, lastDocs] = await Promise.all([
    Promise.all(sources.map(s => db.collection(s).findOne<{ timestamp: string }>(
      {},
      { sort: { timestamp: 1 }, projection: { timestamp: 1 } },
    ))),
    Promise.all(sources.map(s => db.collection(s).findOne<{ timestamp: string }>(
      {},
      { sort: { timestamp: -1 }, projection: { timestamp: 1 } },
    ))),
  ]);

  if (firstDocs.some(d => ! d) || lastDocs.some(d => ! d)) return null;

  const start = firstDocs
    .map(d => d!.timestamp.slice(0, 10))
    .reduce((max, ts) => ts > max ? ts : max);

  const end = lastDocs
    .map(d => d!.timestamp.slice(0, 10))
    .reduce((min, ts) => ts < min ? ts : min);

  if (start >= end) return null;

  return { start, end };
}

/**
 * Find the most recent day whose start-of-day partial was written. Those are
 * the only documents with `_id % DAY_ID_STRIDE === 1` (msgIndex = 0), so the
 * modulo predicate matches them uniquely. Returns the first day that still
 * needs processing (= day of the last partial, which is re-run idempotently).
 */
async function findResumeDay(
  coll:          Collection<InstrumentMsg>,
  coverageStart: string,
  lastDay:       string,
): Promise<string> {
  const boundary = makeId(addDay(lastDay), 0);

  const found = await coll.findOne<{ _id: number }>(
    { _id: { $mod: [DAY_ID_STRIDE, 1], $lt: boundary } } as Parameters<typeof coll.findOne>[0],
    { sort: { _id: -1 }, projection: { _id: 1 } },
  );

  if (! found) return coverageStart;

  return offsetToDate(Math.floor(found._id / DAY_ID_STRIDE));
}

function ignoreDuplicateKeyErrors(err: unknown): void {
  const e = err as { code?: number; writeErrors?: { code: number }[] };

  if (e.code === 11000) return;

  if (e.writeErrors?.every(w => w.code === 11000)) return;

  throw err;
}
