import { MongoClient } from 'mongodb';
import { logger } from '@devvir/service-kit';

const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 5_000;

/**
 * Connect to MongoDB with retry logic.
 * Ensures service startup waits for database availability.
 */
export const connectToDatabase = async (
  connectionUrl: string,
  maxRetries = MAX_RETRIES,
  delayMs = RETRY_DELAY_MS,
): Promise<MongoClient> => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const mongo = new MongoClient(connectionUrl);
      await mongo.connect();

      logger.debug('Connected to MongoDB');

      return mongo;
    } catch (error) {
      logger.warn({ error, attempt: i + 1, maxRetries }, 'Failed to connect to MongoDB, retrying...');

      if (i < maxRetries - 1) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(`Failed to connect to MongoDB after ${maxRetries} attempts`);
};
