import { letThrough, rulesFor, siblingKey } from './rules';
import type { DatabaseSync } from 'node:sqlite';
import type { Lens, PartitionMember } from './types';

/**
 * What a lens lets through, as rows of `lens_member`: its partitions. Every
 * view through a lens reads these, so none of them evaluates a rule.
 *
 * **Worked out a step at a time, in the order partitions were numbered.** A lens
 * records the newest partition it has looked at (`partitions_through`), and a
 * step looks at the ones past it. That one walk is both things a lens needs:
 * taking in the partitions that appear as the catalog grows, and — started
 * again from nothing when its rules are saved — working out what the new rules
 * let through.
 *
 * **A partition is never decided alone.** A month of a dataset can be published
 * in several forms — monthly and daily, per instrument and for a whole market —
 * each a partition of its own, and a rule that prefers one form keeps it only
 * where it is there. So what is decided is the set of siblings: looking at one
 * partition settles all of them, the ones already let through included. A daily
 * month let through while it was the only form leaves when its monthly sibling
 * appears, under a rule that prefers monthly.
 *
 * **Every function here writes.** They are for whoever owns the database to
 * call, and for nobody who only reads it.
 */

/**
 * Look at the partitions past where the lens has read, up to `most` of them,
 * and settle them and their siblings. Says whether more remain.
 *
 * Each step is one transaction, and `partitions_through` moves with it, so a
 * restart or a crash resumes where it stopped. A lens that has read everything
 * is no longer being rebuilt, and is told so.
 */
export const catchUp = (db: DatabaseSync, lens: Lens, most: number): boolean => {
  const through = throughOf(db, lens);
  const newest  = newestPartition(db);

  if (through >= newest) {
    // Nothing left to look at: whatever rebuild was under way is over.
    db.prepare('UPDATE lens SET rebuilding = 0 WHERE id = ? AND rebuilding = 1').run(lens.id!);

    return false;
  }

  const upto = Math.min(newest, through + most);

  writing(db, () => {
    settle(db, lens, through, upto);

    db.prepare('UPDATE lens SET partitions_through = ?, rebuilding = CASE WHEN ? THEN 0 ELSE rebuilding END WHERE id = ?')
      .run(upto, upto >= newest ? 1 : 0, lens.id!);
  });

  return upto < newest;
};

/**
 * Have a lens worked out again from the first partition, as saving its rules
 * asks. What it lets through stays as it is until the walk reaches it, so a
 * lens being rebuilt is read as partly the old rules' and partly the new.
 */
export const rebuild = (db: DatabaseSync, lensId: number): void => {
  db.prepare('UPDATE lens SET partitions_through = 0, rebuilding = 1 WHERE id = ?').run(lensId);
};

/** Forget a lens's rows, as deleting it does. */
export const dropMembers = (db: DatabaseSync, lensId: number): void => {
  db.prepare('DELETE FROM lens_member WHERE lens_id = ?').run(lensId);
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Settle the partitions in `(after, upto]` against the lens: each one's
 * siblings are read, the rules say which of them are let through, and the rows
 * are made to say the same — added where they were missing, removed where they
 * no longer belong.
 *
 * **Every venue's partitions are looked at**, the ones the lens says nothing of
 * too: a venue a save took out of the lens has rows to lose.
 */
const settle = (db: DatabaseSync, lens: Lens, after: number, upto: number): void => {
  const rows = db.prepare(`${MEMBER} WHERE q.id > ? AND q.id <= ?`).all(after, upto) as unknown as PartitionMember[];

  const siblingsOf = db.prepare(SIBLINGS);
  const remove = db.prepare('DELETE FROM lens_member WHERE lens_id = ? AND partition_id = ?');
  const insert = db.prepare('INSERT OR IGNORE INTO lens_member (lens_id, partition_id) VALUES (?, ?)');
  const done   = new Set<string>();

  for (const row of rows) {
    const key = siblingKey(row);

    if (done.has(key)) continue;

    done.add(key);

    const siblings = siblingsOf.all(row.venue, row.market, row.dataset, row.variant, row.month) as unknown as PartitionMember[];
    const kept     = new Set(letThrough(rulesFor(lens.definition, row.venue), siblings).map(one => one.partitionId));

    for (const one of siblings) (kept.has(one.partitionId) ? insert : remove).run(lens.id!, one.partitionId);
  }
};

/** A partition with its slice's traits, as the rules are asked about it. */
const MEMBER =
  `SELECT q.id AS partitionId, q.month, c.id, c.venue, c.market, c.dataset, c.variant, c.grain, c.bundle
     FROM partition q JOIN slice c ON c.id = q.slice_id`;

/**
 * A partition's siblings, itself among them. **From the slices, never from the
 * partitions**: a dataset of a market has a handful of slices and each has one
 * partition a month, so this is a few seeks — where starting from the
 * partitions reads every one of them, for every partition settled.
 */
const SIBLINGS =
  `SELECT q.id AS partitionId, q.month, c.id, c.venue, c.market, c.dataset, c.variant, c.grain, c.bundle
     FROM slice c CROSS JOIN partition q ON q.slice_id = c.id
    WHERE c.venue = ? AND c.market = ? AND c.dataset = ? AND c.variant = ? AND q.month = ?`;

const throughOf = (db: DatabaseSync, lens: Lens): number =>
  (db.prepare('SELECT partitions_through AS at FROM lens WHERE id = ?').get(lens.id!) as { at: number } | undefined)?.at ?? 0;

const newestPartition = (db: DatabaseSync): number =>
  (db.prepare('SELECT MAX(id) AS id FROM partition').get() as { id: number | null }).id ?? 0;

/** One transaction, so a step is never read half written. */
const writing = (db: DatabaseSync, work: () => void): void => {
  db.exec('BEGIN IMMEDIATE');

  try {
    work();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');

    throw err;
  }
};
