import { DatabaseSync } from 'node:sqlite';
import { idOf } from '../keys';
import type { Origin } from '../../types';
import type { PartitionKey } from '../types';

/** A partition is back on the local disk: its evictions stay as history, and no longer say it is away. */
export const noteReturn = (db: DatabaseSync, origin: Origin, key: PartitionKey): void => {
  db.prepare(
    `UPDATE eviction SET returned_at = ?
      WHERE origin = ? AND venue = ? AND market = ? AND dataset = ? AND variant = ? AND grain = ? AND bundle = ? AND month = ?
        AND returned_at IS NULL`,
  ).run(new Date().toISOString(), origin, key.venue, key.market, key.dataset, key.variant, key.grain, key.bundle, key.month);
};

/** The partitions taken off the local disk and not brought back since, each by the version that went: the last time for each. */
export const evictedOf = (db: DatabaseSync, origin: Origin, venue: string): Map<string, string> => {
  const rows = db.prepare(
    `SELECT venue, market, dataset, variant, grain, bundle, month, version FROM eviction
      WHERE origin = ? AND venue = ? AND returned_at IS NULL ORDER BY evicted_at`,
  ).all(origin, venue) as unknown as (PartitionKey & { version: string })[];

  return new Map(rows.map(row => [idOf(row), row.version]));
};

/** A partition was taken off the local disk. */
export const noteEviction = (
  db:      DatabaseSync,
  origin:  Origin,
  key:     PartitionKey & { version: string },
  removed: { files: number; bytes: number },
): void => {
  db.prepare(
    `INSERT INTO eviction (origin, venue, market, dataset, variant, grain, bundle, month, version, files, bytes, evicted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(origin, key.venue, key.market, key.dataset, key.variant, key.grain, key.bundle, key.month, key.version,
    removed.files, removed.bytes, new Date().toISOString());
};
