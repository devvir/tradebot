import type { Recurs, Weekday } from '../types';

/**
 * How a venue that is cheapest to update still gets its index re-read.
 *
 * **Updating finds no shape that did not exist before.** Generation asks only
 * about series the catalog already holds, at patterns it already knows, so a
 * dataset a venue adds — or a naming it changes — is invisible until something
 * lists the archive again. Every listed venue therefore needs a walk on a
 * cadence, however cheap its updates are.
 *
 * **The cadence is a cost, and so it belongs to the venue.** A walk of binance
 * is 202,911 requests and one of bybit's first host 3,693; the same interval
 * cannot be right for both. Each adapter states its own, with the measurement
 * beside it.
 *
 * A venue that has never walked is handed `Infinity` and walks now, which needs
 * no special case here: it is overdue by any cadence.
 */
export const walkEvery = (days: number): Recurs =>
  (sinceWalk) => (sinceWalk >= days * DAY_SECONDS ? 'walk' : 'update');

const DAY_SECONDS = 86_400;

/**
 * A walking update on one day of the week, and probing on the others.
 *
 * **A weekday rather than an interval**, so that two venues given different days
 * never walk on the same night, however their passes drift: an interval counted
 * from each venue's last walk wanders, and two of them meet sooner or later.
 *
 * **Guarded by `WALK_GAP_HOURS`**, because a day is not a pass. A second pass
 * on the same day — an update asked for by hand, or one the schedule brings
 * round early — would otherwise walk again, and a walk that ran long could
 * stretch into the next week's day and be followed by another at once. A day
 * missed altogether waits for the next one, which costs a week of discovery and
 * nothing else.
 *
 * Read in UTC, like every other clock in this service.
 */
export const walkOn = (day: Weekday): Recurs =>
  (sinceWalk, now) => (sinceWalk > WALK_GAP_HOURS * 3_600 && now.getUTCDay() === WEEKDAYS.indexOf(day)
    ? 'walk' : 'update');

/** The least time between two walks, however the calendar falls. */
const WALK_GAP_HOURS = 72;

const WEEKDAYS: readonly Weekday[] =
  ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
