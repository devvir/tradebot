import type { DatabaseSync } from 'node:sqlite';
import type { Lens, Partition, PartitionFilter, PartitionStatements, Slice, SliceContents } from './types';

/**
 * Slices and their partitions, as prospector keeps them.
 *
 * A **slice** is one lengthwise cut of a venue's data — a dataset of a market,
 * narrowed by variant, grain and bundle — and a **partition** is one month of
 * it: the unit that is downloaded, stocked and stored whole. Each partition
 * carries its own counts and a version that moves whenever its files do, so
 * everything here is a read of a few thousand rows and never of a file.
 */

/** A venue's slices, whether or not any holds a file. */
export const slicesOf = (db: DatabaseSync, venue: string): Slice[] =>
  statements(db).slices.all(venue) as unknown as Slice[];

/**
 * A venue's partitions with their slices' traits — through a lens, only those
 * it lets through. In slice order, each slice's months ascending.
 */
export const partitionsOf = (db: DatabaseSync, venue: string, lens: Lens | null = null): Partition[] =>
  (lens
    ? statements(db).through.all(lens.id!, venue)
    : statements(db).all.all(venue)) as unknown as Partition[];

/**
 * A venue's partitions as the contents serve them: each slice once, with its
 * months inside it, so nothing a slice says is repeated per partition. A slice
 * none of whose partitions were asked for is left out.
 */
export const partitionContents = (
  db:     DatabaseSync,
  venue:  string,
  filter: PartitionFilter,
  lens:   Lens | null,
): SliceContents[] => {
  const out: SliceContents[] = [];

  let at = -1;

  for (const row of partitionsOf(db, venue, lens)) {
    if (! asked(row, filter)) continue;

    if (row.sliceId !== at) {
      at = row.sliceId;

      out.push({
        market: row.market, dataset: row.dataset, variant: row.variant,
        grain: row.grain, bundle: row.bundle, partitions: [],
      });
    }

    out[out.length - 1]!.partitions.push({
      month: row.month, files: row.files, bytes: row.bytes,
      pending: row.pending, pendingBytes: row.pendingBytes, withdrawn: row.withdrawn,
      version: row.version, updatedAt: row.updatedAt,
    });
  }

  return out;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Whether a partition is one the caller asked about; an absent field asks for any. */
const asked = (row: Partition, filter: PartitionFilter): boolean =>
  (! filter.market      || row.market.toLowerCase()  === filter.market.toLowerCase())
  && (! filter.datasets || filter.datasets.some(one => one.toLowerCase() === row.dataset.toLowerCase()))
  && (! filter.variant  || row.variant.toLowerCase() === filter.variant.toLowerCase())
  && (! filter.grain    || row.grain === filter.grain)
  && (! filter.bundle   || row.bundle === filter.bundle)
  && (! filter.downloaded || row.pending === 0)
  && (! filter.settledBefore || row.updatedAt < filter.settledBefore);

/** Prepared once per database. */
const statements = (db: DatabaseSync): PartitionStatements => {
  let held = PREPARED.get(db);

  if (! held) {
    const read = (lens: boolean) => db.prepare(
      `SELECT q.id, q.slice_id AS sliceId, q.month, q.files, q.bytes, q.pending,
              q.pending_bytes AS pendingBytes, q.withdrawn, q.version, q.updated_at AS updatedAt,
              c.venue, c.market, c.dataset, c.variant, c.grain, c.bundle
         FROM slice c
         JOIN partition q ON q.slice_id = c.id
         ${lens ? 'JOIN lens_member l ON l.lens_id = ? AND l.partition_id = q.id' : ''}
        WHERE c.venue = ?
        ORDER BY c.market, c.dataset, c.variant, c.grain, c.bundle, q.month`);

    held = {
      all:     read(false),
      through: read(true),
      slices:  db.prepare(
        `SELECT id, venue, market, dataset, variant, grain, bundle FROM slice
          WHERE venue = ? ORDER BY market, dataset, variant, grain, bundle`),
    };

    PREPARED.set(db, held);
  }

  return held;
};

const PREPARED = new WeakMap<DatabaseSync, PartitionStatements>();
