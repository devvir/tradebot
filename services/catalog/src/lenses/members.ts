import { logger } from '@devvir/service-kit';
import { GLOBAL, lets, rulesFor, spansFor, venuesIn } from './rules';
import type { DatabaseSync } from 'node:sqlite';
import type { Lens, LensDefinition, LensSpan, PartitionMember } from '../types';

/**
 * What a lens lets through, as rows of `lens_member`: its partitions. Every
 * view through a lens reads these, so none of them evaluates rules.
 *
 * **Rebuilt when the lens is saved, for the venues the save changed**: a change
 * to one venue's rules can only move that venue's partitions, while a change to
 * the global rules (`*`) can move any. **Extended, never rebuilt, as partitions
 * arrive**: prospector numbers them in order, so a lens records the newest it
 * has looked at (`partitions_through`) and only what is past that is evaluated.
 *
 * **Kept current in the background** (`keepCurrent`), a step at a time, so a
 * request through a lens rarely finds anything to add — and a request that does
 * still adds it first (`syncMembers`), so a lens is never behind the catalog.
 */

/**
 * Evaluate a saved lens again: every venue where `was` is not given, and
 * otherwise only the venues whose rules differ from `was`.
 */
export const rebuildMembers = (db: DatabaseSync, lens: Lens, was?: LensDefinition): void => {
  const venues = was ? changedVenues(db, was, lens.definition) : null;

  if (venues && venues.length === 0) return;

  writing(db, () => {
    if (venues) {
      db.prepare(
        `DELETE FROM lens_member WHERE lens_id = ? AND partition_id IN (
           SELECT q.id FROM partition q JOIN slice c ON c.id = q.slice_id
            WHERE c.venue IN (SELECT value FROM json_each(?)))`,
      ).run(lens.id!, JSON.stringify(venues));

      // Up to where the lens has read: anything newer is added by catching up, as for any lens.
      add(db, lens, 0, throughOf(db, lens), venues.filter(one => venuesIn(db, lens.definition).includes(one)));

      return;
    }

    const newest = newestPartition(db);

    db.prepare('DELETE FROM lens_member WHERE lens_id = ?').run(lens.id!);
    add(db, lens, 0, newest, venuesIn(db, lens.definition));
    db.prepare('UPDATE lens SET partitions_through = ? WHERE id = ?').run(newest, lens.id!);
  });
};

/** Fold in every partition that appeared since the lens last looked, at once. */
export const syncMembers = (db: DatabaseSync, lens: Lens): void => {
  while (catchUp(db, lens, Infinity));
};

/** Forget a lens's rows, as deleting it does. */
export const dropMembers = (db: DatabaseSync, lensId: number): void => {
  db.prepare('DELETE FROM lens_member WHERE lens_id = ?').run(lensId);
};

/**
 * Keep every lens current in the background: now, and every `EVERY_MS`, fold in
 * the partitions that appeared since, `STEP` at a time and yielding between
 * steps, so a large arrival never holds a request up for longer than one step.
 */
export const keepCurrent = (db: DatabaseSync, lenses: () => Lens[]): (() => void) => {
  let running = false;

  const round = async (): Promise<void> => {
    if (running) return;

    running = true;

    try {
      for (const lens of lenses())
        while (catchUp(db, lens, STEP)) await new Promise(done => setImmediate(done));
    } catch (err) {
      logger.warn({ err }, 'Could not bring the lenses up to date — trying again later');
    } finally {
      running = false;
    }
  };

  void round();

  const timer = setInterval(() => void round(), EVERY_MS);

  return () => clearInterval(timer);
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** How often the lenses are brought up to date in the background. */
const EVERY_MS = 15 * 60_000;

/** Partitions evaluated per background step, between which requests are answered. */
const STEP = 5_000;

/**
 * Add the partitions past where the lens has read, up to `most` of them. Says
 * whether more remain. Each step is one transaction, and `partitions_through`
 * moves with it, so a restart or a crash resumes where it stopped.
 */
const catchUp = (db: DatabaseSync, lens: Lens, most: number): boolean => {
  const through = throughOf(db, lens);
  const newest  = newestPartition(db);

  if (through >= newest) return false;

  const upto = Math.min(newest, through + most);

  writing(db, () => {
    add(db, lens, through, upto, venuesIn(db, lens.definition));
    db.prepare('UPDATE lens SET partitions_through = ? WHERE id = ?').run(upto, lens.id!);
  });

  return upto < newest;
};

/**
 * Evaluate the partitions in `(after, upto]` of these venues against the lens,
 * and write the ones it lets through.
 *
 * **A slice's rules are folded once**, however many of its months are in the
 * range: what a lens says of a slice is a set of spans, and each partition only
 * asks whether its month is inside them.
 *
 * **Only the partitions of the venues named are read**, and a lens naming none
 * reads nothing.
 */
const add = (db: DatabaseSync, lens: Lens, after: number, upto: number, venues: readonly string[]): void => {
  if (venues.length === 0 || upto <= after) return;

  const insert = db.prepare('INSERT OR IGNORE INTO lens_member (lens_id, partition_id) VALUES (?, ?)');

  const rows = db.prepare(
    `SELECT q.id AS partitionId, q.month, c.id, c.venue, c.market, c.dataset, c.variant, c.grain, c.bundle
       FROM partition q JOIN slice c ON c.id = q.slice_id
      WHERE q.id > ? AND q.id <= ? AND c.venue IN (SELECT value FROM json_each(?))`,
  ).all(after, upto, JSON.stringify(venues)) as unknown as PartitionMember[];

  const spans = new Map<number, LensSpan[]>();

  for (const row of rows) {
    let held = spans.get(row.id);

    if (! held) {
      held = spansFor(row, rulesFor(lens.definition, row.venue));
      spans.set(row.id, held);
    }

    if (lets(held, row.month)) insert.run(lens.id!, row.partitionId);
  }
};

/**
 * The venues whose rules differ between two definitions — every venue either
 * names where the global rules differ, since those reach them all.
 */
const changedVenues = (db: DatabaseSync, was: LensDefinition, now: LensDefinition): string[] => {
  const same = (venue: string) =>
    JSON.stringify(was.venues?.[venue] ?? []) === JSON.stringify(now.venues?.[venue] ?? []);

  if (! same(GLOBAL)) return [...new Set([...venuesIn(db, was), ...venuesIn(db, now)])];

  const named = new Set([...Object.keys(was.venues ?? {}), ...Object.keys(now.venues ?? {})]);

  return [...named].filter(venue => venue !== GLOBAL && ! same(venue));
};

const throughOf = (db: DatabaseSync, lens: Lens): number =>
  (db.prepare('SELECT partitions_through AS at FROM lens WHERE id = ?').get(lens.id!) as { at: number } | undefined)?.at ?? 0;

const newestPartition = (db: DatabaseSync): number =>
  (db.prepare('SELECT MAX(id) AS id FROM partition').get() as { id: number | null }).id ?? 0;

/** One transaction, so a lens is never read half written. */
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
