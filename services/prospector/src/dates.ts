import type { Grain } from './types';

/**
 * The date arithmetic a venue's bounds are walked with.
 *
 * Nothing here is one venue's: a month is a month, and "the last grain that can
 * hold a complete file" is the same question for every archive that publishes on
 * a clock. It lived inside okx's scanner only because okx was the first to need
 * it.
 */

// ── Months ────────────────────────────────────────────────────────────────────

/**
 * Last month worth asking about: monthly files appear only once a month closes.
 *
 * **Computed, not written down.** A fixed month stops being the last closed one
 * the moment the calendar passes it, and a range with no recorded end runs to
 * here — so frozen, generation would stop producing new keys the month after
 * somebody wrote the constant.
 */
export const ceiling = (now = new Date()): string => {
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  return `${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
};

/**
 * The last complete day, which is the daily equivalent of `ceiling` and bounds
 * generation the same way.
 *
 * Today is not a missing file, it is an unfinished one — and a day the venue
 * publishes late costs nothing here: a dropped candidate is re-emitted by the
 * next walk, because the generator builds the whole keyspace from the bounds
 * rather than from what survived last time.
 */
export const yesterday = (now = new Date()): string => {
  const at = new Date(now.getTime() - 24 * 60 * 60_000);

  return at.toISOString().slice(0, 10).replace(/-/g, '');
};

/** The month a `yyyymmdd` falls in. */
export const monthOf = (ymd: string): string => ymd.slice(0, 6);

export const dash = (ym: string): string => `${ym.slice(0, 4)}-${ym.slice(4)}`;

export const nextMonth = (ym: string): string => shift(ym, 1);
export const prevMonth = (ym: string): string => shift(ym, -1);

const shift = (ym: string, by: number): string => {
  const at = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(4)) - 1 + by, 1));

  return `${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
};

export const daysIn = (ym: string): string[] => {
  const last = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(4)), 0)).getUTCDate();

  return Array.from({ length: last }, (_v, i) => String(i + 1).padStart(2, '0'));
};

// ── Grains ───────────────────────────────────────────────────────────────────

/**
 * The next period at this grain.
 *
 * Days, hours and minutes all step through `Date`, which carries the month and
 * year over for us; only the month has to be done by hand, having no fixed
 * length to add.
 *
 * **Shared because two things now step a calendar.** Generation walks forward
 * from a tip building keys; a tip walks forward over the keys that came back.
 * They have to agree on what "the next grain" is or a tip closes a run the
 * generator never opened.
 */
export const nextPeriod = (at: string, grain: Grain): string => {
  if (grain === 'monthly') return nextMonth(at);

  return stamp(new Date(instant(at) + STEP[grain]), grain);
};

/**
 * The period before this one, at its grain.
 *
 * **What a bound below a bound is.** A tip says everything at or below it is
 * settled, so stating that a series begins at `first` is stating that the period
 * *under* `first` is where nothing more will be asked — which is the one place
 * this is needed, and the reason it is not simply `nextPeriod` in reverse at the
 * call site.
 */
export const prevPeriod = (at: string, grain: Grain): string => {
  if (grain === 'monthly') return prevMonth(at);

  return stamp(new Date(instant(at) - STEP[grain]), grain);
};

/**
 * A bound stated at any grain, read at a given one.
 *
 * A coarser bound means the whole of its grain, so `202403` as a start is the
 * 1st of it and hour 00 of the 1st — and a finer one is simply the grain it
 * falls in. Both directions matter: a venue's own floor is often a month while
 * the series that reads it is hourly.
 */
export const atGrain = (at: string, grain: Grain): string => {
  const width = WIDTH[grain];

  return at.length >= width ? at.slice(0, width) : (at + FLOOR.slice(at.length - 6)).slice(0, width);
};

/**
 * The last grain that can hold a complete file.
 *
 * Today's file is unfinished rather than late, and this hour's more so — so each
 * grain stops one grain short of now.
 */
export const lastClosed = (grain: Grain, now = new Date()): string => {
  if (grain === 'monthly') return ceiling(now);

  return stamp(new Date(now.getTime() - STEP[grain]), grain);
};

/** How many characters a stamp of each grain carries. */
export const WIDTH: Record<Grain, number> = { monthly: 6, daily: 8, hourly: 10, minutely: 12 };

/**
 * How long after a period closes a missing file is still merely late.
 *
 * **Fifteen days, against a longest documented wait of one to seven.** Gate
 * publishes a month's files on the first Monday of the next one, which is the
 * slowest promise any venue here makes; the lags actually measured are hours for
 * dailies and days for monthlies. Fifteen is twice the worst of those and still
 * short enough that a venue's ordinary lateness is never mistaken for absence.
 *
 * **Being wrong here is cheap in the direction it fails.** A file that turns up
 * on the sixteenth day is found by the next full refresh, which re-reads the
 * keyspace and owes nothing to any tip. Waiting longer instead costs a probe per
 * gap per pass, on every series that has one, for as long as the wait lasts.
 *
 * **One number, three readers**, all asking the same question — *is this late,
 * or is it never?* — so none of them may answer it differently:
 *
 * - reconciliation lifts every tip to `TODAY - OVERDUE_DAYS`, which is what
 *   retires an absence for good
 * - the preamble starts a new or relisted series `OVERDUE_DAYS` below the
 *   newest date the last completed update covered
 * - a first pass over a seeded venue stops leaving out the span a seed proved
 *   empty `OVERDUE_DAYS` below the day that seed was built
 *
 * A walk has no use for it. A walk read the index, so an absence it saw is a
 * fact rather than a wait.
 */
export const OVERDUE_DAYS = 15;


/**
 * The instant a period was over, and its file could first have existed.
 *
 * **The due date, never the stamp.** A stamp names when a period *began*, so
 * comparing it against a deadline reads a monthly file as a month older than it
 * is — and asks whether July's file is late halfway through July. What can be
 * late is a period that has ended, so that is what is measured.
 */
export const dueAt = (at: string, grain: Grain): number =>
  instant(nextPeriod(atGrain(at, grain), grain));

/**
 * The last period of this grain that closed long enough ago to be settled.
 *
 * **Where reconciliation puts a tip.** A completed update pass generated every
 * URL it owed and drained its queue, so an absence it saw is real — except at
 * the very edge, where a period may simply not have been published yet. This is
 * where that edge falls, and lifting every tip to it is what retires an absence
 * for good.
 *
 * A walk has no use for it: a walk read the index, so its absences are settled
 * the moment it sees them.
 */
export const lastSettled = (grain: Grain, asOf: Date): string =>
  lastClosed(grain, new Date(asOf.getTime() - OVERDUE_DAYS * 86_400_000));

/**
 * What a stamp too coarse for its series fills with: the **first** day, hour and
 * minute of the grain it names, since a month as a bound means from the start
 * of that month. Sliced from the character the stamp ran out at — the first day
 * is `01` where the first hour is `00`, so it cannot be one repeated character.
 */
const FLOOR = '010000';

/** How long one grain lasts, for the grains a calendar does not complicate. */
const STEP: Record<Exclude<Grain, 'monthly'>, number> = {
  daily:    86_400_000,
  hourly:    3_600_000,
  minutely:     60_000,
};

/** A stamp read as an instant, and an instant written back at a grain. */
export const instant = (at: string): number =>
  Date.UTC(+at.slice(0, 4), +at.slice(4, 6) - 1, +at.slice(6, 8),
    +(at.slice(8, 10) || 0), +(at.slice(10, 12) || 0));

const stamp = (on: Date, grain: Grain): string =>
  on.toISOString().replaceAll('-', '').replace('T', '').replaceAll(':', '')
    .slice(0, WIDTH[grain]);
