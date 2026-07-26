import type { Db, Collection }                  from 'mongodb';
import { makeMongoId, parseMongoId, startOfDayMongoId } from '@tradebot/utils';
import { registry, SK_PROVIDERS }                 from '@devvir/service-kit';
import type { RedisClient }                       from '@devvir/service-kit';

import type { InstrumentMsg } from './types';
import { recordDoc }         from './record';

/** Single Redis key holding the resume anchor `_id` and the commit phase. */
export const RESUME_KEY = 'distiller_instrument';

/** Documents buffered before an `insertMany` flush. */
const BATCH_SIZE = 10_000;

/**
 * Assigns every output document its `_id` — a per-day sequential position with
 * `reserved` 2 (processed real) or 1 (synthetic) — persists it, and runs the
 * two-phase hour commit.
 */
export class Writer {
  private readonly coll:  Collection<InstrumentMsg>;
  private readonly redis: RedisClient;

  private position    = 0;
  private currentDate = '';
  private batch:      InstrumentMsg[] = [];

  constructor(db: Db, resumeFrom: number | null) {
    this.coll  = db.collection<InstrumentMsg>('instrument');
    this.redis = registry.get('distiller', SK_PROVIDERS).get('redis') as RedisClient;

    if (resumeFrom !== null) {
      const { date, position } = parseMongoId(resumeFrom);

      this.currentDate = date;
      this.position    = position;
    }
  }

  /**
   * Assign the next `_id` to a document and buffer it. `date` is the day the
   * `_id` belongs to — the hour's date, including for an hour-23 seal whose
   * timestamp is the next day. Returns the assigned `_id`.
   */
  async add(doc: Omit<InstrumentMsg, '_id'>, isReal: boolean, date: string): Promise<number> {
    if (date !== this.currentDate) {
      this.currentDate = date;
      this.position    = 0;
    }

    this.position++;

    const _id = makeMongoId(date, this.position, isReal ? 2 : 1);

    this.batch.push({ _id, ...doc });
    recordDoc(isReal, date);

    if (this.batch.length >= BATCH_SIZE) await this.flush();

    return _id;
  }

  /**
   * Commit a sealed hour: flush all writes, mark `sealed`, delete the consumed
   * originals, mark `complete`. The phases make every crash point recoverable —
   * before `sealed` the hour is reprocessed whole; at `sealed` it is finished.
   */
  async commit(anchorId: number, maxConsumedId: number | null): Promise<void> {
    await this.flush();

    const consumed = maxConsumedId ?? 0;

    await this.redis.set(RESUME_KEY, `${anchorId}:${consumed}:sealed`);

    if (maxConsumedId !== null) {
      await deleteOriginals(this.coll, this.currentDate, maxConsumedId);
    }

    await this.redis.set(RESUME_KEY, `${anchorId}:${consumed}:complete`);
  }

  private async flush(): Promise<void> {
    if (this.batch.length === 0) return;

    const docs = this.batch;

    this.batch = [];

    await this.coll.insertMany(docs, { ordered: false }).catch(ignoreDuplicateKeyErrors);
  }
}

/**
 * Delete the original (farmer) instrument documents of a committed day up to
 * `maxConsumedId`. Day-scoped and filtered to `reserved 0`, so processed and
 * synthetic documents are never touched.
 */
export async function deleteOriginals(
  coll:          Collection<InstrumentMsg>,
  date:          string,
  maxConsumedId: number,
): Promise<void> {
  await coll.deleteMany({
    _id:   { $gte: startOfDayMongoId(date), $lte: maxConsumedId },
    $expr: { $eq: [{ $mod: ['$_id', 4] }, 0] },
  });
}

function ignoreDuplicateKeyErrors(err: unknown): void {
  const e = err as { code?: number; writeErrors?: { code: number }[] };

  if (e.code === 11000) return;

  if (e.writeErrors?.every(w => w.code === 11000)) return;

  throw err;
}
