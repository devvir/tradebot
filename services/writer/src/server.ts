/**
 * HTTP server: single endpoint that takes a JSON array of docs and bulk-
 * inserts them into mongo. Callers are responsible for batch sizing — the
 * writer is intentionally dumb so its throughput stays a clean comparison
 * point against the original prototype.
 *
 * Safety only at the edges:
 *   - 32 MB body cap (413 if exceeded)
 *   - 400 if body is not a non-empty array
 *   - duplicate-key (E11000) is reported as success when
 *     `config.ignoreDuplicates` is set; otherwise it falls through to 500
 *   - any other mongo failure surfaces as 500 with the error message
 *
 * Throughput is logged every 5s by `startServer`. `createApp` is exposed
 * separately so tests can exercise the surface with supertest, no port.
 */

import http from 'node:http';
import express, { type Request, type Response, type NextFunction, type Application } from 'express';
import { logger } from '@devvir/service-kit';
import type { Db, Document } from 'mongodb';
import type { Config } from './types';

const HTTP_PORT     = 80;
const BODY_LIMIT_MB = 32;
const METRICS_MS    = 5_000;

/** Callback fired by every successful insert. Used by `startServer` to drive metrics; tests can pass their own. */
export type InsertCounter = (n: number) => void;

const noopCounter: InsertCounter = () => {};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the express app. Exposed separately from `startServer` so tests can
 * exercise the HTTP surface (supertest) without binding a port.
 */
export const createApp = (db: Db, config: Config, counter: InsertCounter = noopCounter): Application => {
  const app = express();

  app.use(express.json({ limit: `${BODY_LIMIT_MB}mb` }));

  app.post('/write/:table', async (req: Request, res: Response, next: NextFunction) => {
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
      /** Duplicate-key is the caller's fault, not the server's, so report it
       *  as a 4xx — either 200 (success) when the caller has opted into
       *  idempotent retries via `ignoreDuplicates`, or 409 (Conflict) when
       *  they want to know about the conflict.
       *
       *  Farmer assigns deterministic `_id`s and retries forever, so it runs
       *  with `ignoreDuplicates=true` to short-circuit the retry-after-
       *  partial-success loop. Other callers may rely on `_id` collisions
       *  to surface real bugs and should set the flag to `false`. */
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

      next(err);
    }
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if ((err as { type?: string }).type === 'entity.too.large') {
      res.status(413).json({ error: 'request body too large' });
      return;
    }

    logger.error({ err }, 'Writer request failed');
    res.status(500).json({ error: (err as Error).message ?? 'internal error' });
  });

  return app;
};

export const startServer = (db: Db, config: Config): http.Server => {
  let totalInserted   = 0;
  let lastReportAt    = Date.now();
  let lastReportCount = 0;

  const counter: InsertCounter = (n) => {
    totalInserted += n;
  };

  const reportTimer = setInterval(() => {
    const now     = Date.now();
    const elapsed = (now - lastReportAt) / 1000;
    const delta   = totalInserted - lastReportCount;

    logger.info(
      { totalInserted, delta, rate: Math.round(delta / elapsed) },
      'Writer metrics',
    );

    lastReportAt    = now;
    lastReportCount = totalInserted;
  }, METRICS_MS);

  reportTimer.unref();

  const app    = createApp(db, config, counter);
  const server = http.createServer(app);

  server.listen(HTTP_PORT, () => {
    logger.info({ port: HTTP_PORT }, 'Writer HTTP server listening');
  });

  server.on('close', () => clearInterval(reportTimer));

  return server;
};
