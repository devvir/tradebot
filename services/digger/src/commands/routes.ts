import express, { Router } from 'express';
import type { MongoClient } from 'mongodb';
import type { Broker } from '@devvir/service-kit';
import { subscribe, unsubscribe, resubscribe } from './subscribe';
import { setClock } from './setClock';
import type { Config, State } from '../types';

/**
 * HTTP control API mounted at `/`.
 *
 *   POST /set-clock?timestamp=<ISO|epoch>   set or change the replay clock
 *   POST /subscribe/:table                  start replaying a table from the clock
 *   POST /unsubscribe/:table                stop replaying a table
 *   POST /resubscribe/:table                refresh a table (no clock change)
 *
 * The clock is session-level and must be set (via this endpoint or the
 * DIGGER_START_TIME env var) before the first subscribe. See setClock.ts for
 * the full rationale.
 */

export const buildCommandRouter = (
  state:  State,
  config: Config,
  mongo:  MongoClient,
  broker: Broker,
): Router => {
  const router = express.Router();

  router.post('/set-clock', async (req, res) => {
    const ts = parseTimestamp(req.query.timestamp);

    if (ts === null) {
      res.status(400).json({ error: '`timestamp` query param is required (ISO-8601 or epoch ms)' });
      return;
    }

    try {
      await setClock(ts, state, config, mongo, broker);
      res.status(201).end();
    } catch (err) {
      sendError(err, res);
    }
  });

  router.post('/subscribe/:table', async (req, res) => {
    try {
      await subscribe(req.params.table, state, config, mongo, broker);
      res.status(201).end();
    } catch (err) {
      sendError(err, res);
    }
  });

  router.post('/unsubscribe/:table', (req, res) => {
    unsubscribe(req.params.table, state);
    res.status(200).end();
  });

  router.post('/resubscribe/:table', async (req, res) => {
    try {
      await resubscribe(req.params.table, state, config, mongo, broker);
      res.status(201).end();
    } catch (err) {
      sendError(err, res);
    }
  });

  return router;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const parseTimestamp = (raw: unknown): number | null => {
  if (raw === undefined || raw === null || raw === '') return null;

  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;

  if (typeof raw === 'string') {
    const asNumber = Number(raw);

    if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;

    const ms = Date.parse(raw);

    return Number.isFinite(ms) ? ms : null;
  }

  return null;
};

const sendError = (err: unknown, res: express.Response): void => {
  const status  = (err as { httpStatus?: number }).httpStatus ?? 400;
  const message = err instanceof Error ? err.message : 'Unknown error';

  res.status(status).json({ error: message });
};
