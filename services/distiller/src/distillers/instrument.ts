import type { Db }                        from 'mongodb';
import { registry, SK_PROVIDERS, logger } from '@devvir/service-kit';
import type { Service, RedisClient }      from '@devvir/service-kit';
import { parseMongoId }                   from '@tradebot/utils';

import config                                  from '../config';
import type { InstrumentMsg }                  from '../types';
import { createAccumulator, applyMessage }     from './instrument/accumulator';
import { Provider }                            from './instrument/provider';
import { Writer, RESUME_KEY, deleteOriginals } from './instrument/writer';
import { Walker }                              from './instrument/walker';

/**
 * Reconstruct a continuous `instrument` collection — real farmer-imported
 * documents interleaved with synthetic gap fill — one hour at a time.
 *
 * See `docs/planning/INSTRUMENT_DISTILLER.md` for the full design.
 */
export async function distillInstrument(db: Db, service: Service): Promise<void> {
  if (! config.vaultUrl) throw new Error('VAULT_URL is required for the instrument distiller');

  const redis = registry.get('distiller', SK_PROVIDERS).get('redis') as RedisClient;
  const acc   = createAccumulator();
  const prov  = new Provider();

  const anchorId = await bootstrap(db, redis);

  let startHour: string;
  let writer:    Writer;

  if (anchorId !== null) {
    const anchor = await db.collection<InstrumentMsg>('instrument').findOne({ _id: anchorId });

    if (! anchor) {
      logger.error({ anchor: anchorId }, 'instrument: anchor document missing — cannot resume');

      return;
    }

    applyMessage(acc, anchor);
    startHour = anchor.timestamp.slice(0, 13);
    writer    = new Writer(db, anchorId);

    await prov.primeWindow(db, Date.parse(anchor.timestamp));
    logger.info({ anchor: anchorId, from: startHour }, 'instrument: resumed');

  } else {
    const first = await firstDataHour(db);

    if (! first) {
      logger.warn('instrument: no instrument data — nothing to distil');

      return;
    }

    startHour = first;
    writer    = new Writer(db, null);
    logger.info({ from: startHour }, 'instrument: cold start');
  }

  await new Walker(db, service, config.vaultUrl, prov, writer, acc, startHour).run();
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
    logger.info({ anchor: anchorId }, 'instrument: finished a sealed hour on bootstrap');
  }

  return anchorId;
}

/** The `YYYY-MM-DDTHH` hour of the first original instrument document. */
async function firstDataHour(db: Db): Promise<string | null> {
  const doc = await db.collection<InstrumentMsg>('instrument').findOne(
    { $expr: { $eq: [{ $mod: ['$_id', 4] }, 0] } },
    { sort: { _id: 1 }, projection: { timestamp: 1 } },
  );

  return doc ? doc.timestamp.slice(0, 13) : null;
}
