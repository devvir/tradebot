import type { MongoClient, Db } from 'mongodb';
import type { Connection, Channel } from 'amqplib';

export interface MongoDBConnection {
  client: MongoClient;
  db: Db;
}

export interface RabbitMQConnection {
  connection: Connection;
  channel: Channel;
}

export interface ArchivistState {
  mongoConnection: MongoDBConnection | null;
  rabbitmqConnection: RabbitMQConnection | null;
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
