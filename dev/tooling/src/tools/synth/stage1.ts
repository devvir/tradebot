import { Collection, MongoBulkWriteError } from 'mongodb';
import { connectMongo } from '../../shared/connections/mongodb';
import { info, success } from '../../shared/ui/logger';
import type { ObFact } from './types';

const COLLECTION = 'orderBookStage1';
const BATCH_SIZE = 5000;
const LOG_INTERVAL = 1_000_000;

export async function runStage1(): Promise<void> {
  const { client } = await connectMongo();
  const db = client.db('tradebot');
  const trades = db.collection('trade');
  const out = db.collection<ObFact>(COLLECTION);

  try {
    await trades.createIndex({ timestamp: 1 });
    await out.createIndex({ timestamp: 1 });
    await out.createIndex({ symbol: 1, timestamp: 1 });
    await out.createIndex({ symbol: 1, side: 1, price: 1, timestamp: 1 });
    success(`Indexes ensured on trade and ${COLLECTION}`);

    const latest = await out.findOne({}, { sort: { timestamp: -1 }, projection: { timestamp: 1 } });
    const resumeFrom = latest?.timestamp ?? null;

    if (resumeFrom) {
      info(`Resuming from ${resumeFrom}`);
    } else {
      info('Starting from beginning of trade history');
    }

    const query = resumeFrom ? { timestamp: { $gte: resumeFrom } } : {};
    const cursor = trades.find(query).sort({ timestamp: 1 });

    let batch: ObFact[] = [];
    let processed = 0;
    let skipped = 0;
    let inserted = 0;
    let currentMonth = '';

    for await (const doc of cursor) {
      const fact = tradeToFact(doc);

      if (! fact) {
        skipped++;
        continue;
      }

      const month = fact.timestamp.slice(0, 7);

      if (month !== currentMonth) {
        currentMonth = month;
        info(`Processing ${currentMonth}`);
      }

      batch.push(fact);
      processed++;

      if (batch.length >= BATCH_SIZE) {
        inserted += await flushFacts(out, batch);
        batch = [];
      }

      if (processed % LOG_INTERVAL === 0) {
        info(`Processed ${processed.toLocaleString()} trades (${skipped.toLocaleString()} skipped, ${inserted.toLocaleString()} inserted)`);
      }
    }

    if (batch.length > 0) {
      inserted += await flushFacts(out, batch);
    }

    success(`Done — ${processed.toLocaleString()} trades processed, ${skipped.toLocaleString()} skipped, ${inserted.toLocaleString()} facts written`);
  } finally {
    await client.close();
  }
}

function tradeToFact(doc: Record<string, unknown>): ObFact | null {
  const { trdMatchID, timestamp, symbol, side, price, size } = doc as Record<string, unknown>;

  if (typeof trdMatchID !== 'string' || ! trdMatchID) return null;
  if (typeof timestamp !== 'string' || ! timestamp) return null;
  if (typeof symbol !== 'string' || ! symbol) return null;
  if (side !== 'Buy' && side !== 'Sell') return null;
  if (typeof price !== 'number' || ! isFinite(price) || price <= 0) return null;
  if (typeof size !== 'number' || ! Number.isInteger(size) || size <= 0) return null;

  return {
    _id: trdMatchID,
    timestamp,
    symbol,
    /** Taker bought → resting ask was hit → fact side is Sell, and vice versa. */
    side: side === 'Buy' ? 'Sell' : 'Buy',
    price,
    size,
  };
}

async function flushFacts(collection: Collection<ObFact>, batch: ObFact[]): Promise<number> {
  try {
    const result = await collection.insertMany(batch, { ordered: false });
    return result.insertedCount;
  } catch (err) {
    if (err instanceof MongoBulkWriteError && err.code === 11000) {
      return (err.result?.insertedCount ?? 0) as number;
    }

    throw err;
  }
}

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_tradeToFact = tradeToFact;
