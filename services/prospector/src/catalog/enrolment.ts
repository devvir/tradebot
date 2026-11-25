import type { DatabaseSync } from 'node:sqlite';
import { newestRun } from './passes';
import type { RunKind, Standing } from '../types';

/**
 * Which venues this deployment surveys, and where each stands.
 *
 * `survey` holds a decision somebody took — a venue asked for, a venue paused —
 * and the run rows hold what has been done since; a venue's standing is read
 * from the two together.
 */

/**
 * Whether anybody has ever asked for this venue, and whether it is stopped.
 *
 * **The one thing the run rows cannot say.** They record what has been done;
 * this records whether anything should be — a decision somebody made, which is
 * why it is stored rather than inferred. Absence is the resting state: a
 * deployment nobody has asked anything of surveys nothing, for ever.
 */
export interface Enrolled {
  enrolledAt: string;

  /** When it was stopped, or null while it is running. */
  pausedAt:   string | null;
}

export const enrolled = (db: DatabaseSync, venue: string): Enrolled | null => {
  const row = db.prepare(
    'SELECT enrolled_at AS enrolledAt, paused_at AS pausedAt FROM survey WHERE venue = ?',
  ).get(venue) as Enrolled | undefined;

  return row ?? null;
};

/**
 * Take this venue on, if it is not already.
 *
 * **Enrolling is not resuming.** A venue already enrolled keeps the moment it
 * was first asked for — that is what `enrolled_at` is — and a pause is lifted by
 * `resumeSurvey`, deliberately, so that starting a paused venue is a decision
 * somebody took rather than a side effect of asking twice.
 */
export const enrol = (db: DatabaseSync, venue: string, at: string): void => {
  db.prepare('INSERT OR IGNORE INTO survey (venue, enrolled_at) VALUES (?, ?)').run(venue, at);
};

/** Stop it, and remember when. Answers whether this changed anything. */
export const pauseSurvey = (db: DatabaseSync, venue: string, at: string): boolean =>
  db.prepare('UPDATE survey SET paused_at = ? WHERE venue = ? AND paused_at IS NULL')
    .run(at, venue).changes > 0;

/** Lift a pause. Answers whether there was one. */
export const resumeSurvey = (db: DatabaseSync, venue: string): boolean =>
  db.prepare('UPDATE survey SET paused_at = NULL WHERE venue = ? AND paused_at IS NOT NULL')
    .run(venue).changes > 0;

/**
 * Whether this venue is one this deployment keeps current, and where it got to.
 *
 * **Enrolment is a fact in the database, not a setting.** A venue is surveyed
 * because somebody asked it to be, once — and from then on the run rows say so,
 * whatever restarts happen in between. Nothing here is enrolled by being
 * configured: a deployment that never starts a survey stays read-only for ever,
 * and one that starts a single survey keeps that venue current without being
 * asked again.
 *
 * Two answers, because they lead to different things. An **open** job is work
 * interrupted, and is resumed at once. A **last start** with nothing open is a
 * venue between passes, and its next one is due an interval after that start —
 * possibly in the past, in which case it is due now.
 *
 * `probe` is not consulted: it is the settling half of whichever pass it belongs
 * to rather than a pass of its own.
 */
export interface Enrolment {
  /** The kind of job still open, or null where none is. */
  open:    RunKind | null;

  /** When the most recent job of either kind began, or null where none has. */
  started: string | null;
}

export const enrolment = (db: DatabaseSync, venueId: number): Enrolment => {
  const row = newestRun(db, venueId);

  if (! row) return { open: null, started: null };

  return { open: row.completed === null ? row.kind : null, started: row.started };
};

/**
 * Where a venue stands, from the two things that decide it.
 *
 * **`survey` says whether it should be running; `run` says what it is doing.**
 * Neither answers on its own, and keeping them apart is what stops the pair
 * disagreeing: a venue can be enrolled with no job (waiting for the next
 * update), or have an open job while nobody is working it (a pause, a survey
 * loop that ended on a fault, or a venue outside this process's scope).
 *
 * The interval is measured from the **start** of the last pass rather than its
 * end, so a walk that ran longer than the interval is already overdue when it
 * finishes — and a restart cannot change a venue's cadence.
 */
export const standingOf = (
  db:       DatabaseSync,
  venue:    string,
  venueIds: readonly number[],
  everyMs:  number,
): Omit<Standing, 'surveying' | 'stopping'> => {
  const held = enrolled(db, venue);

  if (! held)
    return { state: 'not started', enrolledAt: null, since: null, during: null, nextRun: null };

  /** Any host mid-job makes the venue mid-job; the newest start sets the clock. */
  const open    = venueIds.map(id => enrolment(db, id)).filter(one => one.open !== null);
  const started = venueIds
    .map(id => enrolment(db, id).started)
    .filter((one): one is string => one !== null)
    .sort()
    .at(-1) ?? null;

  const doing = open.length === 0 ? 'waiting'
    : open.some(one => one.open === 'walk') ? 'walking' : 'updating';

  const nextRun = doing === 'waiting' && started !== null
    ? new Date(Date.parse(started) + everyMs).toISOString()
    : null;

  return held.pausedAt === null
    ? {
      state:      doing,
      enrolledAt: held.enrolledAt,
      since:      open.length === 0 ? null : started,
      during:     null,
      nextRun,
    }
    : {
      /** Paused says who stopped it; `during` says what it would go back to. */
      state:      'paused',
      enrolledAt: held.enrolledAt,
      since:      held.pausedAt,
      during:     doing,
      nextRun,
    };
};
