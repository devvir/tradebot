import { syncMembers } from './members';
import type { DatabaseSync } from 'node:sqlite';
import type { Lens, LensSize, LensVenueFigures } from '../types';

/**
 * What a saved lens holds, per venue, read off its rows in `lens_series` and the
 * series rollup: how many series it lets through, how many of them hold a file
 * inside it, its files, bytes and what is still pending, and the first and last
 * month with a file.
 *
 * **One query, and nothing evaluated.** The rows are the lens, so a size is a
 * sum over them — the same after a restart as an hour into a run. A row's dates
 * are file dates and the rollup's are months, so each row is read over the
 * months its dates fall in; a lens's bounds are months, so that is exact.
 */
export const lensFigures = (db: DatabaseSync, lens: Lens): Map<string, LensVenueFigures> => {
  syncMembers(db, lens);

  const rows = db.prepare(
    `WITH members AS (
       SELECT l.series_id, l.lo, l.hi, v.name AS venue
         FROM lens_series l
         JOIN series s  ON s.id = l.series_id
         JOIN pattern p ON p.id = s.pattern_id
         JOIN venue v   ON v.id = p.venue_id
        WHERE l.lens_id = ?)
     SELECT m.venue,
            COUNT(DISTINCT m.series_id)                                AS series,
            COUNT(DISTINCT CASE WHEN r.files > 0 THEN m.series_id END) AS withFiles,
            COALESCE(SUM(r.files), 0)         AS files,
            COALESCE(SUM(r.bytes), 0)         AS bytes,
            COALESCE(SUM(r.pending), 0)       AS pending,
            COALESCE(SUM(r.pending_bytes), 0) AS pendingBytes,
            MIN(CASE WHEN r.files > 0 THEN r.month END) AS first,
            MAX(CASE WHEN r.files > 0 THEN r.month END) AS last
       FROM members m
       LEFT JOIN rollup_series r
              ON r.series_id = m.series_id
             AND r.month >= substr(m.lo, 1, 6) AND r.month <= substr(m.hi, 1, 6)
      GROUP BY m.venue`,
  ).all(lens.id!) as unknown as (LensVenueFigures & { venue: string })[];

  return new Map(rows.map(({ venue, ...figures }) => [venue, figures]));
};

/** The same, added up across venues — the lens's size. */
export const savedLensSize = (db: DatabaseSync, lens: Lens): LensSize => {
  const size: LensSize = { series: 0, files: 0, bytes: 0, pending: 0, pendingBytes: 0 };

  for (const one of lensFigures(db, lens).values()) {
    size.series       += one.series;
    size.files        += one.files;
    size.bytes        += one.bytes;
    size.pending      += one.pending;
    size.pendingBytes += one.pendingBytes;
  }

  return size;
};
