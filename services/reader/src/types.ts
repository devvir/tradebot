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
 * _id values are kept as their actual MongoDB types (Long, ObjectId, etc) for accurate queries.
 */
export interface CollectionPollingState {
  collectionName: string;
  bufferedIds: Set<any>; // Last 1000 _id objects (actual types, not strings)
  lastHighId: any | null; // Highest _id observed in last poll, null on first run
}

/**
 * Persisted state in MongoDB's _reader_state collection.
 * _id values are serialized as strings for JSON persistence, then reconstructed on load.
 */
export interface PersistedPollingState {
  timestamp: Date;
  orderedIds: Record<string, {
    bufferedIds: string[]; // Last 1000 _ids serialized as strings
    lastHighId: string | null; // Highest _id serialized as string
  }>;
}
