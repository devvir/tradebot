import { MongoClient, Db } from 'mongodb';
import { logger } from '@devvir/service';
import type { MongoDBConnection, PersistedPollingState } from './types';

const STATE_COLLECTION = '_reader_state';
const STATE_ID = 'reader-state';

export const connectToDatabase = async (url: string, database: string): Promise<MongoDBConnection> => {
  logger.info('Connecting to MongoDB...');

  try {
    const client = new MongoClient(url);

    await client.connect();

    logger.info('Connected to MongoDB');

    return { client, db: client.db(database) };
  } catch (error) {
    logger.error({ err: error }, 'Failed to connect to MongoDB');
    throw error;
  }
};

/**
 * Get list of collections to process.
 * If whitelist is empty, returns all non-system collections.
 */
export const getCollectionsToProcess = async (db: Db, whitelist: string[]): Promise<string[]> => {
  const allCollections = await db.listCollections().toArray();
  const collectionNames = allCollections
    .map((c) => c.name)
    .filter((name) => ! name.startsWith('_') && name !== STATE_COLLECTION);

  if (whitelist.length > 0) {
    return collectionNames.filter((name) => whitelist.includes(name));
  }

  return collectionNames;
};

/**
 * Load persisted polling state from MongoDB.
 * Returns empty state if this is the first run.
 * Ensures orderedIds field always exists (never undefined).
 */
export const getPersistedPollingState = async (db: Db): Promise<PersistedPollingState> => {
  try {
    const stateCollection = db.collection<PersistedPollingState & { _id: string }>(
      STATE_COLLECTION
    );
    const state = await stateCollection.findOne({ _id: STATE_ID });

    if (! state) {
      return {
        timestamp: new Date(),
        orderedIds: {},
      };
    }

    // Ensure orderedIds field exists (defensive)
    return {
      timestamp: state.timestamp ?? new Date(),
      orderedIds: state.orderedIds ?? {},
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      { error: message, stack: error instanceof Error ? error.stack : undefined },
      'Error querying MongoDB for polling state'
    );
    throw error;
  }
};

/**
 * Update persisted polling state in MongoDB.
 */
export const updatePersistedPollingState = async (
  db: Db,
  state: PersistedPollingState & { _id: string }
): Promise<void> => {
  try {
    const stateCollection = db.collection<PersistedPollingState & { _id: string }>(
      STATE_COLLECTION
    );

    await stateCollection.updateOne(
      { _id: STATE_ID },
      {
        $set: {
          timestamp: new Date(),
          orderedIds: state.orderedIds,
        },
      },
      { upsert: true }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      { error: message, stack: error instanceof Error ? error.stack : undefined },
      'Error updating polling state in MongoDB'
    );
    throw error;
  }
};

/**
 * Fetch the latest BUFFER_SIZE _ids from a collection.
 * Returns _ids in ascending order (lowest to highest).
 */
export const getLatestBufferedIds = async (
  collection: any,
  limit: number
): Promise<string[]> => {
  const ids = await collection
    .find()
    .project({ _id: 1 })
    .sort({ _id: -1 })
    .limit(limit)
    .toArray()
    .then((docs: any[]) => docs.map((doc) => String(doc._id)).sort());

  return ids;
};

/**
 * Get the highest _id in a collection (the maximum _id value).
 */
export const getHighestId = async (collection: any): Promise<string | null> => {
  const result = await collection.findOne({}, { projection: { _id: 1 }, sort: { _id: -1 } });

  return result?._id ? String(result._id) : null;
};

/**
 * Scan documents in a collection between startId and endId (inclusive).
 * Returns all documents in ascending _id order.
 */
export const scanCollectionUpToHighId = async (
  collection: any,
  startId: string | null,
  endId: string
): Promise<Array<Record<string, unknown>>> => {
  const query: Record<string, any> = {
    _id: { $lte: endId },
  };

  if (startId !== null) {
    query._id.$gt = startId;
  }

  return collection.find(query).sort({ _id: 1 }).toArray();
};
