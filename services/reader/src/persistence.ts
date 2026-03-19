import { Db } from 'mongodb';
import { logger } from '@devvir/service-kit';
import type { PersistedPollingState } from './types';

const STATE_COLLECTION = '_reader_state';
const STATE_ID = 'reader-state';

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
 * Returns actual _id objects (Long, ObjectId, string, etc) in ascending order.
 */
export const getLatestBufferedIds = async (
  collection: any,
  limit: number
): Promise<any[]> => {
  const docs = await collection
    .find()
    .project({ _id: 1 })
    .sort({ _id: -1 })
    .limit(limit)
    .toArray();

  // Return actual _id objects (not strings), sorted ascending
  return docs.map((doc: any) => doc._id).sort((a: any, b: any) => {
    // Handle different types: Long, number, string, ObjectId
    if (typeof a.compare === 'function') {
      return a.compare(b); // Long has compare method
    }
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
};

/**
 * Get the highest _id in a collection (the maximum _id value as actual object).
 */
export const getHighestId = async (collection: any): Promise<any | null> => {
  const result = await collection.findOne({}, { projection: { _id: 1 }, sort: { _id: -1 } });

  return result?._id || null;
};

/**
 * Scan documents in a collection between startId and endId (inclusive).
 * Works with actual _id objects (Long, ObjectId, number, string, etc).
 * Returns all documents in ascending _id order.
 *
 * Only use for small, bounded queries (e.g. individual pending IDs).
 * For large/unbounded scans use createScanCursor instead.
 */
export const scanCollectionUpToHighId = async (
  collection: any,
  startId: any | null,
  endId: any
): Promise<Array<Record<string, unknown>>> => {
  const query: Record<string, any> = {
    _id: { $lte: endId },
  };

  if (startId !== null) {
    query._id.$gt = startId;
  }

  logger.debug(
    { collectionName: collection.collectionName, startIdStr: String(startId || 'null'), endIdStr: String(endId), query: JSON.stringify(query, (_, v) => typeof v === 'object' && v !== null && typeof v.toString === 'function' && ! Array.isArray(v) ? `[${v.constructor.name}]` : v) },
    'executing scan query',
  );

  return collection.find(query).sort({ _id: 1 }).toArray();
};

/**
 * Return a cursor over documents between startId and endId (inclusive).
 * Streams results without loading everything into memory.
 */
export const createScanCursor = (
  collection: any,
  startId: any | null,
  endId: any,
) => {
  const query: Record<string, any> = {
    _id: { $lte: endId },
  };

  if (startId !== null) {
    query._id.$gt = startId;
  }

  logger.debug(
    { collectionName: collection.collectionName, startIdStr: String(startId || 'null'), endIdStr: String(endId) },
    'opening scan cursor',
  );

  return collection.find(query).sort({ _id: 1 });
};
