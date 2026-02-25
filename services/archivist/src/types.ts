import type { MongoClient, Db } from 'mongodb';

export interface MongoDBConnection {
  client: MongoClient;
  db: Db;
}

export interface Config {
  mongodbUrl: string;
  database: string;
  rabbitmqUrl: string;
  exchangeName: string;
  queueName: string;
  batchSize: number;
  batchTimeoutMs: number;
}
