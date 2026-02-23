import { logger } from '@devvir/service';
import { Db } from 'mongodb';
import {
  getPersistedPollingState,
  updatePersistedPollingState,
} from './persistence';
import { restoreCollectionStatesFromPersisted, collectionsStateToPersisted } from './poller';
import type { PersistedPollingState } from './types';

/**
 * Load polling state from MongoDB and reconstruct in-memory state.
 */
export const loadPollingState = async (db: Db): Promise<void> => {
  try {
    const persistedState = await getPersistedPollingState(db);
    restoreCollectionStatesFromPersisted(persistedState);
  } catch (error) {
    logger.error({ err: error }, 'Failed to load polling state from MongoDB');
    throw error;
  }
};

/**
 * Save current in-memory state to MongoDB for disaster recovery.
 */
export const savePollingState = async (db: Db): Promise<void> => {
  try {
    const persistedState = collectionsStateToPersisted();
    const withId: PersistedPollingState & { _id: string } = {
      ...persistedState,
      _id: 'unarchivist-state',
    };

    await updatePersistedPollingState(db, withId);
  } catch (error) {
    logger.error({ err: error }, 'Failed to save polling state to MongoDB');
  }
};

/**
 * Start a periodic task to save state to MongoDB.
 * This ensures disaster recovery even if the service crashes unexpectedly.
 */
export const startPeriodicStateSave = async (db: Db, intervalMs = 10000) => {
  setInterval(async () => await savePollingState(db), intervalMs);

  await savePollingState(db);
};
