import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { createGzip } from 'node:zlib';
import type { CatalogPartitionRow } from '../types';

/**
 * The catalog's database, read for a copy of it: what it holds, and each part
 * of it written out as a file.
 *
 * **The database itself is the base**, sent whole and as it is: every table,
 * every index, nothing to get wrong. What is written out here is only what has
 * changed since.
 *
 * **Everything but the file rows is one small database** — see `writeTables`:
 * the catalog's schema whole, and the rows of every table but the two that are
 * not copied this way.
 *
 * **Read as a file, never through the catalog's service**: what is copied is
 * the database itself, every table of it, and most of those are nobody's to
 * serve. Opened read-only.
 *
 * **A partition's file is rows as text, gzipped, and the same bytes for the
 * same rows**: no time and no name in the gzip header, and rows in the order of
 * their key.
 *
 * **A partition's file is its file rows, less two things**: which partition
 * they are of, which the file's own name says, and whether each was downloaded
 * — the base knows that of every file it has, and of a file that came later it
 * is a fact about a disk.
 */
export const openCatalog = (file: string): DatabaseSync => new DatabaseSync(file, { readOnly: true });

/** Every partition of the catalog, by the name its file is given. */
export const partitionsOf = (db: DatabaseSync): CatalogPartitionRow[] =>
  (db.prepare(
    `SELECT p.id, s.venue, s.market, s.dataset, s.variant, s.grain, s.bundle, p.month, p.version
       FROM partition p JOIN slice s ON s.id = p.slice_id ORDER BY s.venue, p.month, p.id`,
  ).all() as unknown as (Omit<CatalogPartitionRow, 'name'>)[]).map(one => ({ ...one, name: nameOf(one) }));

/** `venue|market|dataset[,variant]|grain|bundle|YYYYMM`, as what it names; null where a name is not one. */
export const partitionOfName = (name: string): Omit<CatalogPartitionRow, 'id' | 'version' | 'name'> | null => {
  const [venue, market, descriptor, grain, bundle, month, ...rest] = name.split('|');

  if (! venue || ! market || ! descriptor || ! grain || ! bundle || ! month || rest.length > 0) return null;

  const comma = descriptor.indexOf(',');

  return { venue, market, dataset: comma < 0 ? descriptor : descriptor.slice(0, comma), variant: comma < 0 ? '' : descriptor.slice(comma + 1), grain, bundle, month };
};

/**
 * The tables that are copied whole: every one but the files, which go a
 * partition at a time, and what is only ever work in progress.
 */
export const tablesOf = (db: DatabaseSync): string[] =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as { name: string }[]).map(one => one.name).filter(name => ! NOT_COPIED.includes(name));

/** Write a partition's file rows to a file, in the order of their path. Returns what it weighs and a digest of it. */
export const writePartition = (db: DatabaseSync, id: number, to: string): Promise<{ bytes: number; digest: string }> =>
  written(db, `SELECT ${FILE_COLUMNS.join(', ')} FROM file WHERE partition_id = ? ORDER BY path`, [id], to);

/**
 * Write everything of the catalog but its file rows to a database of its own.
 *
 * **The schema whole, and the rows of every table but two.** Every table, index
 * and trigger is declared in it as the catalog declares it — the files' table
 * and the work in progress too, with no rows — so what is put back from it has
 * the catalog's schema exactly, and nothing has to know what that is.
 *
 * Tables first, then their rows, then everything else: a trigger declared
 * before the rows go in would fire for each of them.
 */
export const writeTables = (db: DatabaseSync, to: string): { tables: number; bytes: number } => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.rmSync(to, { force: true });

  const declared = declaredIn(db, 'main');
  const copied   = tablesOf(db);
  const out      = new DatabaseSync(to);

  try {
    // Rows go in as they are, whichever table comes first.
    out.exec('PRAGMA foreign_keys = OFF');
    out.exec('BEGIN');

    for (const one of declared) if (one.type === 'table') out.exec(one.sql);

    for (const table of copied) {
      const rows   = db.prepare(`SELECT * FROM "${table}"`);
      const names  = rows.columns().map(column => `"${column.name}"`);
      const insert = out.prepare(`INSERT INTO "${table}" (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`);

      for (const row of rows.iterate() as Iterable<Record<string, null | number | bigint | string | Uint8Array>>) insert.run(...Object.values(row));
    }

    // Where the catalog numbers rows itself, the next number it would give is part of what it holds.
    if (has(db, 'main', SEQUENCE) && has(out, 'main', SEQUENCE)) {
      const insert = out.prepare(`INSERT INTO ${SEQUENCE} (name, seq) VALUES (?, ?)`);

      out.exec(`DELETE FROM ${SEQUENCE}`);

      for (const row of db.prepare(`SELECT name, seq FROM ${SEQUENCE}`).all() as { name: string; seq: number }[])
        if (copied.includes(row.name)) insert.run(row.name, row.seq);
    }

    for (const one of declared) if (one.type !== 'table') out.exec(one.sql);

    out.exec('COMMIT');
  } finally {
    out.close();
  }

  return { tables: copied.length, bytes: fs.statSync(to).size };
};

/**
 * How the files' table is declared: the table and its indexes, as text.
 *
 * **It is what ties a snapshot to what is sent after it.** Every other table
 * comes back from `writeTables`' database with whatever schema it has then; the
 * file rows come back from the snapshot, with a partition's rows put into them.
 * So a snapshot serves for as long as the files' table is declared as it was
 * when the snapshot was taken, and no longer.
 */
export const fileSchemaOf = (db: DatabaseSync, schema = 'main'): string =>
  declaredIn(db, schema).filter(one => one.table === FILES && one.type !== 'trigger').map(one => one.sql.replace(/\s+/g, ' ').trim()).sort().join(';\n');

/** Everything a database declares, in the order of its names. */
export const declaredIn = (db: DatabaseSync, schema: string): { type: string; name: string; table: string; sql: string }[] =>
  db.prepare(`SELECT type, name, tbl_name AS "table", sql FROM ${schema}.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as { type: string; name: string; table: string; sql: string }[];

/** Whether a database has a table of this name. */
export const has = (db: DatabaseSync, schema: string, table: string): boolean =>
  !! db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(table);

/** The table of file rows: the one that comes back from the snapshot. */
export const FILES = 'file';

/** Where SQLite keeps the next number of each table it numbers itself. */
export const SEQUENCE = 'sqlite_sequence';

/** The tables a copy leaves out: the files, which go a partition at a time, and what is only ever work in progress. */
const NOT_COPIED = [FILES, 'wip'];

/** What a partition's file holds of each of its files. */
export const FILE_COLUMNS = ['venue_id', 'path', 'date', 'size', 'etag', 'modified', 'series_id', 'existence', 'seen_at'];

/** What stands for NULL in a file: nothing a cell can otherwise be, since a cell that is this text is quoted. */
export const NULL = '\\N';

// ── Internals ─────────────────────────────────────────────────────────────────

/** `venue|market|dataset[,variant]|grain|bundle|YYYYMM`: a partition as its file is named. */
const nameOf = (one: Omit<CatalogPartitionRow, 'name' | 'id' | 'version'>): string =>
  [one.venue, one.market, one.variant ? `${one.dataset},${one.variant}` : one.dataset, one.grain, one.bundle, one.month].join('|');

/** The rows a query answers, as CSV under a header of their columns. */
const written = (db: DatabaseSync, sql: string, values: (string | number)[], to: string): Promise<{ bytes: number; digest: string }> => {
  const statement = db.prepare(sql);

  const lines = function* (): Generator<string> {
    let headed = false;

    for (const row of statement.iterate(...values) as Iterable<Record<string, unknown>>) {
      if (! headed) yield `${Object.keys(row).join(',')}\n`;

      headed = true;

      yield `${Object.values(row).map(cell).join(',')}\n`;
    }

    // No rows: the columns are said all the same, so the file is still a table.
    if (! headed) yield `${statement.columns().map(column => column.name).join(',')}\n`;
  };

  return gzipped(Readable.from(batched(lines())), to);
};

/** Lines joined a few thousand at a time: a stream of single lines is mostly the cost of the stream. */
const batched = function* (lines: Iterable<string>): Generator<string> {
  let held: string[] = [];

  for (const line of lines) {
    held.push(line);

    if (held.length >= 5_000) {
      yield held.join('');

      held = [];
    }
  }

  if (held.length > 0) yield held.join('');
};

/**
 * One cell. NULL is `\N`, so that it is not taken for the empty text, which is
 * a value of its own; text is quoted where it holds what would end the cell,
 * and where it is the very text that stands for NULL.
 */
const cell = (value: unknown): string => {
  if (value === null || value === undefined) return NULL;

  const text = String(value);

  return /[",\n\r]/.test(text) || text === NULL ? `"${text.replace(/"/g, '""')}"` : text;
};

/** Gzip a stream into a file, with nothing in the header that changes from one run to the next. */
const gzipped = async (from: Readable, to: string): Promise<{ bytes: number; digest: string }> => {
  await fs.promises.mkdir(path.dirname(to), { recursive: true });

  const hash = createHash('sha256');
  const out  = fs.createWriteStream(to);

  let bytes = 0;

  const zip = createGzip({ level: 6 });

  zip.on('data', (chunk: Buffer) => {
    hash.update(chunk);

    bytes += chunk.length;
  });

  await pipeline(from, zip, out);

  return { bytes, digest: hash.digest('hex').slice(0, 16) };
};
