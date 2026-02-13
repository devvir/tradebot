import { MongoClient, Db } from 'mongodb';
import logger from './logger';

export interface MongoDBConnection {
  client: MongoClient;
  db: Db;
}

export const connectMongoDB = async (url: string, dbName: string): Promise<MongoDBConnection> => {
  try {
    logger.info('Connecting to MongoDB...');
    const client = new MongoClient(url);
    await client.connect();
    const db = client.db(dbName);
    logger.info({ database: dbName }, 'Connected to MongoDB');
    return { client, db };
  } catch (error) {
    logger.error({ error }, 'Failed to connect to MongoDB');
    throw error;
  }
};

export const getCollectionName = (data: Record<string, unknown>): string => {
  const table = data.table as string;

  // Only high-volume channels get symbol-segregated collections
  const SYMBOL_SEGREGATED = ['orderBookL2', 'quote', 'trade'];

  if (SYMBOL_SEGREGATED.includes(table)) {
    const dataArray = data.data as Array<{ symbol?: string }>;
    const symbol = dataArray?.[0]?.symbol;
    if (symbol) return `${table}_${symbol}`;
  }

  return table;
};

export const extractMinimalAttributes = (
  document: Record<string, unknown>,
  apiVersion?: string | null
): Record<string, unknown> => {
  const result = { ...document };

  if (!result.timestamp) {
    result.timestamp = new Date().toISOString();
  }

  // Include API version for schema versioning and forward compatibility
  if (apiVersion) {
    result._apiVersion = apiVersion;
  }

  return result;
};
