import type { MongoClient, Db } from 'mongodb';
import type { Broker } from '../../../packages/rabbitmq';

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
