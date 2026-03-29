import { type Application, type Request, type Response } from 'express';
import { logger } from '@devvir/service-kit';
import type { Readable } from 'stream';
import * as storage from './storage';
import * as health from './health';
import type { Row, WsMessage } from './types';

export const registerRoutes = (app: Application): void => {

  // ── POST /files/:table/:date/rows — enqueue rows or a WS message ──────────
  //
  // Accepts two payload shapes:
  //
  //   Items   — a JSON object or array of objects without an `action` field.
  //             Each object is stored as a plain row (REST tables, scribe).
  //
  //   Messages — a JSON object or array of objects that each have an `action`
  //             field and a `data` array (BitMEX WS messages, journalist).
  //             Vault augments the first row of each message with two metadata
  //             columns: `_date_` (message.date ?? wall-clock now) and
  //             `_action_` (message.action), then stores all rows from `data`.
  //             If `data` is missing or not an array, vault returns 400.
  //
  // Returns 202 immediately (buffered async write).
  // Returns 503 if the storage failure rate has exceeded the health threshold.

  app.post('/files/:table/:date/rows', (req: Request, res: Response) => {
    if (! health.isHealthy()) {
      res.status(503).json({ error: `Storage unhealthy: ${health.getFailureReason()}` });
      return;
    }

    const table = req.params['table'] as string;
    const date  = req.params['date']  as string;

    if (storage.isClosing(table, date)) {
      res.status(409).json({ error: 'File is being closed' });
      return;
    }

    if (storage.isClosed(table, date)) {
      res.status(418).json({ error: 'File is already closed' });
      return;
    }

    const body  = req.body as unknown;
    const items = Array.isArray(body) ? body : [body];

    if (
      ! items.length ||
      ! items.every(i => i !== null && typeof i === 'object' && ! Array.isArray(i))
    ) {
      res.status(400).json({ error: 'Body must be a JSON object or array of objects' });
      return;
    }

    for (const item of items as Row[]) {
      if ('action' in item) {
        // WS message — { action, date?, data: Row[] }
        if (! Array.isArray(item['data'])) {
          res.status(400).json({ error: 'Message must include a data array' });
          return;
        }

        const msg  = item as unknown as WsMessage;
        const rows = msg.data;

        rows[0] = {
          ...(rows[0] ?? {}),
          _date_:   msg.date ?? new Date().toISOString(),
          _action_: msg.action,
        };

        storage.insertRows(table, date, rows);
      } else {
        // REST item — plain row, store as-is
        storage.insertRow(table, date, item);
      }
    }

    res.status(202).end();
  });

  // ── PUT /files/:table/:date — store a complete binary file ─────────────────

  app.put('/files/:table/:date', (req: Request, res: Response) => {
    const table = req.params['table'] as string;
    const date  = req.params['date']  as string;

    if (storage.fileExists(table, date)) {
      req.resume();
      res.status(409).json({ error: 'File already exists' });
      return;
    }

    storage.storeFile(table, date, req as unknown as Readable)
      .then(() => res.status(204).end())
      .catch((err: unknown) => {
        logger.error({ err, table, date }, 'store failed');
        res.status(500).json({ error: 'Store failed' });
      });
  });

  // ── POST /files/:table/:date/close — gzip and seal an open file ────────────
  //
  // Returns 202 immediately — the gzip runs in the background so the caller
  // is never blocked for the duration of the compression.

  app.post('/files/:table/:date/close', (req: Request, res: Response) => {
    const table = req.params['table'] as string;
    const date  = req.params['date']  as string;

    if (storage.isClosed(table, date)) {
      res.status(204).end();
      return;
    }

    if (storage.isClosing(table, date)) {
      res.status(202).end();
      return;
    }

    if (! storage.fileExists(table, date)) {
      res.status(404).json({ error: `No open file for ${table}/${date}` });
      return;
    }

    storage.closeFile(table, date).catch((err) => {
      if (! (err instanceof storage.NotFoundError))
        logger.error({ err, table, date }, 'Background close failed');
    });

    res.status(202).end();
  });

  // ── DELETE /files/:table/:date — drop an open file ─────────────────────────

  app.delete('/files/:table/:date', async (req: Request, res: Response) => {
    const table = req.params['table'] as string;
    const date  = req.params['date']  as string;

    try {
      await storage.dropFile(table, date);
      res.status(204).end();
    } catch (err) {
      if (err instanceof storage.NotFoundError) {
        res.status(404).json({ error: (err as Error).message });
        return;
      }

      logger.error({ err, table, date }, 'drop failed');
      res.status(500).json({ error: 'Drop failed' });
    }
  });

  // ── GET /files/:table/:date/headers — return column names ──────────────────

  app.get('/files/:table/:date/headers', async (req: Request, res: Response) => {
    const table = req.params['table'] as string;
    const date  = req.params['date']  as string;

    try {
      const columns = await storage.readHeaders(table, date);
      res.json({ columns });
    } catch (err) {
      if (err instanceof storage.NotFoundError) {
        res.status(404).json({ error: (err as Error).message });
        return;
      }

      logger.error({ err, table, date }, 'readHeaders failed');
      res.status(500).json({ error: 'Failed to read headers' });
    }
  });

  // ── GET /files/:table/:date — stream rows as NDJSON ───────────────────────
  //
  // Each line is a JSON object with field types restored from the casts map.
  // Empty fields (absent in the original message) are omitted.

  app.get('/files/:table/:date', (req: Request, res: Response) => {
    const table = req.params['table'] as string;
    const date  = req.params['date']  as string;

    try {
      const stream = storage.streamRows(table, date);

      res.setHeader('Content-Type', 'application/x-ndjson');

      stream.pipe(res);

      stream.on('error', (err) => {
        logger.error({ err, table, date }, 'read stream error');
        res.destroy();
      });
    } catch (err) {
      if (err instanceof storage.NotFoundError) {
        res.status(404).json({ error: (err as Error).message });
        return;
      }

      logger.error({ err, table, date }, 'read failed');
      res.status(500).json({ error: 'Read failed' });
    }
  });

  // ── GET /tables — list all tables that have data in vault ──────────────────

  app.get('/tables', (_req: Request, res: Response) => {
    res.json(storage.listTables());
  });

  // ── GET /files/:table — list files with open/closed state ──────────────────

  app.get('/files/:table', (req: Request, res: Response) => {
    const table = req.params['table'] as string;

    res.json(storage.listFiles(table));
  });
};
