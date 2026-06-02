/**
 * Provider HTTP surface — routes only. Transforms and librarian calls live in
 * `ws/` and `rest/`; this file is the readable surface.
 *
 *   GET /ws/:table/partial?before=<ms>       partial to apply + start cursor
 *   GET /ws/:table?after=<cursor>&limit=<n>  next page of wire messages
 *   GET /rest/:table?<bitmex params>         time-series records (flat tables)
 *   GET /health
 *
 * Stateless and clock-agnostic: digger passes absolute times (with "now" already
 * resolved) and opaque cursors; the provider owns the `_id` encoding.
 */

import { Router } from 'express';
import type { Response } from 'express';
import type { BitmexTable } from '@tradebot/types';
import { isKnown, isRestServed } from './catalog';
import { partialBefore, streamAfter } from './ws';
import { restRecords } from './rest';
import type { Librarian } from './librarian';
import type { RestParams } from './types';

const DEFAULT_LIMIT      = 1_000;
const MAX_LIMIT          = 10_000;
const REST_DEFAULT_COUNT = 100;
const REST_MAX_COUNT     = 500;

export const buildRouter = (lib: Librarian): Router => {
  const router = Router();

  /** `/health` first so the generic routes don't shadow it. */
  router.get('/health', (_req, res) => { res.json({ ok: true }); });

  router.get('/ws/:table/partial', async (req, res) => {
    const table = String(req.params.table);

    if (! isKnown(table)) return notFound(res, `unknown table: ${table}`);

    const before = num(req.query.before);

    if (before === undefined) return badRequest(res, 'before (epoch ms) is required');

    try {
      res.json(await partialBefore(lib, table as BitmexTable, before));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/ws/:table', async (req, res) => {
    const table = String(req.params.table);

    if (! isKnown(table)) return notFound(res, `unknown table: ${table}`);

    const after = num(req.query.after);

    if (after === undefined) return badRequest(res, 'after (cursor) is required');

    const limit = Math.min(num(req.query.limit) ?? DEFAULT_LIMIT, MAX_LIMIT);

    try {
      res.json(await streamAfter(lib, table as BitmexTable, after, limit));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/rest/:table', async (req, res) => {
    const table = String(req.params.table);

    if (! isRestServed(table)) return notFound(res, `table not served on rest: ${table}`);

    try {
      res.json(await restRecords(lib, table as BitmexTable, parseRest(req.query)));
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const num = (raw: unknown): number | undefined => {
  if (raw === undefined || raw === null || raw === '') return undefined;

  const n = Number(raw);

  return Number.isFinite(n) ? n : undefined;
};

const parseRest = (q: Record<string, unknown>): RestParams => ({
  symbol:    typeof q.symbol === 'string' && q.symbol.length > 0 ? q.symbol : undefined,
  count:     Math.min(num(q.count) ?? REST_DEFAULT_COUNT, REST_MAX_COUNT),
  start:     num(q.start) ?? 0,
  reverse:   q.reverse === 'true' || q.reverse === true,
  startTime: num(q.startTime),
  endTime:   num(q.endTime),
  columns:   typeof q.columns === 'string' && q.columns.length > 0
    ? q.columns.split(',').map(s => s.trim()).filter(Boolean)
    : undefined,
  depth:     num(q.depth),
});

const notFound   = (res: Response, error: string): void => { res.status(404).json({ error }); };
const badRequest = (res: Response, error: string): void => { res.status(400).json({ error }); };

const fail = (res: Response, err: unknown): void => {
  res.status(500).json({ error: err instanceof Error ? err.message : 'internal error' });
};
