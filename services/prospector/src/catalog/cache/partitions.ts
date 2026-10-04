import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FileEffect, FileState, PartitionDelta, PartitionResolver, PartitionStatements } from '../../types';

/**
 * The partitions: one row per slice and month, holding how many files it has,
 * how large, how many still to download, how many the venue has withdrawn — and
 * its version, one number that moves whenever the files it holds do.
 *
 * **Why counters at all.** Every one of those is an aggregate over `file`, which
 * is tens of gigabytes, so asking directly is not a slow query but an outage —
 * and they are the most ordinary questions anyone has. A limit does not rescue
 * them either: "is there anything left for this venue" still reads a million
 * rows to answer *no*.
 *
 * **Why at this grain.** A partition is the unit everything downstream handles
 * whole, so it is the unit they ask about; a venue's totals and a lens's size
 * are sums of a few thousand of these rows.
 *
 * **The version is a sum, so it moves as the counters do.** Each confirmed file
 * is a 64-bit number hashed from its ETag, and a partition's version is the
 * sum of them, wrapped at 64 bits: a file arriving adds its number, one
 * withdrawn subtracts it, one that changed does both. No file is read to state
 * it, and the same files give the same version whatever order they arrived in.
 *
 * **It says what the partition holds, not where the venue keeps it.** A file's
 * path is no part of its number, so a venue moving or renaming its files, with
 * the bytes unchanged, leaves every version where it was.
 *
 * Counters and version move in the caller's transaction, with the rows they
 * describe or not at all.
 */

/**
 * What a batch of writes does to the partitions, worked out without touching
 * the database.
 *
 * **Pure, and per batch rather than per row.** A survey page is a thousand keys
 * across one or two months, so folding first turns a thousand row updates into
 * a few — and leaves the arithmetic testable on its own, which is the half most
 * likely to be wrong.
 *
 * A file that moved between partitions is handled by construction: its old
 * state is taken out of the one it was in and its new state added to the one it
 * is now in, which are simply two different keys.
 */
export const deltasOf = (effects: readonly FileEffect[]): PartitionDelta[] => {
  const byId = new Map<number, PartitionDelta>();

  const at = (partitionId: number): PartitionDelta => {
    const found = byId.get(partitionId)
      ?? { partitionId, files: 0, bytes: 0, pending: 0, pendingBytes: 0, withdrawn: 0, version: 0n };

    byId.set(partitionId, found);

    return found;
  };

  for (const { was, now } of effects) {
    /**
     * **A file that is the same file is not hashed.** A download moves what is
     * pending and nothing else, and it is the commonest write there is.
     */
    const same = was !== null && sameFile(was, now);

    if (was) count(at(was.partitionId), was, -1, ! same);

    count(at(now.partitionId), now, 1, ! same);
  }

  // A batch that only restates what was already there nets to nothing, and
  // writing those rows would be work to change no number.
  return [...byId.values()].filter(moves);
};

/**
 * Record a batch of writes in the partitions they touch.
 *
 * **The caller's transaction is the point.** This never opens one of its own, so
 * the counters move with the rows they describe or not at all — a cache updated
 * in a transaction of its own is a cache that is wrong whenever the two disagree,
 * and nothing would notice.
 *
 * **The version is read, summed here and written back**, since SQLite turns an
 * integer sum that overflows into a float. `updated_at` moves only where the
 * version does.
 */
export const record = (
  db:      DatabaseSync,
  effects: readonly FileEffect[],
  at:      string = new Date().toISOString(),
): void => {
  const deltas = deltasOf(effects);

  if (deltas.length === 0) return;

  const sql = statements(db);

  for (const d of deltas) {
    if (d.version === 0n) {
      sql.count.run(d.files, d.bytes, d.pending, d.pendingBytes, d.withdrawn, d.partitionId);

      continue;
    }

    const held = sql.version.get(d.partitionId) as { version: string };

    sql.move.run(d.files, d.bytes, d.pending, d.pendingBytes, d.withdrawn,
      versionOf(BigInt(`0x${held.version}`) + d.version), at, d.partitionId);
  }
};

/**
 * Which partition a file belongs to: its series' slice, at the month of its
 * date — created where it is new.
 *
 * **One per transaction.** What it has resolved is remembered for as long as it
 * lives, and a partition it created is undone with the transaction that created
 * it — so it must not outlive that transaction.
 */
export const resolver = (db: DatabaseSync, at: string = new Date().toISOString()): PartitionResolver => {
  const sql    = statements(db);
  const slices = new Map<number, number>();
  const ids    = new Map<string, number>();

  return {
    of: (seriesId: number, date: string): number => {
      let slice = slices.get(seriesId);

      if (slice === undefined) {
        slice = (sql.slice.get(seriesId) as { sliceId: number }).sliceId;
        slices.set(seriesId, slice);
      }

      const month = date.slice(0, 6);
      const key   = `${slice}|${month}`;
      const had   = ids.get(key);

      if (had !== undefined) return had;

      const found = sql.find.get(slice, month) as { id: number } | undefined;
      const id    = found ? found.id : Number(sql.make.run(slice, month, at).lastInsertRowid);

      ids.set(key, id);

      return id;
    },
  };
};

/** A sum of file numbers as a partition states it: sixteen hex digits, wrapped at 64 bits. */
export const versionOf = (sum: bigint): string =>
  BigInt.asUintN(64, sum).toString(16).padStart(16, '0');

// ── Internals ─────────────────────────────────────────────────────────────────

/** Add one file state into a partition's cell, or take it out (`sign` -1). */
const count = (
  cell:   PartitionDelta,
  state:  FileState,
  sign:   1 | -1,
  hashed: boolean,
): void => {
  if (! state.confirmed) {
    cell.withdrawn += sign;

    return;
  }

  cell.files += sign;
  cell.bytes += sign * state.bytes;

  if (hashed) cell.version += BigInt(sign) * numberOf(state);

  if (! state.downloaded) {
    cell.pending      += sign;
    cell.pendingBytes += sign * state.bytes;
  }
};

/**
 * One file as a 64-bit number: the head of a hash over its ETag.
 *
 * **What the file holds, and nothing about where it is.** An ETag is a hash of
 * the bytes at every venue here — a download is checked against it — so the
 * same bytes are the same number under any path, and in a catalog rebuilt from
 * nothing.
 */
const numberOf = (state: FileState): bigint =>
  createHash('sha256').update(state.etag ?? '').digest().readBigUInt64BE(0);

/** Whether two states of one file are the same confirmed file in the same partition. */
const sameFile = (was: FileState, now: FileState): boolean =>
  was.confirmed && now.confirmed && was.partitionId === now.partitionId && was.etag === now.etag;

/** Whether a delta says anything. */
const moves = (d: PartitionDelta): boolean =>
  d.files !== 0 || d.bytes !== 0 || d.pending !== 0 || d.pendingBytes !== 0 || d.withdrawn !== 0
  || d.version !== 0n;

/** Prepared once per database: every file write passes through here. */
const statements = (db: DatabaseSync): PartitionStatements => {
  let held = PREPARED.get(db);

  if (! held) {
    const counters = `files = files + ?, bytes = bytes + ?, pending = pending + ?,
                      pending_bytes = pending_bytes + ?, withdrawn = withdrawn + ?`;

    held = {
      count:   db.prepare(`UPDATE partition SET ${counters} WHERE id = ?`),
      version: db.prepare('SELECT version FROM partition WHERE id = ?'),
      move:    db.prepare(`UPDATE partition SET ${counters}, version = ?, updated_at = ? WHERE id = ?`),
      slice:   db.prepare(
        'SELECT p.slice_id AS sliceId FROM series s JOIN pattern p ON p.id = s.pattern_id WHERE s.id = ?'),
      find:    db.prepare('SELECT id FROM partition WHERE slice_id = ? AND month = ?'),
      make:    db.prepare('INSERT INTO partition (slice_id, month, updated_at) VALUES (?, ?, ?)'),
    };

    PREPARED.set(db, held);
  }

  return held;
};

const PREPARED = new WeakMap<DatabaseSync, PartitionStatements>();
