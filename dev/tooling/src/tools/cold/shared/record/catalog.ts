import type { DatabaseSync } from 'node:sqlite';
import type { CatalogCopy } from '../types';

/** Every file of the catalog's copy the record holds, by name. */
export const catalogCopies = (db: DatabaseSync): Map<string, CatalogCopy> =>
  new Map((db.prepare(`SELECT ${COPY} FROM catalog_copy`).all() as unknown as CatalogCopy[]).map(one => [one.name, one]));

/** A file of the catalog's copy was handed to Mega, at this version of what it is of. */
export const queueCatalogCopy = (db: DatabaseSync, copy: Pick<CatalogCopy, 'name' | 'kind' | 'remote' | 'version' | 'bytes'> & { schema?: string }): void => {
  db.prepare(
    `INSERT INTO catalog_copy (name, kind, remote, version, bytes, state, schema) VALUES (?, ?, ?, ?, ?, 'queued', ?)
       ON CONFLICT (name) DO UPDATE SET kind = excluded.kind, remote = excluded.remote, version = excluded.version,
                                        bytes = excluded.bytes, state = 'queued', handle = NULL, stored_at = NULL, schema = excluded.schema`,
  ).run(copy.name, copy.kind, copy.remote, copy.version, copy.bytes, copy.schema ?? null);
};

/** A file of the catalog's copy is in Mega. */
export const storeCatalogCopy = (db: DatabaseSync, name: string, handle: string | null): void => {
  db.prepare(`UPDATE catalog_copy SET state = 'stored', handle = ?, stored_at = ? WHERE name = ?`).run(handle, new Date().toISOString(), name);
};

/**
 * A base has been stored: everything else is as the base has it, at these
 * versions, with no file of its own. What was written down of the files sent
 * since the base before it is forgotten.
 */
export const coverCatalog = (db: DatabaseSync, covered: readonly Pick<CatalogCopy, 'name' | 'kind' | 'version'>[]): void => {
  const insert = db.prepare(
    `INSERT INTO catalog_copy (name, kind, remote, version, bytes, state, stored_at) VALUES (?, ?, '', ?, 0, 'stored', ?)`);
  const at = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE');

  try {
    db.exec(`DELETE FROM catalog_copy WHERE kind <> 'base'`);

    for (const one of covered) insert.run(one.name, one.kind, one.version, at);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');

    throw err;
  }
};

/** A file of the catalog's copy is no longer one: what it was of is gone from the catalog. */
export const dropCatalogCopy = (db: DatabaseSync, name: string): void => {
  db.prepare('DELETE FROM catalog_copy WHERE name = ?').run(name);
};

// ── Internals ─────────────────────────────────────────────────────────────────

const COPY = 'name, kind, remote, version, bytes, state, handle, stored_at AS storedAt, schema';
