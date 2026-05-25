import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from 'redis';
import { MongoBulkWriteError } from 'mongodb';
import { connectMongo } from '../../shared/connections/mongodb';
import { getEnv, requiredEnv } from '../../shared/utils/env';
import { info, success, warn, error } from '../../shared/ui/logger';
import type { PriceLevel } from './types';

const CUTOFF = '20230710';
const BATCH_SIZE = 10000;
const REDIS_KEY = 'synth:levels:completed';
const DB_NAME = 'tradebot_registry';
const COLLECTION = 'priceLevels';

export async function runLevels(): Promise<void> {
  const { client: mongoClient } = await connectMongo();
  const collection = mongoClient.db(DB_NAME).collection<PriceLevel>(COLLECTION);

  const redis = createClient({ url: buildRedisUrl() });
  redis.on('error', (err) => error(`Redis error: ${err.message}`));
  await redis.connect();
  success('Connected to Redis');

  await collection.createIndex({ symbol: 1, price: 1 });

  try {
    const files = discoverFiles(requiredEnv('BITMEX_DATA_DIR'));

    info(`Found ${files.length} vault files after ${CUTOFF}`);

    let totalInserted = 0;

    for (const file of files) {
      const alreadyDone = await redis.sIsMember(REDIS_KEY, file);

      if (alreadyDone) {
        info(`Skip (indexed): ${path.basename(file)}`);
        continue;
      }

      info(`Processing: ${file}`);

      const fileCount = await processFile(file, async (batch) => {
        try {
          await collection.insertMany(batch, { ordered: false });
        } catch (err) {
          if (! (err instanceof MongoBulkWriteError) || err.code !== 11000) throw err;
        }
      }, totalInserted);

      await redis.sAdd(REDIS_KEY, file);

      totalInserted += fileCount;
      success(`  → ${fileCount.toLocaleString()} rows`);
    }

    info(`Total rows inserted this run: ${totalInserted.toLocaleString()}`);
  } finally {
    await redis.quit();
    await mongoClient.close();
  }
}

function discoverFiles(baseDir: string): string[] {
  const results: string[] = [];

  walkForOrderBook(baseDir, results);

  return results
    .filter(f => {
      const stem = path.basename(f).replace(/\.csv\.gz$/, '');
      return stem > CUTOFF;
    })
    .sort();
}

function walkForOrderBook(dir: string, results: string[]): void {
  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    warn(`Cannot read directory: ${dir}`);
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walkForOrderBook(full, results);
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.csv.gz') &&
      full.includes('/orderBookL2/')
    ) {
      results.push(full);
    }
  }
}

const PROGRESS_INTERVAL = 1_000_000;

async function processFile(
  file: string,
  flush: (batch: PriceLevel[]) => Promise<void>,
  totalBefore: number,
): Promise<number> {
  const rl = createInterface({
    input: createReadStream(file).pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  let isHeader = true;
  let actionIdx = -1;
  let symbolIdx = -1;
  let idIdx = -1;
  let priceIdx = -1;
  let batch: PriceLevel[] = [];
  let count = 0;
  let lastLogAt = 0;

  for await (const line of rl) {
    if (! line.trim()) continue;

    if (isHeader) {
      const headers = line.split(',');
      actionIdx = headers.indexOf('_action_');
      symbolIdx = headers.indexOf('symbol');
      idIdx = headers.indexOf('id');
      priceIdx = headers.indexOf('price');

      if (actionIdx === -1 || symbolIdx === -1 || idIdx === -1 || priceIdx === -1) {
        throw new Error(`Missing required columns in ${file}. Got: ${line}`);
      }

      isHeader = false;
      continue;
    }

    const cols = line.split(',');
    const action = cols[actionIdx];

    if (action !== 'partial' && action !== 'insert') continue;

    const rawId = cols[idIdx];
    const rawSymbol = cols[symbolIdx];
    const rawPrice = cols[priceIdx];

    if (rawId === undefined || rawSymbol === undefined || rawPrice === undefined) {
      throw new Error(`Row has fewer columns than header in ${file}: ${line}`);
    }

    const id = parseInt(rawId, 10);
    const price = parseFloat(rawPrice);

    if (isNaN(id)) {
      warn(`Skipping row with non-numeric id in ${path.basename(file)}: ${line}`);
      continue;
    }

    if (isNaN(price)) {
      warn(`Skipping row with missing price in ${path.basename(file)}: ${line}`);
      continue;
    }

    if (! rawSymbol) {
      warn(`Skipping row with empty symbol in ${path.basename(file)}: ${line}`);
      continue;
    }

    batch.push({ _id: id, symbol: rawSymbol, price });

    if (batch.length >= BATCH_SIZE) {
      await flush(batch);
      count += batch.length;
      batch = [];

      const total = totalBefore + count;

      if (Math.floor(total / PROGRESS_INTERVAL) > Math.floor(lastLogAt / PROGRESS_INTERVAL)) {
        info(`  ${total.toLocaleString()} rows processed`);
        lastLogAt = total;
      }
    }
  }

  if (batch.length > 0) {
    await flush(batch);
    count += batch.length;
  }

  return count;
}

function buildRedisUrl(): string {
  const pass = getEnv('CACHE_PASS') ?? '';
  const port = getEnv('CACHE_PORT') ?? '6379';

  return `redis://:${pass}@localhost:${port}`;
}
