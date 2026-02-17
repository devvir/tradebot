import type { MongoClient, Db } from 'mongodb';
import type { Broker } from '../../../packages/rabbitmq';

/**
 * BitMEX WebSocket message structure as received from BitMEX API
 */
export interface BitmexRawMessage {
  table: string;
  action: string;
  keys?: string[];
  types?: Record<string, string>;
  foreignKeys?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  data: Array<{ timestamp: string, [key: string]: unknown }>;
}

/**
 * BitMEX WebSocket message as stored/archived
 * Includes _apiVersion (added by feed service for schema tracking)
 * Includes _hash (added by archivist service for uniqueness and sorting)
 */
export interface BitmexWSMessage extends BitmexRawMessage {
  _apiVersion?: string;
  _hash?: string;
}

export interface MongoDBConnection {
  client: MongoClient;
  db: Db;
}

export interface ArchivistState {
  mongoConnection: MongoDBConnection | null;
  broker: Broker | null;
  isShuttingDown: boolean;
  messagesProcessed: number;
  lastProcessedTime: number;
}

export interface Config {
  rabbitmqUrl: string;
  mongodbUrl: string;
  batchSize: number;
  batchTimeoutMs: number;
  healthPort: number;
}

export interface HealthState {
  mongoConnected: boolean;
  mqConnected: boolean;
  messagesProcessed: number;
  lastProcessedTime: number;
}
