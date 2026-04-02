import type { MongoClient } from 'mongodb';
import { logger } from '@devvir/service-kit';

const BIN_COLLECTIONS = [
  'tradeBin1m', 'tradeBin5m', 'tradeBin1h', 'tradeBin1d',
  'quoteBin1m', 'quoteBin5m', 'quoteBin1h', 'quoteBin1d',
];

const ORDERBOOK_COLLECTIONS = ['orderBook10', 'orderBookL2_25'];

const BIN_SOURCE_COLLECTIONS = ['trade', 'quote'];

const INSTRUMENT_SOURCE_COLLECTIONS = ['compositeIndex', 'funding', 'settlement'];

export const bootstrap = async (mongo: MongoClient, database: string): Promise<void> => {
  const db = mongo.db(database);

  logger.info('Ensuring indexes. If this is the first run, this may take a while...');

  for (const collection of BIN_SOURCE_COLLECTIONS) {
    await db.collection(collection).createIndex({ timestamp: 1 });
    logger.debug({ collection }, 'Source indexes ensured');
  }

  for (const collection of BIN_COLLECTIONS) {
    await db.collection(collection).createIndex({ timestamp: 1 });
    logger.debug({ collection }, 'Bin indexes ensured');
  }

  for (const collection of ORDERBOOK_COLLECTIONS) {
    await db.collection(collection).createIndex({ timestamp: 1 });
    logger.debug({ collection }, 'OrderBook indexes ensured');
  }

  for (const collection of INSTRUMENT_SOURCE_COLLECTIONS) {
    await db.collection(collection).createIndex({ timestamp: 1 });
    logger.debug({ collection }, 'Instrument source indexes ensured');
  }

  await db.collection('instrument').createIndex({ _id: 1 });
  logger.debug('Instrument indexes ensured');

  await db.collection('_partials_').createIndex({ table: 1, date: 1 });
  logger.debug('Partials indexes ensured');

  logger.info('Bootstrap complete');
};
