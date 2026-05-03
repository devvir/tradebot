// Route definitions — one handler per endpoint.
//
// Responsible for: parsing path params and request bodies, calling the
// appropriate module (fs/, data/), and returning the correct HTTP status code.
// No business logic, no file ops, no data transformation — thin by design.
//
// Date and suffix only exist at the boundary. Every endpoint accepts a `:date`
// path param and an optional `?suffix=` query param. The handler immediately
// composes them into a single `filename` (`<date>` or `<date>.<suffix>`) which
// is the only identifier the rest of vault sees. Without `?suffix=`, the
// filename is just the date — the on-disk path and behaviour match what
// existed before suffixes were introduced.

import { type Application, type Request, type Response } from 'express';
import { Readable } from 'stream';
import { logger } from '@devvir/service-kit';
import { streamRecords, listFiles, listTables, fileState } from '../fs/reader';
import { storeFile, deleteFile } from '../fs/writer';
import { isHealthy, getFailureReason } from '../fs/health';
import { decodeFile } from '../data/decode';
import { encode } from '../data/encode';
import { buffers } from '../data/buffers';
import { closeBucket } from '../data/close';
import { NotFoundError } from '../fs/errors';
import type { Row, WsMessage } from '../data/types';

// Append-only set of `table/filename` buckets the client has asked to seal.
// Once added, all further row writes for that bucket are rejected. Never
// cleaned up — after the rename, fileState='closed' would also produce a 409,
// so the set is just an immediate barrier while the close completes.
const closing = new Set<string>();

/** Reads optional `?suffix=` and returns `<date>` or `<date>.<suffix>`. */
const filenameOf = (req: Request): string => {
  const date   = req.params['date'] as string;
  const suffix = typeof req.query['suffix'] === 'string' ? req.query['suffix'] : '';

  return suffix ? `${date}.${suffix}` : date;
};

export const registerRoutes = (app: Application): void => {

  // ── POST /files/:table/:date/rows — buffer rows or a WS message ──────────────

  app.post('/files/:table/:date/rows', (req: Request, res: Response) => {
    if (! isHealthy()) {
      res.status(503).json({ error: `Storage unhealthy: ${getFailureReason()}` });
      return;
    }

    const table    = req.params['table'] as string;
    const filename = filenameOf(req);
    const key      = `${table}/${filename}`;

    if (closing.has(key) || fileState(table, filename) === 'closed') {
      res.status(409).json({ error: 'File is closed' });
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

    // Validate WS messages have a data array up-front so a malformed message
    // does not result in partial buffering before we error.
    for (const item of items as (Row | WsMessage)[]) {
      if ('action' in item && ! Array.isArray((item as WsMessage).data)) {
        res.status(400).json({ error: 'Message must include a data array' });
        return;
      }
    }

    const buf = buffers.get(table, filename);

    try {
      for (const item of items as (Row | WsMessage)[]) {
        buf.pushMany(encode(table, item));
      }
    } catch (err) {
      logger.error({ err, table, filename }, 'Encode failed');
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    res.status(202).end();
  });

  // ── POST /files/:table/:date/close — seal an open file ──────────────────────
  //
  // Fire-and-forget: returns 202 immediately. The seal happens at the tail of
  // the file's write chain so any in-flight appends complete first.

  app.post('/files/:table/:date/close', (req: Request, res: Response) => {
    const table    = req.params['table'] as string;
    const filename = filenameOf(req);
    const key      = `${table}/${filename}`;

    closing.add(key);

    closeBucket(table, filename)
      .then(() => closing.delete(key))
      .catch((err) => {
        logger.error({ err, table, filename }, 'closeBucket failed');
      });

    res.status(202).end();
  });

  // ── GET /files/:table/:date — stream rows as NDJSON ──────────────────────────

  app.get('/files/:table/:date', (req: Request, res: Response) => {
    const table    = req.params['table'] as string;
    const filename = filenameOf(req);
    const skipRaw  = Number(req.query['skip']);
    const skip     = Number.isFinite(skipRaw) && skipRaw > 0 ? Math.floor(skipRaw) : 0;

    const stream = Readable.from(decodeFile(table, filename, skip));

    // When the client drops the connection, destroy the source so the generator's
    // finally block runs and the underlying file handle is released.
    res.on('close', () => stream.destroy());

    stream.on('error', (err) => {
      if (err instanceof NotFoundError) {
        if (! res.headersSent) res.status(404).json({ error: err.message });
      } else {
        logger.error({ err, table, filename }, 'Read stream error');
        if (! res.headersSent) res.status(500).json({ error: 'Read failed' });
        else res.destroy();
      }
    });

    res.setHeader('Content-Type', 'application/x-ndjson');

    if (skip > 0) res.flushHeaders();

    stream.pipe(res);
  });

  // ── PUT /files/:table/:date — store a complete gzip file (courier) ───────────
  //
  // All-or-nothing: streams directly to .csv.gz.tmp, then renames to .csv.gz.
  // If an open (.csv.gz.tmp) file exists from a prior interrupted upload, it is
  // discarded and overwritten — partial files are garbage. A sealed (.csv.gz)
  // file is permanent and returns 409.

  app.put('/files/:table/:date', async (req: Request, res: Response) => {
    const table    = req.params['table'] as string;
    const filename = filenameOf(req);
    const state    = fileState(table, filename);

    if (state === 'closed') {
      req.resume();
      res.status(409).json({ error: 'File already exists' });
      return;
    }

    if (state === 'open') {
      buffers.get(table, filename).flush();
      deleteFile(table, filename);
    }

    try {
      await storeFile(table, filename, req as unknown as Readable);
      res.status(204).end();
    } catch (err) {
      logger.error({ err, table, filename }, 'Store failed');
      if (! res.headersSent) res.status(500).json({ error: 'Store failed' });
    }
  });

  // ── DELETE /files/:table/:date — discard an open file ────────────────────────

  app.delete('/files/:table/:date', (req: Request, res: Response) => {
    const table    = req.params['table'] as string;
    const filename = filenameOf(req);

    buffers.get(table, filename).flush();
    deleteFile(table, filename);

    res.status(204).end();
  });

  // ── GET /files/:table/:date/headers — return column names ────────────────────

  app.get('/files/:table/:date/headers', async (req: Request, res: Response) => {
    const table    = req.params['table'] as string;
    const filename = filenameOf(req);

    try {
      const records = streamRecords(table, filename);
      const first   = await records.next();
      await records.return?.(undefined);

      if (first.done) {
        res.status(404).json({ error: `No file for ${table}/${filename}` });
        return;
      }

      res.json({ columns: first.value });
    } catch (err) {
      if (err instanceof NotFoundError) {
        res.status(404).json({ error: (err as Error).message });
        return;
      }

      logger.error({ err, table, filename }, 'readHeaders failed');
      res.status(500).json({ error: 'Failed to read headers' });
    }
  });

  // ── GET /files/:table — list files with open/closed state ────────────────────
  //
  // Optional `?suffix=<value>`: filters to files tagged with that suffix.
  // Omitting it (or sending an empty value) returns only bare-date files.

  app.get('/files/:table', (req: Request, res: Response) => {
    const table  = req.params['table'] as string;
    const suffix = typeof req.query['suffix'] === 'string' && req.query['suffix']
      ? req.query['suffix']
      : undefined;

    const result = listFiles(table, suffix);

    if (result === null) {
      res.status(404).json({ error: `No data for table '${table}'` });
      return;
    }

    res.json(result);
  });

  // ── GET /tables — list all tables that have data in vault ────────────────────

  app.get('/tables', (_req: Request, res: Response) => {
    res.json(listTables());
  });
};

// ── Test helpers ──────────────────────────────────────────────────────────────

export const _test_resetClosing = (): void => { closing.clear(); };
