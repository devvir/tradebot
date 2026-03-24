import { MongoClient, Db } from 'mongodb';
import { getEnv } from '../utils/env';
import { discoverService } from '../utils/service-discovery';
import { info, success } from '../ui/logger';

export async function connectMongo(): Promise<{ client: MongoClient; db: Db; url: string }> {
  let url = getEnv('DB_URL') || 'mongodb://localhost:27017/tradebot';

  const discovered = await discoverService('mongodb', (host, port) => {
    const user = getEnv('DB_USER') || 'readerdb';
    const pass = getEnv('DB_PASS') || '';
    return `mongodb://${user}:${pass}@${host}:${port}?authSource=admin`;
  });

  if (discovered) url = discovered.url;

  info(`Connecting to MongoDB: ${url}`);

  const client = new MongoClient(url);
  await client.connect();
  success('Connected to MongoDB');

  return { client, db: client.db(), url };
}
