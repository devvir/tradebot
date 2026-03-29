import { existsSync, createReadStream, readdirSync, statSync } from 'fs';
import { createInterface } from 'node:readline';
import { Transform, type TransformCallback } from 'node:stream';
import { createGunzip } from 'zlib';
import type { Readable } from 'stream';
import path from 'path';
import { createCsvParser } from '@tradebot/utils';
import { TABLE_CASTS, GLOBAL_CASTS, type CastType } from '../casts';
import { DATA_DIR, tableDir, openPath, closedPath } from './paths';
import { NotFoundError } from './errors';
import { headers } from './queue';
import type { FileListing, DirEntry } from '../types';

// Builds the NDJSON Transform that groups WS rows into messages and emits
// REST rows as plain objects.
//
// WS tables have a `_date_` column. A non-empty `_date_` value marks the
// start of a new message; an empty value marks a continuation row within the
// current message. On flush, each group is emitted as:
//
//   { "action": "insert", "date": "2025-...", "data": [{...}, ...] }
//
// REST tables have no `_date_` column. Their rows are emitted as plain objects.
//
// Exported for unit testing only.
export const createGroupTransform = (tableCasts: Record<string, CastType>): Transform => {
  let group:       Record<string, unknown>[] = [];
  let groupDate:   string                    = '';
  let groupAction: string                    = '';

  const flushGroup = (t: Transform): void => {
    if (! groupDate) return;

    t.push(JSON.stringify({ action: groupAction, date: groupDate, data: group }) + '\n');

    group       = [];
    groupDate   = '';
    groupAction = '';
  };

  return new Transform({
    writableObjectMode: true,
    readableObjectMode: false,
    transform(row: Record<string, string>, _enc: BufferEncoding, cb: TransformCallback) {
      if (! ('_action_' in row)) {
        // REST table: no _action_ column — emit as a plain object
        cb(null, JSON.stringify(applyRow(row, tableCasts)) + '\n');
        return;
      }

      const rawDate   = row['_date_']!;
      const rawAction = row['_action_'] ?? '';

      // Strip metadata columns before casting the data fields
      const { _date_: _d, _action_: _a, ...rest } = row;
      const cast = applyRow(rest, tableCasts);

      if (rawDate) {
        // Non-empty _date_ = start of a new message
        flushGroup(this);
        groupDate   = rawDate;
        groupAction = rawAction;
        // Only add the row if it has data fields (empty-data messages store a
        // metadata-only row with no other columns — reconstruct as data: []).
        if (Object.keys(cast).length > 0) group.push(cast);
        cb();
      } else {
        // Empty _date_ = continuation row within the current message
        if (group.length > 0) {
          group.push(cast);
        } else {
          // Orphan continuation with no open group: emit as a plain object
          this.push(JSON.stringify(cast) + '\n');
        }

        cb();
      }
    },
    flush(cb: TransformCallback) {
      flushGroup(this);
      cb();
    },
  });
};

// Returns the column names for a file, open or closed.
// Uses the in-memory header if the file is currently open; otherwise reads
// the first line from disk. Both open (.csv.gz.tmp) and closed (.csv.gz) files
// are gzipped, so both are decompressed on the fly.
export const readHeaders = async (table: string, date: string): Promise<string[]> => {
  const key = `${table}/${date}`;

  if (headers.has(key)) return headers.get(key)!;

  const open   = openPath(table, date);
  const closed = closedPath(table, date);

  if (existsSync(open))   return firstLine(createReadStream(open).pipe(createGunzip()));
  if (existsSync(closed)) return firstLine(createReadStream(closed).pipe(createGunzip()));

  throw new NotFoundError(`No file for ${table}/${date}`);
};

// Streams a file as NDJSON — one JSON object per row.
// Both open (.csv.gz.tmp) and closed (.csv.gz) files are gzipped; closed
// takes priority when both exist.
// Fields are cast to their correct types using the per-table casts map.
// Empty string values are dropped (treated as absent), except for fields
// marked 'required' in the casts map.
export const streamRows = (table: string, date: string): Readable => {
  const closed = closedPath(table, date);
  const open   = openPath(table, date);

  const filePath = existsSync(closed) ? closed : existsSync(open) ? open : null;

  if (! filePath) throw new NotFoundError(`No file for ${table}/${date}`);

  const tableCasts = TABLE_CASTS[table] ?? {};
  const csvParser  = createCsvParser();
  const ndjson     = createGroupTransform(tableCasts);

  csvParser.on('error', (err) => ndjson.destroy(err));

  const src = createReadStream(filePath);
  src.on('error', (err) => ndjson.destroy(err));
  src.pipe(createGunzip()).pipe(csvParser).pipe(ndjson);

  return ndjson;
};

// Returns all files for a table mapped to their state.
export const listTables = (): string[] => {
  if (! existsSync(DATA_DIR)) return [];

  return readdirSync(DATA_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
};

export const listFiles = (table: string): FileListing => {
  const result: FileListing = {};

  for (const [, f] of walkTableFiles(table)) {
    if (f.endsWith('.tmp')) {
      result[f.replace('.csv.gz.tmp', '')] = 'open';
    } else if (f.endsWith('.csv.gz')) {
      result[f.replace('.csv.gz', '')] = 'closed';
    }
  }

  return result;
};

// Returns true if the sealed .gz file exists for the given date.
export const isClosed = (table: string, date: string): boolean =>
  existsSync(closedPath(table, date));

// Returns true if any file (open or closed) exists for the given date.
export const fileExists = (table: string, date: string): boolean =>
  isClosed(table, date) || existsSync(openPath(table, date));

// ── Internals ─────────────────────────────────────────────────────────────────

const firstLine = (stream: Readable): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const rl = createInterface({ input: stream });

    rl.once('line', (line) => {
      rl.close();
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      resolve(line.split(','));
    });

    rl.once('error', reject);
  });

const applyRow = (
  raw:        Record<string, string>,
  tableCasts: Record<string, CastType>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    const cast = tableCasts[key] ?? GLOBAL_CASTS[key];

    if (cast === 'required') {
      result[key] = value;
    } else if (value === '') {
      continue;
    } else if (cast === 'number') {
      result[key] = Number(value);
    } else if (cast === 'boolean') {
      result[key] = value === 'true';
    } else if (cast === 'json') {
      try { result[key] = JSON.parse(value); } catch { result[key] = value; }
    } else if (cast === 'timestamp_D') {
      result[key] = value?.replace('D', 'T');
    } else {
      result[key] = value;
    }
  }

  return result;
};

function* walkTableFiles(table: string): Generator<DirEntry> {
  const dir = tableDir(table);

  if (! existsSync(dir)) return;

  for (const year of readdirSync(dir)) {
    const yDir = path.join(dir, String(year));

    if (! statSync(yDir).isDirectory()) continue;

    for (const f of readdirSync(yDir)) {
      yield [yDir, f];
    }
  }
}
