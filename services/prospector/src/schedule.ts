import { existsSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * On which days of the month each venue's update is a walk.
 *
 * **Updating finds no shape that did not exist before.** Generation asks only
 * about series the catalog already holds, at patterns it already knows, so a
 * dataset a venue adds — or a naming it changes — is invisible until something
 * lists the archive again. A walk is that reading, and on a slow link a walk of
 * a large venue is days: how often to afford one is a fact about where this
 * runs, not about the venue. So it is written down per deployment, in a file
 * beside the code that is not part of it.
 *
 * ```yaml
 * binance: 15        # walks on the 15th
 * bitget: 1,10,20    # on the 1st, the 10th and the 20th
 * gate:              # never: every update generates
 * ```
 *
 * **The file is optional, and so is every line of it.** A venue it does not
 * name walks once a month, on the day that is its own number — the lowest id
 * its servers have in the `venue` table — so that venues nobody scheduled do
 * not all walk the same night. Only a venue that can be listed has the choice;
 * one that cannot is never walked and may not be named.
 *
 * **A walk is run when it is due, not on its day.** This service can be down
 * for days. So the question asked at each update is whether a scheduled day has
 * come round since the last walk began — see `walkIsDue`.
 */

/** The file's name, in the service's `src/`. */
export const SCHEDULE_FILE = 'walk-schedule.yaml';

/** Where the schedule is read from: `src/` of this service, whether this runs from `src/` or from `dist/src/`. */
export const schedulePath = (): string =>
  join(__dirname, ...(__dirname.includes(`${sep}dist${sep}`) ? ['..', '..'] : ['..']), 'src', SCHEDULE_FILE);

/**
 * The days each walkable venue walks on: what the file says, and the default
 * for every venue it leaves out. Throws, saying what is wrong and on which
 * line, where the file is there and cannot be taken as written.
 *
 * `walkable` is every venue that can be listed, with the lowest id of its
 * servers; `known` every venue there is, so that a venue that exists and
 * cannot be walked is told apart from a name that is nobody's.
 */
export const loadSchedule = (
  path:     string,
  walkable: ReadonlyMap<string, number>,
  known:    readonly string[],
): Map<string, number[]> => {
  const said     = existsSync(path) ? parse(readFileSync(path, 'utf8')) : new Map<string, number[]>();
  const schedule = new Map<string, number[]>();

  for (const venue of said.keys()) {
    if (! known.includes(venue)) throw new Error(`'${venue}' is not a venue — there are: ${known.join(', ')}`);

    if (! walkable.has(venue))
      throw new Error(`'${venue}' cannot be listed, so it is never walked and has no schedule to set`);
  }

  for (const [venue, id] of walkable) schedule.set(venue, said.get(venue) ?? [((id - 1) % LAST_DAY) + 1]);

  return schedule;
};

/** Take this schedule as the one in force. */
export const applySchedule = (schedule: ReadonlyMap<string, readonly number[]>): void => {
  inForce = new Map([...schedule].map(([venue, days]) => [venue, [...days]]));
};

/** The days a venue walks on; none where it never does, or has no schedule. */
export const walkDaysOf = (venue: string): readonly number[] => inForce.get(venue) ?? [];

/**
 * Whether an update due now should be a walk.
 *
 * **Since the last walk began, has one of its days come round?** The newest
 * scheduled day that is today or earlier is the one that counts, taken at its
 * first instant, UTC: a walk that began before it has not covered it. Asked
 * that way a walk missed while nothing was running is made up at the next
 * update, and a day that came round once is walked once.
 *
 * **Never within a day of the last one**, whatever the dates say: a walk that
 * began yesterday evening and a scheduled day beginning at midnight are one
 * walk, not two.
 *
 * `sinceWalk` is how long ago the last walk began, in seconds — `Infinity`
 * where there has never been one, which is overdue on any schedule that has a
 * day in it.
 */
export const walkIsDue = (days: readonly number[], sinceWalk: number, now: Date): boolean => {
  if (days.length === 0) return false;
  if (sinceWalk === Infinity) return true;
  if (sinceWalk <= APART_SECONDS) return false;

  const due = lastDueDay(days, now);

  return due !== null && now.getTime() - sinceWalk * 1000 < due;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** The last day of the month a walk can be set for: one every month has, February aside. */
const LAST_DAY = 30;

/** The least time between the starts of two walks of a venue. */
const APART_SECONDS = 24 * 3600;

/** How far back a scheduled day is looked for: past any month that lacks it. */
const LOOK_BACK_DAYS = 62;

let inForce = new Map<string, number[]>();

/** The first instant, UTC, of the newest scheduled day that is today or earlier; null where none is in reach. */
const lastDueDay = (days: readonly number[], now: Date): number | null => {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  for (let back = 0; back <= LOOK_BACK_DAYS; back++) {
    const at = today - back * 86_400_000;

    if (days.includes(new Date(at).getUTCDate())) return at;
  }

  return null;
};

/**
 * The file as written: a venue a line, `name: days`, the days whole numbers
 * parted by commas, or nothing for a venue that never walks. `=` is taken for
 * `:`, a `#` begins a comment, and a blank line is nothing.
 */
const parse = (text: string): Map<string, number[]> => {
  const said = new Map<string, number[]>();

  text.split(/\r?\n/).forEach((raw, at) => {
    const line = raw.replace(/#.*$/, '').trim();

    if (line === '') return;

    const where = `line ${at + 1} ("${raw.trim()}")`;
    const match = /^([A-Za-z][\w-]*)\s*[:=]\s*(.*)$/.exec(line);

    if (! match) throw new Error(`${where} is not of the form "venue: days"`);

    const [, venue, value] = match as unknown as [string, string, string];

    if (said.has(venue)) throw new Error(`${where} names '${venue}' a second time`);

    const days = value.replace(/^\[|\]$/g, '').split(',').map(one => one.trim()).filter(one => one !== '');

    for (const day of days)
      if (! /^\d+$/.test(day) || Number(day) < 1 || Number(day) > LAST_DAY)
        throw new Error(`${where}: '${day}' is not a day of the month from 1 to ${LAST_DAY}`);

    said.set(venue, [...new Set(days.map(Number))].sort((a, b) => a - b));
  });

  return said;
};
