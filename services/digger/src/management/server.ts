import { Router } from 'express';
import type { Request, Response } from 'express';
import * as clock from '../core/clock';
import { setClock } from './seek';
import type { Reader } from '../reader';
import type { WsRuntime } from '../ws';

/**
 * The control surface — non-BitMEX. `set-clock` seeks the replay; `clock` exposes
 * the current replay time (the hook a future private-data service polls).
 */
export const buildControlRouter = (ws: WsRuntime, reader: Reader): Router => {
  const router = Router();

  router.post('/set-clock', async (req: Request, res: Response) => {
    const ms = parseTimestamp(req.query.timestamp);

    if (ms === null) {
      res.status(400).json({ error: 'timestamp (ISO-8601 or epoch ms) required' });

      return;
    }

    try {
      await setClock(ms, ws, reader);

      res.status(201).json({ clock: ms });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'internal error' });
    }
  });

  router.get('/clock', (_req: Request, res: Response) => {
    res.json({ clock: clock.fetch() });
  });

  return router;
};

// ── Internal ──────────────────────────────────────────────────────────────────

const parseTimestamp = (raw: unknown): number | null => {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  const n = Number(raw);

  if (Number.isFinite(n) && n > 0) return n;

  const ms = Date.parse(raw);

  return Number.isFinite(ms) ? ms : null;
};
