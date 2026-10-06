import type { DatabaseSync } from 'node:sqlite';
import type { Lens, LensSize, LensVenueFigures } from '../types';

/**
 * What a saved lens holds, per venue, summed over its partitions: how many it
 * lets through, their files, bytes and what is still pending, and the first and
 * last month with a file.
 *
 * **One query, and nothing evaluated.** The rows are the lens and each carries
 * its own counts, so a size is a sum over them — the same after a restart as an
 * hour into a run.
 */
export const lensFigures = (db: DatabaseSync, lens: Lens): Map<string, LensVenueFigures> => {
  const rows = db.prepare(
    `SELECT c.venue,
            COUNT(*)                          AS partitions,
            COALESCE(SUM(q.files), 0)         AS files,
            COALESCE(SUM(q.bytes), 0)         AS bytes,
            COALESCE(SUM(q.pending), 0)       AS pending,
            COALESCE(SUM(q.pending_bytes), 0) AS pendingBytes,
            MIN(CASE WHEN q.files > 0 THEN q.month END) AS first,
            MAX(CASE WHEN q.files > 0 THEN q.month END) AS last
       FROM lens_member l
       JOIN partition q ON q.id = l.partition_id
       JOIN slice c     ON c.id = q.slice_id
      WHERE l.lens_id = ?
      GROUP BY c.venue`,
  ).all(lens.id!) as unknown as (LensVenueFigures & { venue: string })[];

  return new Map(rows.map(({ venue, ...figures }) => [venue, figures]));
};

/** The same, added up across venues — the lens's size. */
export const savedLensSize = (db: DatabaseSync, lens: Lens): LensSize => {
  const size: LensSize = { partitions: 0, files: 0, bytes: 0, pending: 0, pendingBytes: 0 };

  for (const one of lensFigures(db, lens).values()) {
    size.partitions   += one.partitions;
    size.files        += one.files;
    size.bytes        += one.bytes;
    size.pending      += one.pending;
    size.pendingBytes += one.pendingBytes;
  }

  return size;
};
