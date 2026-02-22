import type { MongoClient, Db } from 'mongodb';

export interface MongoDBConnection {
  client: MongoClient;
  db: Db;
}

export interface Config {
  rabbitmqUrl: string;
  mongodbUrl: string;
  batchSize: number;
  batchTimeoutMs: number;
  healthPort: number;
}
