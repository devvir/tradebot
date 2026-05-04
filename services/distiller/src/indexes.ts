import type { MongoClient } from 'mongodb';
import { registry, SK_PROVIDERS, SK_CONFIG, logger } from '@devvir/service-kit';
import type { Config } from './types';

export type Index = Record<string, -1 | 1>;

const BY_TIMESTAMP:        Index = { timestamp: 1 };
const BY_ACTION_TIMESTAMP: Index = { action: 1, timestamp: 1 };
const BY_SYMBOL_TIMESTAMP: Index = { symbol: 1, timestamp: 1 };

// ── Public API ────────────────────────────────────────────────────────────────

export const ensureIndex = async (collection: string, index: Index | Index[]): Promise<void> => {
  const config    = registry.get('distiller', SK_CONFIG) as unknown as Config;
  const providers = registry.get('distiller', SK_PROVIDERS);
  const mongo     = providers.get('mongodb') as MongoClient;
  const db        = mongo.db(config.database);

  const indexes   = Array.isArray(index) ? index : [ index ];

  for (const idx of indexes)
    await db.collection(collection).createIndex(idx);
};

/**
 * Indexes for collections that have no generator: they are written by other
 * services (journalist, registrar) and distiller cannot own them in a
 * generator. Ensured once at startup.
 */
export const ensureSharedIndexes = async (): Promise<void> => {
  const ts  = BY_TIMESTAMP;
  const at  = BY_ACTION_TIMESTAMP;
  const st  = BY_SYMBOL_TIMESTAMP;

  logger.info('Ensuring indexes. This may take a while...');

  await ensureIndex('announcement',        [ts, at]);
  await ensureIndex('chat',                [ts, at]);
  await ensureIndex('connected',           [ts]);
  await ensureIndex('insurance',           [ts]);
  await ensureIndex('liquidation',         [ts, at, st]);
  await ensureIndex('publicNotifications', [ts]);
};
