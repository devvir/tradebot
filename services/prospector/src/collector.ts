import { logger } from '@devvir/service-kit';
import {
  countUnsettled, enrolment, establishedAt, everCompleted, lastRun, phaseOf, seriesCounts, standingOf,
  venueIds, venueTotals,
} from './catalog';
import { adaptersForVenue } from './venues';
import type { DatabaseSync } from 'node:sqlite';
import type { PauseAnswer, SurveyAnswer, SurveyState, Surveys, VenueStatus } from './types';

/**
 * What the collector API decides: which venues to start or pause, and how each
 * venue stands.
 *
 * **One verb for starting.** A venue with an open job continues it, one that is
 * complete updates, one that has never run starts — none of which is a
 * caller's decision. `refresh` throws the progress away first; `update` skips
 * the wait. They are the only decisions a caller makes.
 */

/**
 * Which venues a request is about: the ones it names, or all of them.
 *
 * **Named venues are checked against the registry, never against the catalog's
 * `venue` table**, which is written *by* a survey — on a fresh database it is
 * empty, and validating against it would mean no first survey could ever start.
 *
 * Answers `null` once it has already replied, so a caller returns rather than
 * deciding again what went wrong.
 */
export const venuesAsked = (named: unknown, known: readonly string[]): string[] | { unknown: string[] } => {
  const asked = named === undefined || named === null ? []
    : Array.isArray(named) ? named.map(String)
      : [String(named)];

  const unknown = asked.filter(one => ! known.includes(one));

  if (unknown.length > 0) return { unknown };

  return asked.length > 0 ? asked : [...known];
};

/**
 * Start or resume these venues' surveys, and say what became of each.
 *
 * It does not wait for the walk — a survey runs for hours, and `/status` is
 * where its progress lives. A venue that cannot be acted on is reported rather
 * than failing the request, because with several venues in one call some will
 * be busy and some will not.
 */
export const startSurveys = (
  db:      DatabaseSync,
  surveys: Surveys,
  asked:   readonly string[],
  refresh: boolean,
  forced:  boolean,
): SurveyAnswer => {
  const venues  = asked;
  const started: string[] = [];
  const resumed: string[] = [];
  const skipped: { venue: string; reason: string }[] = [];
  const doing:   { venue: string; phase: string }[] = [];

  /**
   * **Said on arrival, before any of the work.** Whoever sent this is watching
   * the log for it, and the passes themselves begin a turn later — see `survey`
   * in `index.ts` — so this is the line that says the order was received.
   */
  logger.info({ venues, refresh, update: forced }, 'Surveys requested — starting shortly');

  for (const venue of venues) {
    const ids = venueIds(db, venue);

    /**
     * **A forced update is refused where no pass has ever finished.** There is
     * nothing to update *from*: the venue is mid-walk, or has never run, and
     * what it needs is the walk it is already owed rather than a second kind of
     * pass planned against bounds nothing has established.
     *
     * **Whether it is paused makes no difference to that.** A pause during the
     * walk fails for the ordinary reason, and one during an update is the case
     * below — the pause is not the question, what it interrupted is.
     */
    if (forced) {
      if (! ids.some(id => everCompleted(db, id))) {
        skipped.push({ venue, reason: 'no pass has completed — walk it first' });

        continue;
      }

      const open = ids.some(id => enrolment(db, id).open === 'update');

      /**
       * **An update open and being worked is already what was asked for**, and
       * a loop does not end on its own, so there is nothing to add to it.
       */
      if (open && surveys.running(venue)) {
        skipped.push({ venue, reason: 'already updating' });

        continue;
      }

      /**
       * **An update open with nothing working it is resumed, and reported as a
       * resume.** From outside the two are identical and they are not the same
       * thing: this carries on from partition cursors that already exist, where
       * a new update would plan fresh scopes. Somebody told "update started"
       * about work that was half done has been told the wrong thing.
       *
       * That is what a pause during an update leaves, and equally what a killed
       * container leaves — neither needs its own rule.
       */
      if (open) resumed.push(venue);
    }

    /**
     * **A venue already surveying is already doing what was asked**, since the
     * loop that keeps it current day after day does not end on its own. So an
     * ordinary request adds nothing and says so, rather than starting a second
     * loop against the same host.
     *
     * The modifiers are the exceptions, and the only ones: a refresh is the
     * request to throw the progress away and a forced update the request to stop
     * waiting, and both mean stopping the loop first. That sequencing belongs
     * where the loop is — see `survey` in `index.ts` — because interrupting from
     * out here would drop rows a live walk is still committing against.
     */
    if (surveys.running(venue) && ! refresh && ! forced) {
      skipped.push({ venue, reason: 'already running' });

      continue;
    }

    surveys.start(venue, forced ? 'partial' : 'full', refresh);

    if (! resumed.includes(venue)) started.push(venue);

    // Read for the answer rather than to decide: a caller wants to know whether
    // this is a backfill or a catch-up, and nothing else in the reply says.
    doing.push({ venue, phase: refresh ? 'not run' : (ids.map(id => phaseOf(db, id))[0] ?? 'not run') });
  }

  /**
   * **A venue with nothing to do says what it *is*, not what we declined to do
   * to it.** The answer goes back over HTTP, but whoever restarted the service
   * is reading the log, and silence there is indistinguishable from a venue that
   * was forgotten. "Not surveyed" reads as neglect; the fact is the opposite —
   * it was surveyed already, and that is the result worth stating.
   */
  for (const one of skipped)
    logger.info({ venue: one.venue }, STATE[one.reason] ?? `Not surveyed: ${one.reason}`);

  /**
   * **A modifier that moved nothing is a failed request, not an empty success.**
   *
   * An ordinary request finding every venue current has done its job — that is
   * the venue already being kept up to date. A `update: true` that started
   * nothing means the one thing it was for did not happen, and answering 200 to
   * that puts the reason in a field somebody has to go and read.
   */
  if (forced && started.length === 0 && resumed.length === 0) {
    const why = skipped.length === 1 ? `Nothing to update: ${skipped[0]!.reason}` : 'Nothing to update';

    return { refused: why, skipped };
  }

  return {
    at: new Date().toISOString(),
    started,
    resumed,
    skipped,
    phases: Object.fromEntries(doing.map(one => [one.venue, one.phase])),
  };
};

/**
 * Stop surveys where they are. There is no matching resume: starting a paused
 * venue *is* resuming it, since a pause keeps every cursor.
 */
export const pauseSurveys = (surveys: Surveys, asked: readonly string[]): PauseAnswer => {
  const paused:  string[] = [];
  const skipped: { venue: string; reason: string }[] = [];

  for (const venue of asked)
    if (surveys.pause(venue)) paused.push(venue);
    else skipped.push({ venue, reason: 'not running' });

  if (paused.length > 0) logger.info({ venues: paused }, 'Pause requested');

  return { at: new Date().toISOString(), paused, skipped };
};

/** How every venue stands — or one — with the figures as the rollups hold them. */
export const statusOf = (db: DatabaseSync, surveys: Surveys, only?: string): VenueStatus[] => {
  /** One pass for every venue, rather than one filtered scan per venue. */
  const counts = seriesCounts(db);

return venueTotals(db)
  .filter(row => ! only || row.venue === only)
    .map(row => {
      const ids = venueIds(db, row.venue);

      return {
        ...row,
        established: establishedFor(db, row.venue),
        lastRun:     lastRun(db, ids),

        /**
         * **How far the venue has got, per series.** Summed over its servers:
         * a venue listed once here may be several ids, and the progress a
         * reader wants is the venue's rather than one server's.
         */
        series:      ids.reduce((sum, id) => {
          const held = counts.get(id);

          return {
            withFiles: sum.withFiles + (held?.withFiles ?? 0),
            total:     sum.total     + (held?.total     ?? 0),
          };
        }, { withFiles: 0, total: 0 }),

        /**
         * **One word for where the venue stands, and the facts behind it.**
         *
         * This used to report an open job beside a boolean and leave the
         * reader to work out the rest, which could not distinguish the two
         * states a person most needs to tell apart: a venue between passes and
         * a venue nobody has ever asked about both showed as not surveying.
         */
        ...starting(standingOf(db, row.venue, ids, surveys.everyMs()), surveys.passing(row.venue)),

        /**
         * **Whether this process has a loop alive**, which is not the same as
         * work being outstanding. An open job with nothing surveying is what a
         * killed container leaves behind; the pair is kept side by side
         * because they want opposite responses.
         */
        surveying:   surveys.running(row.venue),

        /** Asked to stop, and still finishing the page it was on. */
        stopping:    surveys.stopping(row.venue),

        /**
         * **Whether a pass has ever finished here**, which is the whole of
         * what separates starting a venue from updating one.
         *
         * **Said instead of leaving it to be inferred.** A reader working it
         * out from `listable` gets it wrong on the two venues that cannot be
         * listed — their first pass is an update and reads as one — and a
         * reader working it out from the newest run's `kind` gets it wrong on
         * any venue that re-reads itself by walking. Neither of those is a
         * caller's business: which way a venue is read is this service's, and
         * this is the part outside it.
         *
         * **Every one of the venue's servers, not any.** Bybit publishes from
         * two, and a venue whose second host has never finished a pass has not
         * been surveyed before — it is half read. Asking `some` made it report
         * as surveyed the moment the smaller host finished, while the other was
         * still hours into its first walk.
         */
        completedEver: ids.every(id => everCompleted(db, id)),

        /**
         * **Whether there is a keyspace to walk at all.**
         *
         * A venue whose bucket refuses `ListObjects` has none: its series are
         * declared and every pass is an update over them, so a re-survey has
         * nothing to re-read. Saying so here is what stops a caller offering
         * work that cannot happen — see okx and bitget, where `refresh` drops
         * the run rows and the walk that follows finds nothing to walk.
         *
         * A venue listed here with no adapter at all is not listable either:
         * nothing can walk it, whatever the reason.
         */
        listable:    adaptersForVenue(row.venue).some(one => one.listable !== false),

        /**
         * **Whether this venue parks candidates at all**, which is what makes
         * an empty backlog mean something.
         *
         * Zero reads as *nothing outstanding* — fine for a venue that probes,
         * and misleading for one whose listing states everything, where the
         * column is not empty but inapplicable. A venue probes when its
         * listing cannot speak for a file, and any venue does while it is
         * generating keys, so the pass counts as well as the adapter.
         */
        probing:     adaptersForVenue(row.venue).some(one => one.probes === true)
          || lastRun(db, ids).kind === 'update',
        wip:         ids.reduce((total, id) => total + parked(db, id), 0),
      };
    });
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * What a skipped venue actually is, said as a fact rather than as a refusal.
 *
 * Keyed by the reason the API returns, because the two audiences want opposite
 * framings: a caller asked us to do something and needs to know why we did not,
 * while somebody reading the log after a restart needs to know the venue's
 * state. "Nothing to resume" answers the first and misleads the second — it
 * reads as neglect when it means finished.
 */
const STATE: Record<string, string> = {
  'nothing to resume':        'Survey already complete',
  'already running':          'Survey already running',
  'already updating':         'Update already running — nothing to bring forward',
  'a survey is already open': 'Survey already open — resume it rather than starting another',

  'no pass has completed — walk it first':
    'Update refused — no pass has finished, so there is nothing to update from',
};

/**
 * A venue whose pass has begun but has not opened its job yet.
 *
 * **Only where the rows would say `waiting`**, which is the one word that is
 * wrong while a pass is preparing: it is what a venue asleep between passes
 * says, and an update somebody had just ordered read as ignored for the whole
 * of the preamble — four minutes, on binance. A paused venue stays paused, and
 * one whose job is open already says what it is doing.
 */
const starting = <T extends { state: SurveyState; nextRun: string | null }>(standing: T, passing: boolean): T =>
  (passing && standing.state === 'waiting' ? { ...standing, state: 'starting', nextRun: null } : standing);

const establishedFor = (db: DatabaseSync, venue: string): string | null =>
  venueIds(db, venue)
    .map(id => establishedAt(db, id, ''))
    .filter((at): at is string => at !== null)
    .sort()[0] ?? null;

/**
 * How much of this venue's backlog is outstanding.
 *
 * **The maintained count, not a fresh one.** This runs for every venue on every
 * poll, and `count(*)` over a backlog of tens of millions froze the whole
 * process for nearly two seconds each time — see `catalog/wip.ts`.
 */
const parked = (db: DatabaseSync, venueId: number): number => countUnsettled(db, venueId);
