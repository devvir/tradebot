import { MongoClient, Db } from 'mongodb';
import { redactUrl } from '@tradebot/utils';
import { getEnv } from '../../../shared/utils/env';
import { info, success } from '../../../shared/ui/logger';

/**
 * Connect to MongoDB using the env vars resolved by `loadEnv`:
 *   DB_URL       — full connection string (already built from DB_USER/DB_PASS/DB_PORT
 *                  in dev/tooling/.env)
 *   DB_DATABASE  — database to operate on; falls back to the URL's default if unset
 */
export async function connectDbTool(): Promise<{ client: MongoClient; db: Db }> {
  const url      = getEnv('DB_URL') ?? 'mongodb://localhost:27017';
  const database = getEnv('DB_DATABASE');

  info(`Connecting to MongoDB: ${redactUrl(url)}`);

  const client = new MongoClient(url);
  await client.connect();

  const db = database ? client.db(database) : client.db();

  success(`Connected (db: ${db.databaseName})`);

  return { client, db };
}

/**
 * Mongo connection URI for the official CLI tools (mongodump, mongorestore),
 * with the strict shape they require:
 *
 *   `mongodb://user:pass@host:port?authSource=admin`
 * →  `mongodb://user:pass@host:port/?authSource=admin`
 *
 * The Node driver tolerates the missing slash before the query; the Go-based
 * CLIs reject it with "must have a / before the query ?".
 */
export function mongoUri(): string {
  const uri = getEnv('DB_URL');

  if (! uri) throw new Error('DB_URL is not set');

  return uri.replace(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(\?)/, '$1/$2');
}
