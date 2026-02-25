import { Db, MongoClient } from 'mongodb';
import { Broker } from '@devvir/rabbitmq';

export interface ReaderState {
  mongoConnection: { client: any; db: Db } | null;
  broker: Broker | null;
  isShuttingDown: boolean;
  messagesPublished: number;
  lastPublishedTime: number;
}

export interface Config {
  mongodbUrl: string;
  database: string;
  rabbitmqUrl: string;
  exchangeName: string;
  queueName: string;
  batchSize: number;
  pollIntervalMs: number;
  collections: string[]; // Empty array = all collections
}

export interface MongoDBConnection {
  client: MongoClient;
  db: Db;
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
 * Persisted state in MongoDB's _reader_state collection.
 * Checkpoint data for disaster recovery - in-memory sets reconstructed on startup.
 */
export interface PersistedPollingState {
  timestamp: Date;
  orderedIds: Record<string, {
    bufferedIds: string[]; // Last 1000 _ids (persisted as array)
    lastHighId: string | null;
  }>;
}
