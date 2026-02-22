import { Db } from 'mongodb';
import { Broker } from '@devvir/rabbitmq';

export interface UnarchivistState {
  mongoConnection: { client: any; db: Db } | null;
  broker: Broker | null;
  isShuttingDown: boolean;
  messagesPublished: number;
  lastPublishedTime: number;
}

export interface Config {
  rabbitmqUrl: string;
  mongodbUrl: string;
  batchSize: number;
  collections: string[]; // Empty array = all collections
  healthPort: number;
  pollIntervalMs: number;
}

/**
 * Per-collection polling state maintained in memory during polling loop.
 * Tracks buffer of recent ids and highest id observed to detect new/pending documents.
 */
export interface CollectionPollingState {
  collectionName: string;
  bufferedIds: Set<string>; // Last 1000 _ids from buffer (in-memory only)
  lastHighId: string | null; // Highest _id observed in last poll, null on first run
}

/**
 * Persisted state in MongoDB's _unarchivist_state collection.
 * Checkpoint data for disaster recovery - in-memory sets reconstructed on startup.
 */
export interface PersistedPollingState {
  timestamp: Date;
  orderedIds: Record<string, {
    bufferedIds: string[]; // Last 1000 _ids (persisted as array)
    lastHighId: string | null;
  }>;
}

export interface HealthState {
  mongoConnected: boolean;
  mqConnected: boolean;
  messagesPublished: number;
  lastPublishedTime: number;
}
