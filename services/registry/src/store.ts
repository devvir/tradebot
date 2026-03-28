import { readFileSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '@devvir/service-kit';
import { logger } from '@devvir/service-kit';
import type { Entry, Collection } from './types.js';

const COUNTERS  = '_counters';
const DATA_PATH = process.env['REGISTRY_DATA_PATH'] ?? '/data/registry';

// ── File helpers ──────────────────────────────────────────────────────────────

const fieldName = (collection: Collection): string =>
  collection === 'symbols' ? 'symbol' : 'currency';

const filePath = (collection: Collection): string =>
  join(DATA_PATH, `${collection}.json`);

// ── Register ──────────────────────────────────────────────────────────────────
//
// Idempotent: if the value already exists, returns its existing entry.
// If new, assigns the next integer ID and writes a fresh snapshot to disk.

export const register = async (db: Db, collection: Collection, value: string): Promise<Entry> => {
  const existing = await db.collection<Entry>(collection).findOne({ value });

  if (existing) {
    return existing;
  }

  const id = await nextId(db, collection);

  try {
    await db.collection<Entry>(collection).insertOne({ _id: id, value });
  } catch {
    // Race condition — another request inserted the same value first.
    const winner = await db.collection<Entry>(collection).findOne({ value });

    return winner!;
  }

  logger.info({ collection, id, value }, 'Registered new entry');

  await exportSnapshot(db, collection);

  return { _id: id, value };
};

// ── List ──────────────────────────────────────────────────────────────────────

export const list = async (db: Db, collection: Collection): Promise<Entry[]> =>
  db.collection<Entry>(collection).find({}).sort({ _id: 1 }).toArray();

// ── Bootstrap ─────────────────────────────────────────────────────────────────
//
// On startup, if a collection is empty but a JSON snapshot exists on disk,
// seed the DB from the snapshot so integer assignments survive a DB wipe.

export const bootstrap = async (db: Db): Promise<void> => {
  for (const collection of ['symbols', 'currencies'] as Collection[]) {
    const count = await db.collection(collection).countDocuments();

    if (count > 0) {
      logger.debug({ collection, count }, 'Collection already populated — skipping bootstrap');
      continue;
    }

    const file = filePath(collection);

    if (! existsSync(file)) {
      logger.info({ collection }, 'No snapshot file found — starting empty');
      continue;
    }

    const snapshot = JSON.parse(readFileSync(file, 'utf-8')) as Array<Record<string, unknown>>;

    if (snapshot.length === 0) continue;

    const field = fieldName(collection);
    const entries: Entry[] = snapshot.map((row) => ({
      _id:   row['id'] as number,
      value: row[field] as string,
    }));

    await db.collection<Entry>(collection).insertMany(entries);

    const maxId = Math.max(...entries.map((e) => e._id));

    await db.collection(COUNTERS).updateOne(
      { _id: collection as never },
      { $set: { next: maxId + 1 } },
      { upsert: true },
    );

    logger.info({ collection, count: entries.length }, 'Bootstrapped from snapshot');
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

const nextId = async (db: Db, collection: Collection): Promise<number> => {
  const doc = await db.collection<{ _id: string; next: number }>(COUNTERS).findOneAndUpdate(
    { _id: collection as never },
    { $inc: { next: 1 } },
    { upsert: true, returnDocument: 'before' },
  );

  return doc?.next ?? 0;
};

const exportSnapshot = async (db: Db, collection: Collection): Promise<void> => {
  const entries = await list(db, collection);
  const field   = fieldName(collection);
  const data    = entries.map((e) => ({ id: e._id, [field]: e.value }));

  await writeFile(filePath(collection), JSON.stringify(data, null, 2) + '\n', 'utf-8');
};
