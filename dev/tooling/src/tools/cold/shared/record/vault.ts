import { DatabaseSync } from 'node:sqlite';
import type { StoredFile, VaultFile } from '../types';

/** Every vault file the record holds, whatever its state. */
export const vaultFiles = (db: DatabaseSync): StoredFile[] =>
  db.prepare(`SELECT ${VAULT_FILE} FROM vault_file ORDER BY partition, revision, instrument, side`).all() as unknown as StoredFile[];

/** The vault files that are not in cold storage yet, in the order they were planned. */
export const vaultFilesPending = (db: DatabaseSync): StoredFile[] =>
  db.prepare(`SELECT ${VAULT_FILE} FROM vault_file WHERE state <> 'stored' ORDER BY rowid`).all() as unknown as StoredFile[];

/** The files of one partition at one revision. */
export const vaultFilesOf = (db: DatabaseSync, partition: string, revision: string): StoredFile[] =>
  db.prepare(`SELECT ${VAULT_FILE} FROM vault_file WHERE partition = ? AND revision = ? ORDER BY instrument, side`)
    .all(partition, revision) as unknown as StoredFile[];

/**
 * Plan a partition's files for cold storage. One already in the record keeps
 * the state it has: planning is asked again on every run, and must not undo
 * what an earlier one did.
 */
export const planVaultFiles = (db: DatabaseSync, files: readonly VaultFile[]): void => {
  const insert = db.prepare(
    `INSERT INTO vault_file (partition, revision, instrument, side, path, bytes, state)
          VALUES (?, ?, ?, ?, ?, ?, 'planned')
       ON CONFLICT (partition, revision, instrument, side) DO NOTHING`);

  db.exec('BEGIN IMMEDIATE');

  try {
    for (const one of files) insert.run(one.partition, one.revision, one.instrument, one.side, one.path, one.bytes);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');

    throw err;
  }
};

/** Move a vault file on: handed to Mega, confirmed there, or back to be handed over again. */
export const moveVaultFile = (
  db:     DatabaseSync,
  file:   Pick<VaultFile, 'partition' | 'revision' | 'instrument' | 'side'>,
  state:  StoredFile['state'],
  handle: string | null = null,
): void => {
  db.prepare(
    `UPDATE vault_file SET state = ?, handle = ?, stored_at = ?
      WHERE partition = ? AND revision = ? AND instrument = ? AND side = ?`,
  ).run(state, handle, state === 'stored' ? new Date().toISOString() : null, file.partition, file.revision, file.instrument, file.side);
};

/** Every file of a partition is in cold storage: the partition is. */
export const storeVaultPartition = (db: DatabaseSync, partition: string, revision: string): void => {
  db.prepare(
    `INSERT INTO vault_partition (partition, revision, files, bytes, stored_at)
          SELECT partition, revision, COUNT(*), SUM(bytes), ? FROM vault_file
           WHERE partition = ? AND revision = ?
           GROUP BY partition, revision
       ON CONFLICT (partition, revision) DO NOTHING`,
  ).run(new Date().toISOString(), partition, revision);
};

/** Mega's own identifier for a stored vault file, where it is no longer the one written down. */
export const reHandleVaultFile = (
  db:     DatabaseSync,
  file:   Pick<VaultFile, 'partition' | 'revision' | 'instrument' | 'side'>,
  handle: string | null,
): void => {
  db.prepare('UPDATE vault_file SET handle = ? WHERE partition = ? AND revision = ? AND instrument = ? AND side = ?')
    .run(handle, file.partition, file.revision, file.instrument, file.side);
};

/** A partition is not whole in cold storage after all: its files keep what each says of itself. */
export const dropVaultPartition = (db: DatabaseSync, partition: string, revision: string): void => {
  db.prepare('DELETE FROM vault_partition WHERE partition = ? AND revision = ?').run(partition, revision);
};

/** Every partition written down as whole in cold storage, with how many files that was. */
export const vaultPartitions = (db: DatabaseSync): { partition: string; revision: string; files: number }[] =>
  db.prepare('SELECT partition, revision, files FROM vault_partition ORDER BY partition').all() as unknown as { partition: string; revision: string; files: number }[];

/**
 * The partitions every file of which is stored, that are not written down as
 * whole: a run stored the last of their files and stopped before saying so.
 */
export const vaultUnfinished = (db: DatabaseSync): { partition: string; revision: string }[] =>
  db.prepare(
    `SELECT partition, revision FROM vault_file f
      GROUP BY partition, revision
     HAVING SUM(state <> 'stored') = 0
        AND NOT EXISTS (SELECT 1 FROM vault_partition p WHERE p.partition = f.partition AND p.revision = f.revision)`,
  ).all() as unknown as { partition: string; revision: string }[];

/** The vault files written down as stored since a moment, an ISO timestamp. */
export const vaultFilesStoredSince = (db: DatabaseSync, since: string): StoredFile[] =>
  db.prepare(`SELECT ${VAULT_FILE} FROM vault_file WHERE state = 'stored' AND stored_at >= ? ORDER BY partition, instrument, side`)
    .all(since) as unknown as StoredFile[];

/** The vault partitions in cold storage, each by the revisions that are. */
export const vaultStored = (db: DatabaseSync): Map<string, Set<string>> => {
  const stored = new Map<string, Set<string>>();

  for (const row of db.prepare('SELECT partition, revision FROM vault_partition').all() as { partition: string; revision: string }[])
    stored.set(row.partition, (stored.get(row.partition) ?? new Set()).add(row.revision));

  return stored;
};

/** Forget what of a revision never reached cold storage. What did stays, to be removed from there when another replaces it. */
export const dropVaultPending = (db: DatabaseSync, partition: string, revision: string): void => {
  db.prepare(`DELETE FROM vault_file WHERE partition = ? AND revision = ? AND state <> 'stored'`).run(partition, revision);
};

/** Forget a revision of a partition: its files have been removed from cold storage, or were never sent. */
export const dropVaultRevision = (db: DatabaseSync, partition: string, revision: string): void => {
  db.prepare('DELETE FROM vault_file WHERE partition = ? AND revision = ?').run(partition, revision);
  db.prepare('DELETE FROM vault_partition WHERE partition = ? AND revision = ?').run(partition, revision);
};

/** Vault files were taken off the local disk, or brought back to it: how things stand now, and a line of history each. */
export const noteVaultMoves = (db: DatabaseSync, files: readonly VaultFile[], action: 'evicted' | 'restored'): void => {
  const insert = db.prepare(
    `INSERT INTO vault_move (partition, revision, instrument, side, bytes, action, moved_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const stand  = db.prepare(
    `UPDATE vault_file SET evicted_at = ? WHERE partition = ? AND revision = ? AND instrument = ? AND side = ?`);
  const at = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE');

  try {
    for (const one of files) {
      insert.run(one.partition, one.revision, one.instrument, one.side, one.bytes, action, at);
      stand.run(action === 'evicted' ? at : null, one.partition, one.revision, one.instrument, one.side);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');

    throw err;
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

const VAULT_FILE = 'partition, revision, instrument, side, path, bytes, state, handle, evicted_at AS evictedAt';
