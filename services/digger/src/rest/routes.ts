import express, { Router, type Response } from 'express';
import type { MongoClient } from 'mongodb';
import { parseRestParams } from './params';
import { queryRecords, querySnapshot } from './query';
import type { BitmexTable, Config } from '../types';

/**
 * BitMEX-compatible REST API mounted at `/api/v1`.
 *
 * REST-origin tables answer with a MongoDB timestamp range query.
 * WS-origin tables answer with the current in-memory snapshot (the replay
 * clock guarantees it reflects the request time).
 *
 * Standard query params: symbol, count (≤500), start, reverse, startTime,
 * endTime, columns. When a missing time bound is needed, the replay clock
 * stands in for "now".
 */

export const buildRestRouter = (config: Config, mongo: MongoClient): Router => {
  const router = express.Router();

  // REST-origin tables ────────────────────────────────────────────────────────
  records(router, '/trade',       'trade',       config, mongo);
  records(router, '/quote',       'quote',       config, mongo);
  records(router, '/funding',     'funding',     config, mongo);
  records(router, '/settlement',  'settlement',  config, mongo);
  records(router, '/insurance',   'insurance',   config, mongo);

  bucketed(router, '/trade/bucketed', 'trade', config, mongo);
  bucketed(router, '/quote/bucketed', 'quote', config, mongo);

  // WS-origin tables ──────────────────────────────────────────────────────────
  snapshot(router, '/instrument',          'instrument');
  snapshot(router, '/orderBook/L2',        'orderBookL2');
  snapshot(router, '/liquidation',         'liquidation');
  snapshot(router, '/announcement',        'announcement');
  snapshot(router, '/chat',                'chat');
  snapshot(router, '/publicNotifications', 'publicNotifications');

  return router;
};

// ── Route builders ────────────────────────────────────────────────────────────

const records = (
  router: Router,
  path:   string,
  table:  BitmexTable,
  config: Config,
  mongo:  MongoClient,
): void => {
  router.get(path, async (req, res) => {
    try {
      const params = parseRestParams(req.query as Record<string, unknown>);
      const data   = await queryRecords(table, params, config, mongo);

      res.json(data);
    } catch (err) {
      sendError(err, res);
    }
  });
};

/**
 * `/trade/bucketed?binSize=1m` → tradeBin1m. binSize defaults to 1m and is
 * validated against the supported bucket sizes.
 */
const bucketed = (
  router: Router,
  path:   string,
  prefix: 'trade' | 'quote',
  config: Config,
  mongo:  MongoClient,
): void => {
  router.get(path, async (req, res) => {
    try {
      const table  = bucketedTable(prefix, req.query.binSize);
      const params = parseRestParams(req.query as Record<string, unknown>);
      const data   = await queryRecords(table, params, config, mongo);

      res.json(data);
    } catch (err) {
      sendError(err, res);
    }
  });
};

const snapshot = (router: Router, path: string, table: BitmexTable): void => {
  router.get(path, (req, res) => {
    try {
      const params = parseRestParams(req.query as Record<string, unknown>);
      const data   = querySnapshot(table, params);

      res.json(data);
    } catch (err) {
      sendError(err, res);
    }
  });
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_BIN_SIZES = ['1m', '5m', '1h', '1d'] as const;

type BinSize = typeof VALID_BIN_SIZES[number];

const bucketedTable = (prefix: 'trade' | 'quote', raw: unknown): BitmexTable => {
  const binSize = (typeof raw === 'string' ? raw : '1m') as BinSize;

  if (! VALID_BIN_SIZES.includes(binSize)) {
    throw httpError(400, `Invalid binSize: ${raw}. Use one of ${VALID_BIN_SIZES.join(', ')}`);
  }

  return `${prefix}Bin${binSize}` as BitmexTable;
};

const sendError = (err: unknown, res: Response): void => {
  const status  = (err as { httpStatus?: number }).httpStatus ?? 500;
  const message = err instanceof Error ? err.message : 'Unknown error';

  res.status(status).json({ error: message });
};

const httpError = (status: number, message: string): Error =>
  Object.assign(new Error(message), { httpStatus: status });
