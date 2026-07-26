import type { Db }                        from 'mongodb';
import { registry, SK_PROVIDERS, logger } from '@devvir/service-kit';
import type { Service, RedisClient }      from '@devvir/service-kit';
import { parseMongoId, startOfDayMongoId } from '@tradebot/utils';

import type { InstrumentMsg }                  from '../types';
import { createAccumulator, applyMessage }     from './instrument/accumulator';
import { firstCompleteDate }                   from './instrument/boundary';
import { Provider }                            from './instrument/provider';
import { Writer, RESUME_KEY, deleteOriginals } from './instrument/writer';
import { Walker }                              from './instrument/walker';

/**
 * Reconstruct a continuous `instrument` collection — real farmer-imported
 * documents interleaved with synthetic gap fill — one hour at a time.
 *
 * See `docs/services/DISTILLER_INSTRUMENT.md` for the full design.
 */
export async function distillInstrument(db: Db, service: Service): Promise<void> {
  const redis = registry.get('distiller', SK_PROVIDERS).get('redis') as RedisClient;
  const acc   = createAccumulator();
  const prov  = new Provider();

  const anchorId = await bootstrap(db, redis);

  let servedThrough = '';
  let coldStartId   = 0;
  let writer:        Writer;

  if (anchorId !== null) {
    const anchor = await db.collection<InstrumentMsg>('instrument').findOne({ _id: anchorId });

    if (! anchor) {
      logger.error({ anchor: anchorId }, 'Instrument distiller: anchor document missing, cannot resume');

      return;
    }

    applyMessage(acc, anchor);

    // The anchor seals an hour at its end boundary, so its timestamp hour is the
    // next hour to walk; the hour before it is the last one already served.
    servedThrough = hourBefore(anchor.timestamp.slice(0, 13));
    writer        = new Writer(db, anchorId);

    const primeStart = Date.now();

    logger.info({ anchor: anchorId }, 'Instrument distiller: priming rolling window');

    await prov.primeWindow(db, Date.parse(anchor.timestamp));

    logger.info(
      { anchor: anchorId, served: servedThrough, primeMs: Date.now() - primeStart },
      'Instrument distiller: resumed',
    );

  } else {
    const date = await firstCompleteDate();

    if (! date) {
      logger.warn('Instrument distiller: no date where all source tables are complete; nothing to distil');

      return;
    }

    coldStartId = startOfDayMongoId(date);
    writer      = new Writer(db, null);
    logger.info({ from: date }, 'Instrument distiller: cold start');
  }

  await new Walker(db, service, prov, writer, acc, servedThrough, coldStartId).run();
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

/**
 * Read the resume key. If the last hour stopped at `sealed`, finish it — delete
 * its originals, mark `complete`. Returns the anchor `_id` to resume from, or
 * `null` for a cold start.
 */
async function bootstrap(db: Db, redis: RedisClient): Promise<number | null> {
  const raw = await redis.get(RESUME_KEY);

  if (! raw) return null;

  const parts      = raw.split(':');
  const anchorId   = Number(parts[0]);
  const consumedId = Number(parts[1]);
  const phase      = parts[2];

  if (phase === 'sealed') {
    if (consumedId > 0) {
      const coll = db.collection<InstrumentMsg>('instrument');

      await deleteOriginals(coll, parseMongoId(consumedId).date, consumedId);
    }

    await redis.set(RESUME_KEY, `${anchorId}:${consumedId}:complete`);
    logger.info({ anchor: anchorId }, 'Instrument distiller: finished sealed hour on bootstrap');
  }

  return anchorId;
}

/** The `YYYY-MM-DDTHH` key one hour before `hour`. */
function hourBefore(hour: string): string {
  const d = new Date(`${hour}:00:00.000Z`);

  d.setUTCHours(d.getUTCHours() - 1);

  return d.toISOString().slice(0, 13);
}
