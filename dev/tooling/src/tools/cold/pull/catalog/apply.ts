import fs from 'node:fs';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { FILES, FILE_COLUMNS, NULL, SEQUENCE, declaredIn, fileSchemaOf, has, partitionOfName } from '../../push/catalog/source';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Put what changed since the snapshot into a copy of it: every table but the
 * files', and the file rows of each partition that has a file of its own.
 *
 * **Every table but the files' comes from the tables' database**, schema and
 * rows — see `writeTables`. What the snapshot had of them is dropped: they are
 * small, and what was sent last is what they are.
 *
 * **The file rows are the snapshot's, with each sent partition's put into
 * them.** A row that is there already is written over and one that is not is
 * added; nothing is taken out, since the catalog never takes a file row out.
 *
 * **Whether a file was downloaded is kept where it can be**: a row that is the
 * same file as the snapshot had — the same path and checksum — keeps what the
 * snapshot said of it. A file that is new, or changed, was not downloaded as
 * far as this copy knows.
 */

/** Replace every table but the files' with what the tables' database holds, schema and rows. Returns how many there were. */
export const applyTables = (db: DatabaseSync, file: string): number => {
  db.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS ${SENT}`);

  try {
    // What ties the two together — see `fileSchemaOf`.
    if (fileSchemaOf(db) !== fileSchemaOf(db, SENT))
      throw new Error('the snapshot\'s table of files is not declared as the tables sent after it expect — a snapshot taken since is needed (cold push catalog --rebase)');

    const here = declaredIn(db, 'main');
    const sent = declaredIn(db, SENT);

    let tables = 0;

    db.exec('BEGIN IMMEDIATE');

    try {
      for (const one of here) if (one.type === 'trigger') db.exec(`DROP TRIGGER "${one.name}"`);
      for (const one of here) if (one.type === 'view') db.exec(`DROP VIEW "${one.name}"`);
      for (const one of here) if (one.type === 'table' && one.name !== FILES) db.exec(`DROP TABLE "${one.name}"`);

      for (const one of sent) {
        if (one.type !== 'table' || one.name === FILES) continue;

        db.exec(one.sql);
        db.exec(`INSERT INTO main."${one.name}" SELECT * FROM ${SENT}."${one.name}"`);

        tables++;
      }

      if (has(db, 'main', SEQUENCE) && has(db, SENT, SEQUENCE)) {
        db.exec(`DELETE FROM main.${SEQUENCE} WHERE name <> '${FILES}'`);
        db.exec(`INSERT INTO main.${SEQUENCE} (name, seq) SELECT name, seq FROM ${SENT}.${SEQUENCE}`);
      }

      // The files' own indexes are the snapshot's, and stay; everything else declared is put back.
      for (const one of sent) if (one.type !== 'table' && ! (one.type === 'index' && one.table === FILES)) db.exec(one.sql);

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');

      throw err;
    }

    return tables;
  } finally {
    db.exec(`DETACH DATABASE ${SENT}`);
  }
};

/** Put a partition's file rows, from its file, into the files' table. Returns how many there were. */
export const applyPartition = async (db: DatabaseSync, name: string, file: string): Promise<number> => {
  const key = partitionOfName(name);

  const partition = key && db.prepare(
    `SELECT p.id FROM partition p JOIN slice s ON s.id = p.slice_id
      WHERE s.venue = ? AND s.market = ? AND s.dataset = ? AND s.variant = ? AND s.grain = ? AND s.bundle = ? AND p.month = ?`,
  ).get(key.venue, key.market, key.dataset, key.variant, key.grain, key.bundle, key.month) as { id: number } | undefined;

  if (! partition) throw new Error(`${name}: the copy's tables have no such partition`);

  let rows = 0;

  db.exec('BEGIN IMMEDIATE');

  try {
    const insert = db.prepare(
      `INSERT INTO ${FILES} (${FILE_COLUMNS.join(', ')}, partition_id) VALUES (${FILE_COLUMNS.map(() => '?').join(', ')}, ?)
       ON CONFLICT (venue_id, path) DO UPDATE SET
         ${FILE_COLUMNS.filter(column => ! KEY.includes(column)).map(column => `${column} = excluded.${column}`).join(', ')},
         partition_id  = excluded.partition_id,
         downloaded_at = CASE WHEN ${FILES}.etag IS excluded.etag THEN ${FILES}.downloaded_at END`);

    let headed = false;

    for await (const row of rowsOf(file)) {
      if (! headed) {
        if (row.join(',') !== FILE_COLUMNS.join(',')) throw new Error(`its columns are ${row.join(',')}, where ${FILE_COLUMNS.join(',')} are expected`);

        headed = true;

        continue;
      }

      insert.run(...row, partition.id);

      rows++;
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');

    throw new Error(`${name}: ${(err as Error).message}`);
  }

  return rows;
};

/** Every file below a directory with this ending, by its name without it. */
export const filesIn = (dir: string, ending: string): Map<string, string> => {
  const found = new Map<string, string>();

  const walk = (at: string): void => {
    for (const entry of fs.existsSync(at) ? fs.readdirSync(at, { withFileTypes: true }) : []) {
      if (entry.isDirectory()) walk(path.join(at, entry.name));
      else if (entry.name.endsWith(ending)) found.set(entry.name.slice(0, -ending.length), path.join(at, entry.name));
    }
  };

  walk(dir);

  return found;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** What the tables' database is called while it is read beside the copy. */
const SENT = 'sent';

/** What a file row is known by. */
const KEY = ['venue_id', 'path'];

/**
 * The rows of a gzipped file as they were written — see `cell` in `source.ts`:
 * cells apart by commas, rows by line ends, a cell quoted where it holds
 * either, `\N` unquoted for NULL. Read as it is unzipped, so a file of millions
 * of rows is never held whole.
 */
const rowsOf = async function* (file: string): AsyncGenerator<(string | null)[]> {
  let row: (string | null)[] = [];
  let cell   = '';
  let quoted = false;
  let wasQuoted = false;
  let pending   = false;

  const end = (): void => {
    row.push(! wasQuoted && cell === NULL ? null : cell);

    cell = '';
    wasQuoted = false;
  };

  for await (const chunk of fs.createReadStream(file).pipe(createGunzip())) {
    const text = (chunk as Buffer).toString('latin1');

    for (let at = 0; at < text.length; at++) {
      const char = text[at]!;

      // A quote seen inside a quoted cell is the cell's end, or — where another follows — a quote of the cell's own.
      if (pending) {
        pending = false;

        if (char === '"') {
          cell += '"';

          continue;
        }

        quoted = false;
      }

      if (quoted) {
        if (char === '"') pending = true;
        else cell += char;
      }
      else if (char === '"') {
        quoted    = true;
        wasQuoted = true;
      }
      else if (char === ',') end();
      else if (char === '\n') {
        end();

        yield row.map(one => (one === null ? null : Buffer.from(one, 'latin1').toString('utf8')));

        row = [];
      }
      else if (char !== '\r') cell += char;
    }
  }
};
