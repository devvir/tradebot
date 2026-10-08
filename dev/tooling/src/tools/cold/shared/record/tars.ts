import { DatabaseSync } from 'node:sqlite';
import type { CatalogPartition, Held, HeldRow, PartitionKey, Totals } from '../types';
import type { Origin, Tar, TarState } from '../../types';

/** Every tar of an origin, in the order they were planned. */
export const tarsOf = (db: DatabaseSync, origin: Origin): Tar[] =>
  (db.prepare(`SELECT ${TAR} FROM tar WHERE origin = ? ORDER BY venue, month, seq`).all(origin) as unknown as Tar[]);

export const tarById = (db: DatabaseSync, id: number): Tar =>
  db.prepare(`SELECT ${TAR} FROM tar WHERE id = ?`).get(id) as unknown as Tar;

/** Every partition the record holds of a venue, whichever tar each is in. */
export const heldOf = (db: DatabaseSync, origin: Origin, venue: string): Held[] =>
  (db.prepare(`SELECT ${HELD} FROM held WHERE origin = ? AND venue = ?`).all(origin, venue) as unknown as HeldRow[]).map(asHeld);

/** The partitions one tar holds. */
export const heldIn = (db: DatabaseSync, tarId: number): Held[] =>
  (db.prepare(`SELECT ${HELD} FROM held WHERE tar_id = ? ORDER BY market, dataset, variant, grain, bundle`)
    .all(tarId) as unknown as HeldRow[]).map(asHeld);

/**
 * Plan one tar: its row, and the partitions it will hold.
 *
 * **Written before the tar exists, in one transaction.** A run that stops after
 * this finds the plan and makes the tar; one that stops before it finds nothing
 * and plans again. The sequence continues from the venue-month's last tar, so a
 * month gains tars as more of it is stored and none is ever renumbered.
 */
export const planTar = (
  db:         DatabaseSync,
  origin:     Origin,
  venue:      string,
  month:      string,
  name:       (seq: number) => { remote: string; local: string },
  partitions: readonly CatalogPartition[],
): number => {
  db.exec('BEGIN IMMEDIATE');

  try {
    const { seq } = db.prepare(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM tar WHERE origin = ? AND venue = ? AND month = ?',
    ).get(origin, venue, month) as { seq: number };

    const { remote, local } = name(seq);

    const id = Number(db.prepare(
      `INSERT INTO tar (origin, venue, month, seq, remote, local, state, planned_at)
            VALUES (?, ?, ?, ?, ?, ?, 'planned', ?)`,
    ).run(origin, venue, month, seq, remote, local, new Date().toISOString()).lastInsertRowid);

    const insert = db.prepare(
      `INSERT INTO held (tar_id, origin, venue, market, dataset, variant, grain, bundle, month, version, files, bytes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    for (const one of partitions)
      insert.run(id, origin, venue, one.market, one.dataset, one.variant, one.grain, one.bundle, one.month,
        one.version, one.files, one.bytes);

    db.exec('COMMIT');

    return id;
  } catch (err) {
    db.exec('ROLLBACK');

    throw err;
  }
};

/**
 * Forget a venue's tars that were planned and never made, with what they were
 * to hold. Returns how many.
 *
 * **A plan is redrawn on every run.** What is ready is the catalog's answer
 * today, and a tar nothing was done for is only yesterday's answer written
 * down — so it is dropped, and whatever of it is still ready is planned again.
 */
export const dropPlanned = (db: DatabaseSync, origin: Origin, venue: string): number => {
  db.exec('BEGIN IMMEDIATE');

  try {
    const tars = `SELECT id FROM tar WHERE origin = ? AND venue = ? AND state = 'planned'`;

    db.prepare(`DELETE FROM held WHERE tar_id IN (${tars})`).run(origin, venue);

    const dropped = Number(db.prepare(
      `DELETE FROM tar WHERE origin = ? AND venue = ? AND state = 'planned'`).run(origin, venue).changes);

    db.exec('COMMIT');

    return dropped;
  } catch (err) {
    db.exec('ROLLBACK');

    throw err;
  }
};

/**
 * Say what the catalog now holds of a partition the record already has.
 *
 * The tar exists, so what it holds is no longer current: the new version is
 * noted beside the old, and a tar already in Mega becomes `stale` — to be
 * brought back, corrected and stored again. A tar not made yet never gets
 * here: its plan was dropped and is drawn again from what the catalog says.
 */
export const noteChange = (db: DatabaseSync, held: Held, now: CatalogPartition): void => {
  const tar = tarById(db, held.tarId);

  db.prepare(`UPDATE held SET next_version = ?, next_files = ?, next_bytes = ? WHERE ${WHERE}`)
    .run(now.version, now.files, now.bytes, ...whereOf(held));

  if (tar.state === 'stored') move(db, tar.id, 'stale');
};

/** A corrected tar holds the new versions: what was noted as next is what it holds. */
export const applyChanges = (db: DatabaseSync, tarId: number): void => {
  db.prepare(
    `UPDATE held SET version = next_version, files = next_files, bytes = next_bytes,
                     next_version = NULL, next_files = NULL, next_bytes = NULL
      WHERE tar_id = ? AND next_version IS NOT NULL`).run(tarId);
};

/** Move a tar to another state. */
export const move = (db: DatabaseSync, id: number, state: TarState): void => {
  db.prepare('UPDATE tar SET state = ? WHERE id = ?').run(state, id);
};

/** A tar is on disk and proved: this is what it weighs. */
export const packed = (db: DatabaseSync, id: number, bytes: number): void => {
  db.prepare(`UPDATE tar SET state = 'packed', bytes = ? WHERE id = ?`).run(bytes, id);
};

/** Mega confirms a tar: where it is, under which handle. */
export const stored = (db: DatabaseSync, id: number, handle: string | null): void => {
  db.prepare(`UPDATE tar SET state = 'stored', handle = ?, stored_at = ? WHERE id = ?`)
    .run(handle, new Date().toISOString(), id);
};

/**
 * The partitions cold storage holds as the record wants them: in a tar that is
 * stored, with nothing noted as having changed since. By partition, each with
 * the version stored.
 */
export const storedOf = (db: DatabaseSync, origin: Origin, venue: string): Held[] =>
  (db.prepare(
    `SELECT ${HELD} FROM held
      WHERE origin = ? AND venue = ? AND next_version IS NULL
        AND tar_id IN (SELECT id FROM tar WHERE state = 'stored')`,
  ).all(origin, venue) as unknown as HeldRow[]).map(asHeld);

/**
 * The partitions Mega holds a whole tar of, whatever the catalog has made of
 * them since: in a tar that is stored, or one that is stored and due to be
 * corrected.
 */
export const pullableOf = (db: DatabaseSync, origin: Origin, venue: string): Held[] =>
  (db.prepare(
    `SELECT ${HELD} FROM held
      WHERE origin = ? AND venue = ?
        AND tar_id IN (SELECT id FROM tar WHERE state IN ('stored', 'stale'))`,
  ).all(origin, venue) as unknown as HeldRow[]).map(asHeld);

/** What the record holds of an origin, added up. */
export const totals = (db: DatabaseSync, origin: Origin): Totals => ({
  ...(db.prepare(
    `SELECT COUNT(*) AS tars, COALESCE(SUM(state = 'stored'), 0) AS stored,
            COALESCE(SUM(bytes), 0) AS bytes,
            COALESCE(SUM(CASE WHEN state = 'stored' THEN bytes END), 0) AS storedBytes
       FROM tar WHERE origin = ?`).get(origin) as unknown as Omit<Totals, 'partitions'>),
  partitions: (db.prepare('SELECT COUNT(*) AS n FROM held WHERE origin = ?').get(origin) as { n: number }).n,
});

// ── Internals ─────────────────────────────────────────────────────────────────

const TAR = `id, origin, venue, month, seq, remote, local, bytes, state, handle, stored_at AS storedAt`;

const HELD = `tar_id AS tarId, venue, market, dataset, variant, grain, bundle, month, version, files, bytes,
              next_version AS nextVersion, next_files AS nextFiles, next_bytes AS nextBytes`;

const WHERE = 'tar_id = ? AND market = ? AND dataset = ? AND variant = ? AND grain = ? AND bundle = ? AND month = ?';

const whereOf = (held: PartitionKey & { tarId: number }): (string | number)[] =>
  [held.tarId, held.market, held.dataset, held.variant, held.grain, held.bundle, held.month];

const asHeld = (row: HeldRow): Held => {
  const { nextVersion, nextFiles, nextBytes, ...rest } = row;

  return { ...rest, next: nextVersion === null ? null : { version: nextVersion, files: nextFiles!, bytes: nextBytes! } };
};
