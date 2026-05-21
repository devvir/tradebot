/**
 * Writer HTTP surface: a single endpoint that bulk-inserts a JSON array of docs
 * into mongo. Callers size their own batches — the writer is deliberately dumb
 * so its throughput stays a clean comparison point against the prototype.
 *
 * Safety only at the edges:
 *   - 32 MB body cap (the express server kind's `json` limit → 413)
 *   - 400 if the body is not a non-empty array
 *   - duplicate-key (E11000) → success when `ignoreDuplicates` is set, else 409
 *   - any other mongo failure → 500 with the error message
 */

import { logger } from '@devvir/service-kit';
import { Router } from 'express';
import type { Db, Document } from 'mongodb';
import type { Config } from './types';

const METRICS_MS = 5_000;

/** Callback fired by every successful insert — feeds the throughput metrics. */
export type InsertCounter = (n: number) => void;

// ── Routes ────────────────────────────────────────────────────────────────────

/** Build the writer's route table. Body parsing is the express server kind's job. */
export const buildRouter = (db: Db, config: Config, counter: InsertCounter): Router => {
  const router = Router();

  router.post('/write/:table', async (req, res) => {
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
      /** Duplicate-key is the caller's fault, not the server's: report success
       *  (idempotent re-runs) or 409, per `ignoreDuplicates`. Farmer assigns
       *  deterministic `_id`s and retries forever, so it runs with the flag on. */
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

      logger.error({ err }, 'Writer insert failed');
      res.status(500).json({ error: (err as Error).message ?? 'internal error' });
    }
  });

  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  return router;
};

// ── Metrics ───────────────────────────────────────────────────────────────────

/**
 * Start the throughput metrics loop — logs inserted/s every 5s. Returns the
 * counter the routes feed, and a `stop` to clear the loop on shutdown.
 */
export const startMetrics = (): { counter: InsertCounter; stop: () => void } => {
  let total     = 0;
  let lastAt    = Date.now();
  let lastCount = 0;

  const counter: InsertCounter = (n) => { total += n; };

  const timer = setInterval(() => {
    const now     = Date.now();
    const elapsed = (now - lastAt) / 1000;
    const delta   = total - lastCount;

    logger.info({ totalInserted: total, delta, rate: Math.round(delta / elapsed) }, 'Writer metrics');

    lastAt    = now;
    lastCount = total;
  }, METRICS_MS);

  timer.unref();

  return { counter, stop: () => clearInterval(timer) };
};
