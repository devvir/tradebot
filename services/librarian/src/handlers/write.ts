/**
 * `POST /:table` handler — bulk-insert a JSON array of documents into the
 * named collection. Duplicate-key (E11000) is treated as a caller-fault
 * outcome, not a server failure: success when `ignoreDuplicates` is set,
 * otherwise `409` with the partial-insert count.
 */

import { logger } from '@devvir/service-kit';
import type { RequestHandler } from 'express';
import type { Db, Document } from 'mongodb';
import type { Config, InsertCounter } from '../types';

export const makeWriteHandler = (db: Db, config: Config, counter: InsertCounter): RequestHandler => async (req, res) => {
  const table = String(req.params.table);
  const docs  = req.body as Document[];

  if (! Array.isArray(docs) || docs.length === 0) {
    res.status(400).json({ error: 'body must be a non-empty array' });

    return;
  }

  try {
    const result = await db.collection(table).insertMany(docs, { ordered: false });

    counter(result.insertedCount);
    res.json({ inserted: result.insertedCount });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const inserted = (err as { result?: { insertedCount?: number } }).result?.insertedCount ?? 0;

      counter(inserted);

      if (config.ignoreDuplicates) {
        res.json({ inserted, duplicates: true });

        return;
      }

      res.status(409).json({ inserted, error: 'duplicate key' });

      return;
    }

    logger.error({ err }, 'Librarian insert failed');
    res.status(500).json({ error: (err as Error).message ?? 'internal error' });
  }
};
