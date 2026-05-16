import type { Db } from 'mongodb';
import { logger } from '@devvir/service-kit';

export type Index = Record<string, -1 | 1>;

const BY_TIMESTAMP:        Index = { timestamp: 1 };
const BY_ACTION_TIMESTAMP: Index = { action: 1, timestamp: 1 };
const BY_SYMBOL_TIMESTAMP: Index = { symbol: 1, timestamp: 1 };

export const ensureIndex = async (db: Db, collection: string, index: Index | Index[]): Promise<void> => {
  const indexes = Array.isArray(index) ? index : [ index ];

  for (const idx of indexes)
    await db.collection(collection).createIndex(idx);
};

/**
 * Indexes for collections that have no distiller: they are written by other
 * services (journalist, registrar) and distiller cannot own them in a
 * distiller. Ensured once at startup.
 */
export const ensureSharedIndexes = async (db: Db): Promise<void> => {
  const ts  = BY_TIMESTAMP;
  const at  = BY_ACTION_TIMESTAMP;
  const st  = BY_SYMBOL_TIMESTAMP;

  logger.info('Ensuring indexes. This may take a while...');

  await ensureIndex(db, 'announcement',        [ts, at]);
  await ensureIndex(db, 'chat',                [ts, at]);
  await ensureIndex(db, 'connected',           [ts]);
  await ensureIndex(db, 'insurance',           [ts]);
  await ensureIndex(db, 'liquidation',         [ts, at, st]);
  await ensureIndex(db, 'publicNotifications', [ts]);
};
