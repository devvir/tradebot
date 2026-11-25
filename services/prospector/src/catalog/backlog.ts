import type { DatabaseSync } from 'node:sqlite';
import * as wip from './wip';
import type { Parking, Unsettled } from '../types';

/**
 * The backlog as the rest of the service asks about it: keys parked for a
 * probe to settle, how many are owed, and what became of the ones asked about.
 *
 * `wip.ts` owns the table and the count kept of it; these are its questions
 * and answers under the names the catalog gives them.
 */

/**
 * Park keys nobody generated, because an answer implied them.
 *
 * **The other way into `wip`.** Everything else there was walked or generated
 * from a pattern; these were named by the venue's own answer — the next part of
 * a split file, the members a manifest lists — and carry the series and period
 * of the row that revealed them, because that is what they are part of.
 *
 * A key already parked is left exactly as it is: it may have attempts against it
 * already, and this is not new information about it.
 */
export const parkKeys = (db: DatabaseSync, rows: readonly Parking[]): number =>
  wip.park(db, rows);

/**
 * Keys still owed an answer, in the order they were parked. `after` is the last
 * `seq` returned; the keyset is documented on `wip.next`.
 */
export const unsettled = (
  db:      DatabaseSync,
  venueId: number,
  after:   number,
  limit:   number,
): Unsettled[] => wip.next(db, venueId, after, limit);

/**
 * Record that these rows were asked about and did not settle.
 *
 * One transaction, because a pass that counted its attempts and then died
 * half-way would give some rows a free retry and not others — and the count is
 * the only thing standing between a constructed key that cannot exist and being
 * asked about it for ever.
 */
export const missedFiles = (db: DatabaseSync, rows: readonly Unsettled[]): number =>
  wip.missed(db, rows);

/**
 * Forget candidates nobody is going to settle.
 *
 * **Deleted rather than marked absent.** `existence` carries claims about what a
 * venue published, and these rows were never claims — they are keys this service
 * constructed and asked about. Recording "okx withdrew this" for a file okx
 * never had would put a fiction where a measurement belongs, and `span` already
 * holds the honest version: the bounds these were generated inside.
 */
export const dropWip = (db: DatabaseSync, rows: readonly Unsettled[]): number =>
  wip.drop(db, rows);

/**
 * How much of this venue's backlog is still outstanding.
 *
 * **Every row in `wip` is outstanding**, which is what the table is: a candidate
 * leaves it by being settled, given up on or withdrawn, and all three delete it.
 * Nothing there is ever `absent` — a ruling of absence belongs to `file` — so
 * testing for it read every row of the slice to filter none of them, on a table
 * that reaches tens of millions per venue.
 */
export const countUnsettled = (db: DatabaseSync, venueId: number): number =>
  wip.parked(db, venueId);

/** Whether anything is outstanding, which is the question a drain actually asks. */
export const anyUnsettled = (db: DatabaseSync, venueId: number): boolean =>
  wip.anyParked(db, venueId);
