import { logger } from '@devvir/service-kit';
import { fault } from './faults';
import { surveyingAs } from './context';
import { preamble } from './preamble';
import {
  anyUnsettled, clearUpdate, closeWalk, countUnsettled, enrolment, establishedAt, openJob,
  phaseOf, producedSoFar, reconcile, unsettled, updateStarted, venueIdOf, walkedAt,
} from './catalog';
import { STEADY, describeWait, labelOf, paceFor } from './pace';
import { probeFiles } from './probe';
import { flushCounts } from './counts';
import { probing, surveyVenue } from './survey';
import type { DatabaseSync } from 'node:sqlite';
import type { Adapter, Config, Occasion, Phase, RunKind } from './types';

/**
 * One server's whole life: walk it, settle what walking could not state, and
 * stop when there is nothing left owed.
 *
 * **Apart from `index.ts` because it is the only part with a shape worth
 * testing.** Wiring a service up — open the database, register the venues, mount
 * the routes — is done once and observed by starting it. Deciding when a venue
 * is finished is a rule, it has been wrong twice, and a rule that cannot be
 * exercised without booting a process does not get exercised.
 */

/**
 * Keep one server up to date, for as long as this process runs.
 *
 * ```
 * [ walk ] → sleep → update → sleep → update → …     recurs 'update'
 * [ walk ] → sleep → walk   → sleep → walk   → …     recurs 'walk'
 * ```
 *
 * **A venue is never finished, only current.** The archives grow every day, so
 * reaching the end of one is not a state to stop in — it is the point at which
 * the cheap half becomes possible. The first pass is a walk where there is a
 * keyspace to read and an update where there is not; every pass after it is
 * whichever the adapter recurs by. An update by default, since by then the walk
 * is complete and only what has appeared since is owed; a walk again where
 * reading the listing costs fewer requests than asking series by series.
 *
 * **Nothing here decides which.** `onePass` reads where the venue has got to and
 * works it out, so this loop states the cadence and nothing else.
 *
 * The loop ends two ways: a pause, which leaves every cursor where it is, and a
 * refresh, which is a pause followed by throwing the run rows away and starting
 * over — see `survey` in `index.ts`.
 */
export const syncVenue = async (
  db:       DatabaseSync,
  adapter:  Adapter,
  config:   Config,
  occasion: Occasion,
  paused:   () => boolean = () => false,

  /**
   * When the first pass is due, where something already knows.
   *
   * **For a venue resumed on startup that was not mid-pass.** Its last pass
   * began at a known moment, so the next one is due an interval after that —
   * which is usually in the past, and then this waits for nothing. Left out, the
   * first pass runs immediately, which is what an explicit request means.
   */
  due:      number = 0,
): Promise<void> => {
  if (due > Date.now()) {
    logger.info({
      venue:   labelOf(adapter),
      nextRun: new Date(due).toISOString(),
    }, `Up to date; next update ${describeWait(due - Date.now())}`);

    await waiting(due - Date.now(), paused);

    if (paused()) return;
  }

  for (;;) {
    const fallback = Date.now();

    underway.set(adapter.name, (underway.get(adapter.name) ?? 0) + 1);

    try {
      await onePass(db, adapter, config, occasion, paused);
    } finally {
      const left = (underway.get(adapter.name) ?? 1) - 1;

      if (left > 0) underway.set(adapter.name, left);
      else underway.delete(adapter.name);
    }

    if (paused()) return;

    /**
     * **Measured from the start of the pass, not its end.** A pass that took
     * twenty hours has four left to wait; one that took thirty has none, and
     * goes straight round again. Otherwise a venue whose walk runs longer than
     * the interval would drift a day later on every turn.
     *
     * **Read from the run row rather than from a clock**, because a pass this
     * process *resumed* began before this process did. Timing it from the moment
     * it was picked up made a restart change a venue's cadence — the one thing
     * measuring from the start exists to prevent. Gate's walk ran 26.6 hours, so
     * its next update was due two hours before the walk finished; timed from the
     * resumption it would instead have slept another 22.
     *
     * It is also the source `dueFor` reads when a venue is picked up on startup,
     * so the two paths cannot answer the same question differently.
     *
     * The clock is a fallback for a pass that opened no job at all — a venue
     * with nothing to generate for — rather than for any ordinary case: a walk
     * and an update alike leave their `scope = ''` row behind, closed, which is
     * what reconciliation deliberately keeps.
     */
    const began = Date.parse(enrolment(db, venueIdOf(db, adapter.name, adapter.host ?? ''))
      .started ?? '') || fallback;

    const wait = Math.max(0, began + everyMs() - Date.now());

    logger.info({
      venue:  labelOf(adapter),
      hours:  Math.round(wait / 3_600_000),
      nextRun: new Date(Date.now() + wait).toISOString(),
    }, wait > 0 ? `Survey finished; next update ${describeWait(wait)}`
      : 'Survey finished; updating again now');

    await waiting(wait, paused);

    if (paused()) return;
  }
};

/**
 * Wait, but not through a pause.
 *
 * **A pause has to be answered while the venue is idle, which is most of its
 * life.** Between passes a venue sleeps for the whole interval — a day, and
 * rather longer while the seed rebuild raises it — and a plain `sleep` reads the
 * flag only once it is over. Asking to pause then appeared to do nothing: the
 * survey was recorded as stopping and went on reporting itself as running for
 * as long as the wait had left, because nothing was there to notice.
 *
 * So the wait is broken into beats. It costs one comparison a second and makes
 * a pause take effect in about that long, whatever the venue was waiting for.
 */
/**
 * Whether a pass is under way for this venue in this process — on any host.
 *
 * **What the rows cannot say.** A venue's state is read off its job rows, and a
 * job opens only once the preamble is done — listing instruments, writing new
 * series — which on binance took four minutes. Through all of it the venue read
 * as waiting, exactly like one asleep between passes, and an update somebody had
 * just asked for looked ignored. This is the one fact that tells them apart.
 *
 * Counted rather than flagged, because bybit runs a pass per host under one
 * venue name and either may be the one still going.
 */
export const inPass = (venue: string): boolean => underway.has(venue);

const underway = new Map<string, number>();

const waiting = async (ms: number, paused: () => boolean): Promise<void> => {
  const until = Date.now() + ms;

  while (Date.now() < until) {
    if (paused()) return;

    await sleep(Math.min(BEAT_MS, until - Date.now()));
  }
};

/** How often a wait looks up to see whether it is still wanted. */
const BEAT_MS = 1_000;

/**
 * When a venue whose last pass began at `started` is next due.
 *
 * **The interval runs from the start of a pass, not its end** — the same rule
 * the loop applies between its own passes, so a restart cannot change a venue's
 * cadence. A walk that took thirty hours is already overdue when it finishes,
 * and this says so by answering a time in the past.
 */
export const dueAfter = (started: string): number => Date.parse(started) + everyMs();

/**
 * How often a venue is brought up to date once it is synced.
 *
 * A day, because that is the grain the archives themselves move at: every venue
 * here publishes at most one file per series per day, so asking more often is
 * asking the same question twice.
 *
 * **Stated in hours, converted where a timer needs it.** The other waits in this
 * file are seconds and read naturally in milliseconds; this one is a cadence
 * somebody sets, and `86_400_000` is not a number anybody recognises as a day.
 */
const EVERY_HOURS = 24;

/** The same figure where a clock is being compared against. */
export const everyMs = (): number => EVERY_HOURS * 3_600_000;


/**
 * One pass: walk it or update it, settle what that could not state, and stop.
 *
 * **Which of the two happens is never asked for.** Where the venue has got to
 * decides it — a venue that has been complete recurs the way its adapter says,
 * for ever after — so the loop above passes the same occasion every time and
 * this works out what it means today.
 *
 * **The probe follows the walk rather than running beside it for ever.** While
 * indexing is under way the two are genuinely concurrent — a file found in the
 * first minute should not wait for the last partition — but a probe is finishing
 * the walk's work, so when there is no more of it coming the probe has an end:
 * drain the backlog, then stop. That is what makes a pass a thing that *ends*,
 * which is what lets the loop above have an interval at all.
 */
const onePass = async (
  db:       DatabaseSync,
  adapter:  Adapter,
  config:   Config,
  occasion: Occasion,
  paused:   () => boolean,
): Promise<void> => {
  /**
   * **What will actually run, decided here rather than inside the loop.**
   *
   * Where the venue is decides it, and the request only decides whether to start
   * over: a venue that has been complete recurs the way its adapter says, whatever
   * is asked for — see `passFor`. It matters at this level because probing has to
   * be started before the walk that feeds it, and an update always needs a probe.
   */
  const venueId = venueIdOf(db, adapter.name, adapter.host ?? '');
  const phase   = phaseOf(db, venueId);

  const now   = new Date();
  const doing = passFor(adapter, occasion, phase, openJob(db, venueId, 'update') !== null,
    sinceWalked(db, venueId, now), now);

  const probes = probing(adapter, doing);

  /**
   * **What the pass was asked and what that sent are written as it goes** — by
   * whatever is already writing a run, a page or a batch at a time. This is the
   * end of it: a pass that stopped for any reason at all writes what is left
   * onto the job it leaves open, since a count written after a job closes would
   * land on nothing.
   */
  try {
    return await passing(db, adapter, config, doing, probes, venueId, paused);
  } finally {
    flushCounts(db, adapter);
  }
};

/** `onePass` once it knows what it is doing. */
const passing = async (
  db:       DatabaseSync,
  adapter:  Adapter,
  config:   Config,
  doing:    Occasion,
  probes:   boolean,
  venueId:  number,
  paused:   () => boolean,
): Promise<void> => {
  /** Whether more unsettled rows are still arriving. The probe's only question. */
  let indexing = true;

  /**
   * **One scope around both halves**, because they run concurrently and share a
   * venue. Two of them would clear each other: whichever finished first would
   * take the venue off the record while the other was still working, and an
   * adapter rule asked after that would be told there is no pass at all.
   */
  return await surveyingAs(adapter, kindOf(doing), async () => {
    /**
     * **Whether this is a fresh pass or one being picked up.**
     *
     * Update rows existing at all means the last pass did not reach
     * reconciliation, which deletes them. Those rows are the generation record:
     * a partition per series, closed as its keys were written. Resuming means
     * honouring them — no preamble, no re-planning, and no series generated
     * twice.
     *
     * **However old it is.** Nothing here decides that an interrupted pass has
     * been sitting too long: an open job with nothing working it is what a
     * killed container leaves and what a pause leaves, and whatever its age,
     * resuming it continues from its cursors. Judging a paused walk stale is the
     * person's call, and `refresh` is how they say so — code guessing at it
     * means a venue quietly restarting a multi-day walk because a deployment sat
     * idle over a weekend, the expensive outcome, chosen by nobody.
     *
     * What the scopes were planned against having moved since costs one pass of
     * a narrower range, and the next pass widens it. Discarding the pass costs
     * everything it had already read.
     */

    /**
     * **Before the scopes are read, because it is what decides them.** A series
     * created after generation planned its job would not be generated for until
     * the pass after next; one created here is in the list the job is built
     * from.
     *
     * **Skipped on a resume**, where the scopes are already planned and a series
     * created now could not join them anyway. It ran when the pass began, and
     * asking the venue again would spend its API calls to learn nothing.
     *
     * Only an update, and only a venue that can be asked. A walk discovers by
     * reading, which is a better answer than any instrument listing, and a venue
     * with no `instruments` hook simply has nothing to add.
     */
    if (doing === 'partial' && updateStarted(db, venueId) === null) {
      const found = await preamble(db, adapter, venueId);

      if (found.listed > 0)
        logger.info({ venue: labelOf(adapter), ...found },
          found.refused
            ? 'Instrument listing skipped: names do not match the files'
            : 'Instruments checked');
    }

    /**
     * **Nothing awaits this for the length of the walk, so it must not reject.**
     *
     * The probe is started first and joined at the end, which on a backfill is
     * hours apart. A rejection in that gap has no handler attached yet, and an
     * unhandled rejection ends the process by default — so a fault here would
     * take the walk down with it, having thrown away every cursor since the
     * last committed page. `settle` already catches around its pass; this is
     * the outer guarantee that the promise itself cannot fail the service.
     */
    const draining = probes
      ? settle(db, adapter, () => indexing && ! paused(), paused).catch((err: unknown) => {
        logger.error({ ...fault(err), venue: labelOf(adapter) },
          'Probing failed; the walk continues');

        return false;
      })
      : null;

    /** Whether the generating half got to the end of what it owed. */
    let generated = false;

    try {
      generated = await tend(db, adapter, config, doing, paused);
    } finally {
      indexing = false;
    }

    const drained = await draining;

    /**
     * **A pass is complete when it generated everything it owed and drained what
     * that produced**, and only then is it worth anything to a bound.
     *
     * Every other ending returns here just the same — blocked, paused, a partition
     * that could not be read, a venue answering with something that is not an
     * answer — and none of them has checked the last `OVERDUE_DAYS`. Reconciling
     * over one of those would assert they were asked about when they were not, and
     * a tip does not come back.
     *
     * A walk never reconciles. It states its own bounds as it reads, and the
     * clock has nothing to add to an index that was read to the end.
     */
    /**
     * **A walk that left a backlog is not over until the backlog is.**
     *
     * Its keyspace has been read, but the rows the listing could not speak for
     * are in `wip` and unasked, and the job is the only durable record that they
     * are owed. Closed at the end of listing, the venue reads `waiting` with a
     * full backlog, the next pass is scheduled from a pass that has not
     * finished, and a restart in the gap finds nothing open and drains nothing —
     * the whole backlog waits for the next update to happen upon it. bybit left
     * 137,066 rows that way.
     *
     * So the walk closes here, where the drain has actually returned, and the
     * listing half leaves it open — see `surveyVenue`, which closes it itself
     * only where nothing will probe.
     */
    /**
     * **A pass is over when it generated everything it owed and drained what
     * that produced** — and where nothing probes, draining is not a thing that
     * has to happen, so a listing read to the end is the whole of it.
     */
    const finished = generated && ! paused() && (probes ? drained === true : true);

    if (! finished) {
      // A pause is asked for and already said so; only a pass that stopped on
      // its own is worth a warning.
      if (! paused())
        logger.warn({ venue: labelOf(adapter), doing, generated, drained: drained === true },
          'Pass unfinished');

      return;
    }

    /**
     * **Reconciliation is the same for either kind, so there is one of it.**
     * How the files arrived says nothing about what is owed afterwards: how long
     * to wait for what is still missing, which bounds the files disagree with,
     * and which series turned out to hold nothing. A walk stating its own tips
     * was that rule written a second time, in a second place, with a second
     * clock.
     *
     * **As of when this pass began**, which is what the pass measured the
     * archive against — reconciling to `now` would claim the hours or days it
     * spent running.
     */
    flushCounts(db, adapter);

    const moved = await reconcile(db, venueId, began(db, venueId));

    /**
     * **The last act, and the only thing that ends a pass.** Everything before
     * it is resumable; once the tips are settled there is nothing about the pass
     * left worth keeping, and leaving an update's rows would have the next one
     * resume a pass that is already over.
     */
    const cleared = doing === 'partial' ? clearUpdate(db, venueId) : 0;

    if (doing !== 'partial') closeWalk(db, venueId);

    logger.info({ venue: labelOf(adapter), ...moved, ...(cleared ? { cleared } : {}) },
      doing === 'partial'
        ? 'Update finished'
        : 'Walk finished');
  });
};

/**
 * When the pass that has just finished began.
 *
 * **Read off the run rows rather than timed here**, because a resumed pass began
 * before this process did, and what it measured the archive against is its own
 * start. The same field the cadence reads, so the two cannot disagree.
 */
const began = (db: DatabaseSync, venueId: number): Date =>
  new Date(Date.parse(enrolment(db, venueId).started ?? '') || Date.now());

/**
 * Which kind of pass runs, from the venue, what was asked, and where it stands.
 *
 * In order, and the order is the rule:
 *
 * - **A venue with no listing has nothing to walk**, so every one of its passes
 *   is an update — its series are declared rather than discovered.
 * - **An update asked for by name is an update.** That is the one request that
 *   says what kind of pass it wants.
 * - **A venue whose first walk is not behind it goes on walking.**
 * - **An update already open is finished**, whatever the venue recurs by. Its
 *   per-series rows are its progress and only reconciliation ends it; starting a
 *   walk over it would leave that job open for ever, and a venue's standing is
 *   read off which job is open. The phase cannot see it, since it is read off
 *   the walk rows of a venue that has any.
 * - **A venue that recurs by walking walks again** — a fresh job, since the last
 *   one is closed. Everything else updates.
 *
 * **The listing rule comes first on purpose.** A venue that cannot be listed
 * updates whatever it says, so an adapter deciding its own recurrence cannot
 * strand itself by answering `'walk'` where there is nothing to walk.
 */
const passFor = (
  adapter:    Adapter,
  occasion:   Occasion,
  phase:      Phase,
  updateOpen: boolean,
  sinceWalk:  number,
  now:        Date,
): Occasion => {
  if (adapter.listable === false) return 'partial';
  if (occasion === 'partial')     return 'partial';
  if (phase !== 'updating')       return 'full';
  if (updateOpen)                 return 'partial';

  return recursBy(adapter, sinceWalk, now) === 'walk' ? 'full' : 'partial';
};

/**
 * What this venue says its pass is, whether it says it once or per pass.
 *
 * A venue that says nothing updates, which is what every venue did before any of
 * them had an opinion.
 */
const recursBy = (adapter: Adapter, sinceWalk: number, now: Date): 'update' | 'walk' =>
  (typeof adapter.recurs === 'function'
    ? adapter.recurs(sinceWalk, now)
    : adapter.recurs ?? 'update');

/**
 * How long ago this venue's last walk began, in seconds — `Infinity` where it
 * has never walked, which reads as overdue by any cadence.
 */
const sinceWalked = (db: DatabaseSync, venueId: number, now: Date): number => {
  const at = walkedAt(db, venueId);

  return at === undefined ? Infinity : (now.getTime() - Date.parse(at)) / 1000;
};

/** Which rows a survey of this kind keeps its progress in. */
const kindOf = (occasion: Occasion): RunKind =>
  (occasion === 'partial' ? 'update' : 'walk');

/**
 * Never retry faster than this, so a venue that cannot be reached cannot spin.
 *
 * **A failure is retried for as long as the service runs.** There is no attempt
 * limit and nothing gives up, because there is no failure here that stays failed
 * — a prefix that no longer exists answers with an empty listing rather than an
 * error, so what is left is transient (a 5xx, a 429, a reaped connection) or
 * venue-wide, and both are cured by asking again later.
 *
 * The cost of being wrong about that is a warning every half minute, naming the
 * partition, while its siblings finish and go quiet. That is loud enough to find
 * without any bookkeeping to support it.
 */
const FLOOR_MS = 30_000;

/**
 * Take one venue as far as it goes, and stop.
 *
 * **Two states, one question.** Either a job is open, in which case it is
 * continued, or none is, in which case one is opened. Nothing here consults a
 * clock: this loop exists to finish what it was asked for, not to decide when to
 * ask — see `index.ts` for why that decision is not this service's.
 *
 * A first pass is not a third state. A venue nobody has established simply has
 * no open job, so one is opened, and what follows is an ordinary job.
 *
 * So the loop turns for one reason only: something is still outstanding. A pass
 * that leaves the job open comes straight back to it — after `FLOOR_MS`, so a
 * venue that cannot be reached cannot spin — and the loop returns the moment the
 * job closes, the venue is paused, or the venue is blocking us for longer than a
 * wait.
 *
 * **One loop per venue, not one loop over venues.** Venues are unrelated hosts
 * that already survey concurrently; sequencing them would make every venue wait
 * behind the largest. With a loop each, a three-hour binance pass delays nothing.
 *
 * Everything the loop decides comes from the catalog rather than from state this
 * process holds, so a restart changes nothing: an interrupted job keeps its
 * cursors and resumes when it is next asked to.
 */
const tend = async (
  db:       DatabaseSync,
  adapter:  Adapter,
  config:   Config,
  occasion: Occasion,
  paused:   () => boolean,
): Promise<boolean> => {
  for (;;) {
    /**
     * **A pause ends the loop rather than shortening it.** Everything is
     * committed and every partition keeps its cursor, so there is nothing to
     * wait for — the venue simply goes idle with its job open, which is what
     * starting it again continues from.
     */
    if (paused()) return false;

    try {
      const venueId = venueIdOf(db, adapter.name, adapter.host ?? '');
      const open    = openJob(db, venueId, kindOf(occasion));

      logger.info({
        venue: labelOf(adapter),
        phase: phaseOf(db, venueId),
        doing: occasion,
        ...(open ? { resuming: open.started } : { established: establishedAt(db, venueId, '') }),
      }, 'Surveying venue');

      const pass = await surveyVenue(db, adapter, config, occasion, paused);

      if (pass.paused) return false;

      /**
       * **A blocked venue is waited out, not retried.** The floor below is half
       * a minute, which against a ban is just a faster way of staying banned —
       * it lapses only while nothing is asking.
       *
       * The wait is whatever the venue's gate still has to run, not a second
       * stand-down on top of it: the gate was latched the moment the block was
       * seen and is already holding every request, so counting the same pause
       * twice would double it.
       */
      if (pass.blocked) {
        const held = paceFor(adapter, adapter.base).blockedFor();

        logger.warn({ venue: labelOf(adapter), minutes: Math.round(held / 60_000) },
          `Blocked by venue; walking again ${describeWait(held)}`);

        await waiting(held, paused);

        continue;
      }

      /**
       * **Done means every partition finished, not that the pass is over.** A
       * partition that could not be read keeps its cursor and stays open, so the
       * next turn retries exactly that one — one listing request, not a
       * re-mapping — and the loop ends only when none is left.
       *
       * An update's rows outlive this. Generation being done is not the pass
       * being done: the keys it wrote are still in `wip`, and what ends the pass
       * is reconciliation deleting the rows.
       */
      if (pass.generated) {
        const { venue: _venue, ...counts } = pass;

        /**
         * **Indexed is not synced on a pass that probes.** Generating or
         * indexing states only that the keyspace has been covered; whether those
         * files are there, and what they are, is still owed. Saying "complete"
         * here would announce a venue as done with its whole backlog
         * unestablished — so the probe says it instead, once that backlog is
         * gone.
         *
         * **The pass decides, not the adapter.** Read off `adapter.probes` alone
         * this was wrong for every update on a listing venue, which probes
         * because it generated its keys rather than because the venue needs it.
         */
        logger.info({ venue: labelOf(adapter), ...counts },
          probing(adapter, occasion)
            ? 'Candidates generated; probing them'
            : 'Survey complete');

        return true;
      }
    } catch (err) {
      // One venue's archive going missing is not a reason to abandon it, nor to
      // hammer it. Whatever the survey managed is committed, and its partitions
      // resume from their cursors on the next attempt.
      logger.error({ ...fault(err), venue: labelOf(adapter) }, 'Venue survey failed');
    }

    await waiting(FLOOR_MS, paused);
  }
};

/**
 * How long to wait when the backlog is empty **and the walk is still running**.
 *
 * The only case there is anything to wait for. A walk writes rows continuously,
 * so an empty backlog means the probe has caught up with it for a moment — not
 * that there is nothing to do. Waiting a quarter of an hour on that turned a
 * venue's probing into fifteen-minute bursts against a walk that never stopped
 * producing, and left files unsettled for no reason.
 *
 * Short, because the only cost of looking again is one query against `wip`.
 */
const PROBE_EMPTY_MS = 30_000;



/**
 * Settle this venue's metadata until there is nothing left owed.
 *
 * **The work list is a query, so there is no state to keep.** A pass asks for
 * the files that still have no checksum, oldest first, and settles them; a row
 * leaves that list by being settled, so the query itself is the cursor and a
 * restart resumes by asking again. Nothing is written down, because nothing
 * needs to be.
 *
 * A pass ends when the query comes back empty, and the next one starts from the
 * beginning — which is what picks up files a walk has found since, and rows the
 * last pass could not settle.
 *
 * **`indexing` is the whole of the lifecycle.** While it holds, rows are still
 * arriving and an empty pass means only *not yet*, so the loop waits
 * `PROBE_EMPTY_MS` and asks again. Once it drops the backlog is all there will
 * ever be, and the loop is draining it: it runs until the backlog is empty, and
 * announces the venue exactly as a walk-only venue announces itself.
 *
 * **A backlog is a reason to keep going, not a reason to sleep.** A round that
 * left rows outstanding goes straight back round, because sleeping there is what
 * left a walk's output sitting in `wip` for quarter-hours at a time. Only an
 * empty backlog waits, and only while the walk is still running.
 *
 * That does not weaken the attempt count a row carries. Attempts are meant to be
 * spread across days, and they are — by a row leaving `wip` and being generated
 * again by the *next update*, not by pauses inside one pass. See `judge` in
 * `probe.ts`.
 */
const settle = async (
  db:       DatabaseSync,
  adapter:  Adapter,
  indexing: () => boolean,

  /** Defaulted so a caller with nothing to stop need not say so. */
  paused:   () => boolean = () => false,
): Promise<boolean> => {
  /**
   * Rounds in a row that settled nothing and retired nothing.
   *
   * **Only ever reported, never acted on.** A round that merely advanced attempt
   * counts is making progress — that is what confirming an absence looks like —
   * and a round that truly moved nothing is a venue misbehaving, which is worth
   * saying and is not worth a rule.
   */
  let stalled = 0;

  for (;;) {
    /**
     * **A pause stops the drain where it is, backlog and all.** The loop's only
     * other exit is an empty backlog, so without this a venue with rows left to
     * settle could not be paused at all: the flag was set, nothing read it, and
     * the survey reported itself as running and stopping for ever.
     *
     * **This alone is not enough**, which is why the flag is handed to the pass
     * as well. A round here is one whole pass, and a pass ends only when the
     * backlog does — a week on a venue whose keys are constructed. Read only at
     * this point, a pause was a week away from being acted on.
     *
     * Answering `false` is the truth — nothing was drained — and it is what
     * stops the caller reconciling over a pass that did not finish.
     */
    if (paused()) return false;

    // A thrown pass is a fault, not a refusal — retried at the ordinary interval
    // rather than stood down on.
    let refused   = false;
    let faulted   = false;
    let standDown = STEADY.standDownMs;

    /** What this pass took off the backlog, and what is left on it. */
    let moved = 0;
    let left  = 0;

    /** Whether the backlog itself still holds anything — the table's own answer. */
    let owed  = false;

    /** Whether the venue is answering about keys, as opposed to merely answering. */
    let working = false;

    try {
      const venueId = venueIdOf(db, adapter.name, adapter.host ?? '');
      /**
       * A timid default, then what the venue knows about itself, then the one
       * thing the deployment is allowed to say.
       *
       * **Two different things, and only one of them is a limit.**
       *
       * `perSecond` is the cadence, and it is what a venue would object to. It
       * lives in the adapter beside the evidence for it and nothing here can
       * raise it — bybit's 30 was earned by being turned away.
       *
       * `concurrency` is not a limit at all. It is how many requests may be in
       * flight so that the cadence can actually be reached: at one at a time,
       * 100/s is unreachable whatever the gate allows, because a request spends
       * most of its life waiting. It cannot breach the cadence, since every
       * request passes that gate regardless.
       *
       * **Nothing narrows it for probing in particular.** A probe and a listing
       * are the same thing to a host — one request, one socket, one ticket from
       * the machine's pool — and that this link is shared with something else is
       * what the pool answers, for every caller at once.
       */
      const pacing = { ...STEADY, ...adapter.pacing };

      const pass = await probeFiles(db, adapter, {
        next:      (after, limit) => unsettled(db, venueId, after, limit),
        remaining: ()             => countUnsettled(db, venueId),

        /**
         * **Whichever half is producing.** A walk feeding a probing venue and a
         * generator building keys write to the same column, so this reads the
         * open job of either kind without having to know which is running.
         */
        produced:  ()             => producedSoFar(db, venueId, 'walk')
          ?? producedSoFar(db, venueId, 'update'),
      }, pacing, paused);

      /**
       * **Said by the pass, so the drain does not have to wait to ask again.**
       * Falling through would work — the check above catches it next time round
       * — but a pass that stopped without settling anything sleeps first, and a
       * pause that takes effect after an idle wait looks like one that was
       * ignored.
       */
      if (pass.stopped) return false;

      /**
       * **The pass says whether it gave up; nothing here guesses.** A pass that
       * settled thousands of rows and was then blocked has the same counts as
       * one that finished, so inferring it from `settled` and `refused` reports
       * the venue that just turned us away as idle and comes back in the
       * ordinary fifteen minutes.
       */
      refused = pass.abandoned;

      /**
       * **Both halves of progress, because a drain ends on either.** A row
       * leaves the backlog by being settled or by being given up on, and a
       * venue whose keys are constructed does far more of the second — so
       * counting only settlements would read a pass that retired ten thousand
       * dead candidates as having done nothing.
       */
      moved = pass.settled + pass.dropped;

      /**
       * **What is left is asked of the table, not of the counter.** `left` is
       * reported; `owed` decides. They are the same number whenever the counter
       * is right, and when it is not, a pass that ends on the counter waits on a
       * backlog nobody has — which is what okx and bitget did for a day, eight
       * thousand and sixty rows past an empty table.
       */
      owed  = anyUnsettled(db, venueId);
      left  = countUnsettled(db, venueId);

      /**
       * **Confirming counts as working**, even though it moves nothing. A venue
       * repeating that a key is not there is on its way to an answer; one
       * repeating a 5xx is not, and only this tells them apart.
       */
      working = pass.absent > 0;
      stalled = moved > 0 || working ? 0 : stalled + 1;

      // Held by the gate already when a block is what stopped it; the venue's
      // own figure when the pass gave up for its own reasons instead.
      const held = paceFor(adapter, adapter.base).blockedFor();

      standDown = held > 0 ? held : pacing.standDownMs;
    } catch (err) {
      faulted = true;

      logger.error({ ...fault(err), venue: labelOf(adapter) }, 'Probe pass failed');
    }

    /**
     * **Draining, and only once nothing else is coming.** A refusal or a fault
     * says nothing about the backlog — the rows are still owed and the venue is
     * simply not answering — so neither ends the drain; both wait and try again,
     * for as long as the service runs.
     */
    if (! indexing() && ! refused && ! faulted) {
      if (! owed) {
        logger.info({ venue: labelOf(adapter), ...(left > 0 ? { miscounted: left } : {}) },
          'Survey complete');

        return true;
      }

      /**
       * **A round that moved nothing is not a reason to stop.** What is left is
       * rows the venue answers with something that is not an answer — a 5xx, a
       * refusal, a socket that dies — and there is no rule here that turns those
       * into absence. So the drain keeps asking, for as long as the service
       * runs, and says loudly that it is doing so.
       *
       * The pass therefore does not finish, nothing is reconciled, and this
       * venue stops moving on to the next day's keys until somebody looks. That
       * is the intended shape: every venue here is S3, OSS or a known CDN in
       * front of one, and one that answers with something else is a venue to go
       * and fix rather than to design around.
       */
      if (stalled > 0)
        logger.error({ venue: labelOf(adapter), unsettled: left, rounds: stalled },
          'Probing is getting no answers; still trying');
    }

    /**
     * **Work is a reason to keep going; only its absence is a reason to sleep.**
     *
     * Three cases and two of them go straight back round. A refusal is waited
     * out at the venue's own pace, since a block lapses only while nothing is
     * asking. A round that settled, retired, or *confirmed* anything has work in
     * front of it — sleeping there is what left a walk's output sitting in `wip`
     * for quarter-hours at a time, and it would also stretch confirming an
     * absence across minutes for no reason.
     *
     * What is left is a round where the venue answered nothing about any key:
     * an empty backlog while the walk still runs, or a venue that has stopped
     * making sense. Both look again shortly rather than spinning.
     */
    const wait = refused ? standDown : moved > 0 || working ? 0 : PROBE_EMPTY_MS;

    /**
     * **Silence is the one thing a log must not do.** Between passes this loop
     * is asleep, and asleep is indistinguishable from dead unless it says when it
     * will wake — so it always says, and says which of the two states it is in.
     *
     * The idle message is deliberately not "nothing left to probe": on a venue
     * whose walk is still running that is false, and it reads as *finished* when
     * the truth is that the walk has not caught up yet. A fresh venue hits this
     * on its first pass, since both loops start together and the probe asks
     * before the walk has written a row.
     */
    if (refused)
      logger.warn({ venue: labelOf(adapter), minutes: Math.round(wait / 60_000) },
        `Probing paused, resumes ${describeWait(wait)}`);
    else if (wait === 0)
      logger.info({ venue: labelOf(adapter), unsettled: left, settled: moved },
        'More to probe; continuing');
    else
      logger.info({
        venue:   labelOf(adapter),
        nextRun: new Date(Date.now() + wait).toISOString(),
        seconds: Math.round(wait / 1000),
        ...(faulted ? {} : { unsettled: left }),
      }, indexing()
        ? 'Waiting for the walk to find more to probe'
        : 'Probing again shortly');

    await waiting(wait, paused);
  }
};

/**
 * The longest delay `setTimeout` accepts — anything past 2³¹−1 ms overflows and
 * **fires immediately**, which turns a month-long wait into a hot loop rather
 * than into an error.
 */
const MAX_DELAY_MS = 2_147_483_647;

/**
 * Wait, in chunks a timer can actually hold.
 *
 * Nothing here waits for weeks any more — the longest is a venue's stand-down —
 * but the guard is kept because the cost is one comparison and the failure it
 * prevents is silent: a delay past the limit fires immediately, turning a wait
 * into a hot loop. Waking early costs nothing either way, since every answer
 * comes from the catalog rather than from this timer.
 */
const sleep = async (ms: number): Promise<void> => {
  for (let left = ms; left > 0; left -= MAX_DELAY_MS)
    await new Promise(resolve => setTimeout(resolve, Math.min(left, MAX_DELAY_MS)));
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_settle   = settle;
export const _test_probing  = probing;
export const _test_passFor  = passFor;
export const _test_EVERY_HOURS = EVERY_HOURS;
export const _test_onePass  = onePass;
export const _test_PROBE_EMPTY_MS = PROBE_EMPTY_MS;
