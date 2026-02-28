import type { MongoClient } from 'mongodb';

export interface MongoDBConnection {
  client: MongoClient;
}

/** Writer exchange and queue names — these are the writer's public API. */
export const EXCHANGE = 'writer';
export const DLX = 'writer.dlx';

export const CONSUMER_QUEUES = {
  archive: 'writer.archive',
  collect: 'writer.collect',
  custom: 'writer.custom',
} as const;

export const DLQ = 'writer.dead-letter';

export type ConsumerQueueName = typeof CONSUMER_QUEUES[keyof typeof CONSUMER_QUEUES];

export interface Config {
  mongodbUrl: string;
  rabbitmqUrl: string;
  batchSize: number;
  dbArchive: string;
  dbCollect: string;
}

/**
 * Resolved write target from a routing key.
 *
 * archive.orderBookL2  → { database: dbArchive, collection: 'orderBookL2' }
 * collect.trade         → { database: dbCollect, collection: 'trade' }
 * custom.mydb.mycol     → { database: 'mydb',    collection: 'mycol' }
 */
export interface WriteTarget {
  database: string;
  collection: string;
}
