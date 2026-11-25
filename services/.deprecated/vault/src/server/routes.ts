// Route definitions — one handler per endpoint.
//
// Responsible for: validating path params and query strings, parsing request
// bodies, calling the appropriate module (fs/, data/), and returning the
// correct HTTP status code. No writes to disk, no data transformation.
//
// Date and suffix only exist at the boundary. Every endpoint with a `:date`
// path param also takes an optional `?suffix=` query param; `parseKey`
// validates both, with `:table`, and composes a single `filename` (`<date>` or
// `<date>.<suffix>`), which is the only identifier the rest of vault sees.
// Anything that fails validation is answered 400 before it reaches a path.

import { type Application, type Request, type Response } from 'express';
import { Readable } from 'stream';
import { stat } from 'fs/promises';
import type { Stats } from 'fs';
import { logger } from '@devvir/service-kit';
import { baseTable, WS_TABLES } from '../data/tables';
import { listFiles, listTables, fileState } from '../fs/reader';
import { isHealthy, getFailureReason, isThrottled } from '../fs/health';
import { decodeFile } from '../data/decode';
import { batchLines } from './batch';
import { createParser } from '../data/parse';
import { encode } from '../data/encode';
import { buffers } from '../data/buffers';
import { closeBucket } from '../data/close';
import { acceptsRows, bucketState, discardBucket, uploadBucket, BucketBusyError } from '../data/bucket';
import { headersFor } from '../data/headers';
import { isShuttingDown } from '../shutdown';
import { NotFoundError, AlreadyExistsError, InvalidUploadError } from '../fs/errors';
import { closedPath, openPath } from '../fs/paths';
import type { Row, WsMessage } from '../data/types';

// An upload that sends nothing for this long is cut off. A moving upload is
// never cut, however long it takes, and neither is the work after its body
// has arrived.
const UPLOAD_IDLE_TIMEOUT_MS = 90_000;

// GET /files streams NDJSON in chunks of at least this many characters.
const READ_CHUNK_CHARS = 64 * 1024;

// A table name, optionally with one dotted pseudo-table part (`quote.secondary`).
const TABLE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)?$/;
const DATE       = /^\d{8}$/;
const SUFFIX     = /^[A-Za-z0-9_-]{1,32}$/;
const ISO_DATE   = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const WS_ACTIONS: ReadonlySet<string> = new Set(['partial', 'insert', 'update', 'delete']);

interface Key {
  table:    string;
  filename: string;
}

/** Answers 503 and returns true once shutdown has started. */
const refuseWhenShuttingDown = (res: Response): boolean => {
  if (! isShuttingDown()) return false;

  res.status(503).json({ error: 'Vault is shutting down' });

  return true;
};

/** Answers 400 with `error`, discarding any unread request body. */
const badRequest = (req: Request, res: Response, error: string): null => {
  req.resume();
  res.status(400).json({ error });

  return null;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && ! Array.isArray(v);

/**
 * Checks one POST /rows body item against the table's kind. A WS-table item
 * must be a message: `action` one of WS_ACTIONS, `data` an array of objects,
 * and `date`, when present, an ISO 8601 UTC timestamp. A REST-table item is a
 * plain row and carries neither `action` nor `data`. Returns the reason an item
 * is refused, or null.
 */
const itemError = (table: string, item: Record<string, unknown>): string | null => {
  if (! WS_TABLES.has(baseTable(table))) {
    if ('action' in item || 'data' in item)
      return `Table '${table}' takes plain rows: 'action' and 'data' belong to WS messages`;

    return null;
  }

  if (typeof item['action'] !== 'string' || ! WS_ACTIONS.has(item['action']))
    return `Message action must be one of ${[...WS_ACTIONS].join(', ')}`;

  const data = item['data'];

  if (! Array.isArray(data) || ! data.every(isPlainObject))
    return 'Message must include a data array of objects';

  if ('date' in item && (typeof item['date'] !== 'string' || ! ISO_DATE.test(item['date'])))
    return 'Message date must be an ISO 8601 UTC timestamp (YYYY-MM-DDTHH:MM:SS[.sss]Z)';

  return null;
};

/** `YYYYMMDD` naming a real calendar day. */
const isCalendarDate = (date: string): boolean => {
  if (! DATE.test(date)) return false;

  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(4, 6)) - 1;
  const d = Number(date.slice(6, 8));
  const t = new Date(Date.UTC(y, m, d));

  return t.getUTCFullYear() === y && t.getUTCMonth() === m && t.getUTCDate() === d;
};

/**
 * Validates `:table`. With `known`, the table (or the real table behind a
 * pseudo-table) must also have a header definition. Answers 400 and returns
 * null when invalid.
 */
const parseTable = (req: Request, res: Response, known: boolean): string | null => {
  const table = req.params['table'] as string;

  if (! TABLE_NAME.test(table)) return badRequest(req, res, `Invalid table name '${table}'`);
  if (known && ! headersFor(table)) return badRequest(req, res, `Unknown table '${table}'`);

  return table;
};

/**
 * Reads optional `?suffix=`: '' when absent or empty, the suffix when valid.
 * Answers 400 and returns null when invalid.
 */
const parseSuffix = (req: Request, res: Response): string | null => {
  const raw = req.query['suffix'];

  if (raw === undefined || raw === '') return '';

  if (typeof raw !== 'string' || ! SUFFIX.test(raw))
    return badRequest(req, res, 'Invalid suffix: expected 1-32 characters from A-Z, a-z, 0-9, _ and -');

  return raw;
};

/**
 * Validates `:table`, `:date` and `?suffix=` and returns the bucket key.
 * Answers 400 and returns null when any of them is invalid. `known` is as for
 * `parseTable`.
 */
const parseKey = (req: Request, res: Response, { known = false }: { known?: boolean } = {}): Key | null => {
  const table = parseTable(req, res, known);

  if (table === null) return null;

  const date = req.params['date'] as string;

  if (! isCalendarDate(date))
    return badRequest(req, res, `Invalid date '${date}': expected a calendar day as YYYYMMDD`);

  const suffix = parseSuffix(req, res);

  if (suffix === null) return null;

  return { table, filename: suffix ? `${date}.${suffix}` : date };
};

/**
 * Stats the bucket's closed or open file, or returns null when it has neither.
 * A seal renames the open file to the closed path; when that lands between the
 * state check and the stat, the state is checked once more.
 */
const statBucket = async (
  table:    string,
  filename: string,
): Promise<{ state: 'open' | 'closed'; st: Stats } | null> => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = fileState(table, filename);

    if (state === 'none') return null;

    try {
      const st = await stat(state === 'closed' ? closedPath(table, filename) : openPath(table, filename));

      return { state, st };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  return null;
};

export const registerRoutes = (app: Application): void => {

  // ── POST /files/:table/:date/rows — buffer rows or a WS message ──────────────
  //
  // The body is one item or an array of them: WS messages for WS tables, plain
  // rows for every other table (see `itemError`). The request is all-or-nothing:
  // any item that is refused or fails to encode answers 400 with nothing from
  // the request buffered.

  app.post('/files/:table/:date/rows', (req: Request, res: Response) => {
    if (refuseWhenShuttingDown(res)) return;

    const parsed = parseKey(req, res, { known: true });

    if (! parsed) return;

    if (! isHealthy()) {
      res.status(503).json({ error: `Storage unhealthy: ${getFailureReason()}` });
      return;
    }

    const { table, filename } = parsed;
    const key = `${table}/${filename}`;

    if (isThrottled(table, filename)) {
      res.status(429).json({ error: `Too many inflight writes for ${key}` });
      return;
    }

    if (! acceptsRows(table, filename)) {
      res.status(409).json({ error: `Bucket ${key} is ${bucketState(table, filename)}` });
      return;
    }

    if (fileState(table, filename) === 'closed') {
      res.status(409).json({ error: 'File is closed' });
      return;
    }

    const body  = req.body as unknown;
    const items = Array.isArray(body) ? body : [body];

    if (! items.length || ! items.every(isPlainObject)) {
      res.status(400).json({ error: 'Body must be a JSON object or array of objects' });
      return;
    }

    for (const item of items) {
      const error = itemError(table, item);

      if (error) {
        res.status(400).json({ error });
        return;
      }
    }

    // Every item is encoded before any is buffered, so a request answered 400
    // leaves nothing behind.
    let encoded: string[][];

    try {
      encoded = items.map(item => encode(table, item as Row | WsMessage));
    } catch (err) {
      logger.warn({ err, table, filename }, 'Encode failed');
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    const buf = buffers.get(table, filename);

    for (const lines of encoded) buf.pushMany(lines);

    res.status(202).end();
  });

  // ── POST /files/:table/:date/close — seal an open file ──────────────────────
  //
  // Fire-and-forget: returns 202 immediately. The seal happens at the tail of
  // the file's write chain so any in-flight appends complete first. Rows for
  // the bucket get 409 until the seal settles; after a failed seal the bucket
  // accepts rows again and can be closed again. 409 while the bucket is being
  // discarded or uploaded.

  app.post('/files/:table/:date/close', (req: Request, res: Response) => {
    if (refuseWhenShuttingDown(res)) return;

    const parsed = parseKey(req, res, { known: true });

    if (! parsed) return;

    const { table, filename } = parsed;
    const state = bucketState(table, filename);

    if (state === 'discarding' || state === 'uploading') {
      res.status(409).json({ error: `Bucket ${table}/${filename} is ${state}` });
      return;
    }

    closeBucket(table, filename).catch((err) => {
      logger.error({ err, table, filename }, 'closeBucket failed');
    });

    res.status(202).end();
  });

  // ── GET /files/:table/:date — stream rows as NDJSON ──────────────────────────
  //
  // Lines are written in chunks of whole lines (see READ_CHUNK_CHARS). A file
  // that fails to read answers 500, or, once part of the body is out, ends the
  // response incomplete.

  app.get('/files/:table/:date', (req: Request, res: Response) => {
    const parsed = parseKey(req, res);

    if (! parsed) return;

    const { table, filename } = parsed;
    const skipRaw = Number(req.query['skip']);
    const skip    = Number.isFinite(skipRaw) && skipRaw > 0 ? Math.floor(skipRaw) : 0;

    // Only closed files are readable. Checked up front because headers may be
    // sent before the file is opened; a closed file is never removed.
    if (fileState(table, filename) !== 'closed') {
      res.status(404).json({ error: `No closed file for ${table}/${filename}` });
      return;
    }

    const stream = Readable.from(batchLines(decodeFile(table, filename, skip), READ_CHUNK_CHARS));

    // When the client drops the connection, destroy the source so the generator's
    // finally block runs and the underlying file handle is released.
    res.on('close', () => stream.destroy());

    stream.on('error', (err) => {
      if (! (err instanceof NotFoundError)) logger.error({ err, table, filename }, 'Read stream error');

      // Once headers are out the status cannot change: cut the response so the
      // client sees it end incomplete.
      if (res.headersSent) {
        res.destroy();
        return;
      }

      if (err instanceof NotFoundError) res.status(404).json({ error: err.message });
      else res.status(500).json({ error: 'Read failed' });
    });

    res.setHeader('Content-Type', 'application/x-ndjson');

    if (skip > 0) res.flushHeaders();

    stream.pipe(res);
  });

  // ── PUT /files/:table/:date — store a complete gzip file ─────────────────────
  //
  // The body is stored as the closed file only once it has fully arrived and
  // decompresses as gzip (400 otherwise). Buffered rows and any open
  // (.csv.gz.tmp) file for the bucket are discarded first. A closed (.csv.gz)
  // file is permanent and returns 409, as does a bucket that is closing, being
  // discarded or already being uploaded. A 500 usually means nothing was
  // stored, but one from the final directory fsync follows publishing: the
  // closed file then exists and a retry gets 409.
  //
  // The idle timeout covers the body only. It is cleared once the body has
  // arrived, so the verify and fsyncs that follow, which send nothing on the
  // socket, are never cut however long they take.

  app.put('/files/:table/:date', async (req: Request, res: Response) => {
    if (refuseWhenShuttingDown(res)) {
      req.resume();
      return;
    }

    const parsed = parseKey(req, res);

    if (! parsed) return;

    req.setTimeout(UPLOAD_IDLE_TIMEOUT_MS, () => {
      req.destroy(new Error(`Upload idle for ${UPLOAD_IDLE_TIMEOUT_MS} ms`));
    });

    if (req.complete) req.setTimeout(0);
    else req.once('end', () => req.setTimeout(0));

    const { table, filename } = parsed;
    const state = bucketState(table, filename);

    if (state !== 'idle') {
      req.resume();
      res.status(409).json({ error: `Bucket ${table}/${filename} is ${state}` });
      return;
    }

    if (fileState(table, filename) === 'closed') {
      req.resume();
      res.status(409).json({ error: 'File already exists' });
      return;
    }

    try {
      await uploadBucket(table, filename, req as unknown as Readable);
      res.status(204).end();
    } catch (err) {
      if (res.headersSent) return;

      if (err instanceof InvalidUploadError) {
        res.status(400).json({ error: err.message });
      } else if (err instanceof AlreadyExistsError) {
        res.status(409).json({ error: 'File already exists' });
      } else if (err instanceof BucketBusyError) {
        req.resume();
        res.status(409).json({ error: err.message });
      } else {
        logger.error({ err, table, filename }, 'Store failed');
        res.status(500).json({ error: 'Store failed' });
      }
    }
  });

  // ── DELETE /files/:table/:date — discard an open file ────────────────────────
  //
  // Drops the bucket's buffered rows and open file, and answers once both are
  // gone. A closed file is never touched. 409 while the bucket is closing,
  // being discarded or being uploaded.

  app.delete('/files/:table/:date', async (req: Request, res: Response) => {
    if (refuseWhenShuttingDown(res)) return;

    const parsed = parseKey(req, res, { known: true });

    if (! parsed) return;

    const { table, filename } = parsed;
    const state = bucketState(table, filename);

    if (state !== 'idle') {
      res.status(409).json({ error: `Bucket ${table}/${filename} is ${state}` });
      return;
    }

    try {
      await discardBucket(table, filename);
      res.status(204).end();
    } catch (err) {
      if (err instanceof BucketBusyError) {
        res.status(409).json({ error: err.message });
        return;
      }

      logger.error({ err, table, filename }, 'Discard failed');
      res.status(500).json({ error: 'Discard failed' });
    }
  });

  // ── GET /files/:table/:date/headers — return column names ────────────────────

  app.get('/files/:table/:date/headers', async (req: Request, res: Response) => {
    const parsed = parseKey(req, res);

    if (! parsed) return;

    const { table, filename } = parsed;

    try {
      const records = createParser(table).read(filename);
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
    const table = parseTable(req, res, false);

    if (table === null) return;

    const suffix = parseSuffix(req, res);

    if (suffix === null) return;

    const result = listFiles(table, suffix || undefined);

    if (result === null) {
      res.status(404).json({ error: `No data for table '${table}'` });
      return;
    }

    res.json(result);
  });

  // ── GET /tables — list every table directory ─────────────────────────────────

  app.get('/tables', (_req: Request, res: Response) => {
    res.json(listTables());
  });

  // ── GET /stats/:table/:date — inode stats for one bucket file ────────────────
  //
  // Returns size, modification time, and creation time straight from the inode.
  // No streaming, no decoding — a single `stat()`. Returns 404 if no file (open
  // or closed) exists for the bucket. `state` says which file was statted.

  app.get('/stats/:table/:date', async (req: Request, res: Response) => {
    const parsed = parseKey(req, res);

    if (! parsed) return;

    const { table, filename } = parsed;

    try {
      const found = await statBucket(table, filename);

      if (! found) {
        res.status(404).json({ error: `No file for ${table}/${filename}` });
        return;
      }

      res.json({
        state:     found.state,
        size:      found.st.size,
        mtime:     found.st.mtimeMs,
        birthtime: found.st.birthtimeMs,
      });
    } catch (err) {
      logger.error({ err, table, filename }, 'stat failed');
      res.status(500).json({ error: 'Failed to stat file' });
    }
  });
};
