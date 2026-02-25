import type { Db } from 'mongodb';
import { logger } from '@devvir/service';
import { BUFFER_SIZE } from './config.js';
import type { CollectionPollingState, PersistedPollingState, Config } from './types.js';
import { getLatestBufferedIds, getHighestId, scanCollectionUpToHighId, getCollectionsToProcess } from './persistence.js';

/**
 * In-memory collection polling states.
 * Maps collection name to its current polling state.
 */
export const collectionStates: Map<string, CollectionPollingState> = new Map();

/**
 * Convert in-memory collection states to persisted format.
 * Ready for storage in MongoDB.
 */
export function collectionsStateToPersisted(
  states: Map<string, CollectionPollingState> = collectionStates,
): PersistedPollingState {
  const orderedIds: Record<string, { bufferedIds: string[]; lastHighId: string | null }> = {};
  states.forEach((state, collectionName) => {
    orderedIds[collectionName] = {
      bufferedIds: Array.from(state.bufferedIds),
      lastHighId: state.lastHighId,
    };
  });
  return {
    timestamp: new Date(),
    orderedIds,
  };
}

/**
 * Restore in-memory collection states from persisted format.
 * Called during service startup to recover previous polling positions.
 */
export function restoreCollectionStatesFromPersisted(
  persisted: PersistedPollingState,
): void {
  if (! persisted?.orderedIds) {
    return;
  }

  for (const [collectionName, stateData] of Object.entries(persisted.orderedIds)) {
    if (! stateData) {
      continue;
    }
    const state: CollectionPollingState = {
      collectionName,
      bufferedIds: new Set(stateData.bufferedIds || []),
      lastHighId: stateData.lastHighId || null,
    };
    collectionStates.set(collectionName, state);
  }
}

/**
 * Initialize collection state for first-time processing.
 * Creates initial state with empty buffer and null boundary.
 */
export function initializeCollectionState(collectionName: string): CollectionPollingState {
  const state: CollectionPollingState = {
    collectionName,
    bufferedIds: new Set<string>(),
    lastHighId: null,
  };
  collectionStates.set(collectionName, state);
  return state;
}

/**
 * Process a single collection: handle pending ids and new ids using unified algorithm.
 * Works for both first-run (oldHighId=null) and polling (oldHighId set).
 *
 * Single unified flow:
 * 1. Snapshot current highest id in collection (NEW HIGH)
 * 2. Load previous buffer and boundary from state (null on first run)
 * 3. Get latest 1000 document ids from collection
 * 4. If we have previous boundary: find pending docs (out-of-order catches between oldHigh and newBuf)
 * 5. If newHigh != oldHigh or oldHigh null: process new docs (from oldHigh to newHigh)
 * 6. Update state with new buffer and boundary
 */
export async function processCollection(
  db: Db,
  collectionName: string,
  onPublish?: (documentId: string, doc: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  try {
    const collection = db.collection(collectionName);

    // 1. Snapshot current highest id (NEW HIGH)
    const newHighId = await getHighestId(collection);
    if (! newHighId) {
      logger.debug({ collectionName }, 'collection is empty');
      return;
    }

    // 2. Get or initialize state
    let state = collectionStates.get(collectionName);
    if (! state) {
      state = initializeCollectionState(collectionName);
    }
    const oldHighId = state.lastHighId;
    const oldBufferedIds = new Set(state.bufferedIds);

    // 3. Get latest buffer (1000 most recent ids)
    const newBufferedIds = await getLatestBufferedIds(collection, BUFFER_SIZE);
    const newBufferedIdSet = new Set(newBufferedIds);

    // 4. Detect pending ids (out-of-order writes from previous buffer that still need processing)
    const pendingIds: string[] = [];
    if (oldHighId) {
      // Only check for pending if we have previous boundary (not first run)
      for (const id of oldBufferedIds) {
        if (! newBufferedIdSet.has(id)) {
          // Id was in old buffer but not in new buffer = fell out, potential pending
          pendingIds.push(id);
        }
      }
    }

    // 5a. Process pending ids (only if we have previous state)
    if (pendingIds.length > 0 && oldHighId) {
      logger.debug(
        { collectionName, count: pendingIds.length },
        'processing pending ids from previous iteration',
      );
      for (const docId of pendingIds) {
        const docs = await scanCollectionUpToHighId(collection, docId, docId);
        for (const doc of docs) {
          if (onPublish) {
            await onPublish(docId, doc);
          }
        }
      }
    }

    // 5b. Process new ids (from oldHighId boundary to newHighId)
    if (oldHighId !== newHighId || ! oldHighId) {
      const startId = oldHighId || null; // null means process from lowest id in new buffer
      logger.debug(
        { collectionName, startId, endId: newHighId },
        'processing new documents',
      );
      const docs = await scanCollectionUpToHighId(collection, startId, newHighId);
      for (const doc of docs) {
        const docId = String(doc._id);
        if (onPublish) {
          await onPublish(docId, doc);
        }
      }
    }

    // 6. Update state
    state.bufferedIds = newBufferedIdSet;
    state.lastHighId = newHighId;
    collectionStates.set(collectionName, state);

    logger.debug(
      { collectionName, newHighId, bufferSize: newBufferedIds.length },
      'collection processing complete',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logger.error(
      { collectionName, message, stack, err },
      'error processing collection',
    );
    throw err;
  }
}

/**
 * Run the main polling loop: repeatedly scan all collections at interval.
 * Discovers collections dynamically on each iteration, so new collections
 * added to MongoDB after service startup will be picked up automatically.
 */
export function runPollingLoop(
  db: Db,
  config: Config,
  onMessage: (collectionName: string, doc: Record<string, unknown>) => Promise<void>,
): void {
  logger.info({ intervalMs: config.pollIntervalMs }, 'starting polling loop');

  const poll = async () => {
    const iterationStartTime = Date.now();
    let docsPublishedThisIteration = 0;
    let progressInterval: NodeJS.Timeout | null = null;

    try {
      // Discover collections on each iteration (allows dynamic collection addition)
      const collectionNames = await getCollectionsToProcess(db, config.collections);

      if (collectionNames.length === 0) {
        logger.debug('No collections to process in this iteration');
      } else {
        logger.info({ count: collectionNames.length }, 'Starting iteration');

        // Start progress reporting every 2 seconds during iteration
        progressInterval = setInterval(() => {
          logger.info(
            { docsPublished: docsPublishedThisIteration },
            'Iteration progress',
          );
        }, 2000);

        for (const collectionName of collectionNames) {
          await processCollection(db, collectionName, async (_docId, doc) => {
            await onMessage(collectionName, doc);
            docsPublishedThisIteration++;
          });
        }
      }
    } catch (err) {
      logger.error({ err }, 'polling iteration failed');
    } finally {
      // Clear progress interval
      if (progressInterval) {
        clearInterval(progressInterval);
      }

      // Log iteration completion
      const iterationDuration = Date.now() - iterationStartTime;
      const nextIterationTime = config.pollIntervalMs;
      logger.info(
        {
          docsPublished: docsPublishedThisIteration,
          durationMs: iterationDuration,
          resumeInMs: nextIterationTime,
        },
        'Iteration complete, next iteration in',
      );
    }

    // Schedule next iteration after this one completes
    setTimeout(poll, config.pollIntervalMs);
  };

  // Start the first polling iteration
  poll().catch((err) => {
    logger.error({ err }, 'Initial polling iteration failed');
  });
}
