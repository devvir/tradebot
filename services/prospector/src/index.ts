import { join } from 'node:path';
import { logger, type Service, type ExpressServerHandle } from '@devvir/service-kit';
import {
  enrol, enrolled, enrolment, flushTips, pauseSurvey, resetRuns, resumeSurvey, venueIdOf, venues,
} from './catalog';
import { configure } from '@devvir/netgate';
import { assertWritable, openCatalog } from './database';
import { fault } from './faults';
import SK from './service';
import { mount } from './api';
import config from './config';
import { capacity } from './pace';
import { dueAfter, everyMs, syncVenue } from './sync';
import { adaptersFor, adaptersForVenue, addressVenues } from './venues';
import type { DatabaseSync } from 'node:sqlite';
import type { Adapter, Occasion } from './types';

/**
 * The prospector establishes what each venue publishes, and stops there.
 *
 * It reads listings and the metadata they carry, never file contents. Knowing how
 * a venue exposes its keyspace and knowing how to fetch and interpret its files
 * are separate problems with separate per-venue nuance, so neither service holds
 * the other's: this one produces a catalog, and whatever downloads reads it.
 *
 * Because the product is a file rather than a filled disk, a survey can also run
 * where the downloading does not — and it answers how much an archive holds in
 * hours, before anything has been committed to fetching it.
 *
 * Venues are surveyed **concurrently**, because they are unrelated hosts with
 * unrelated limits — sequencing them would make every venue wait behind the
 * largest, which is worst for exactly the venue that can least afford it: an
 * archive published as a rolling window loses its oldest data while its turn has
 * not come up.
 */
const main = async (service: Service): Promise<void> => {
  /**
   * **Before anything can ask for a request.** The ceiling is one number for the
   * whole process and every venue draws from it, so it belongs with the other
   * things settled once at the start rather than passed down to each survey.
   */
  capacity(config.concurrency);

  const path = join(config.catalogDir, 'catalog.db');
  const db   = openCatalog(path);

  assertWritable(db, path);

  logger.info({ path, port: config.port }, 'Catalog open');

  /**
   * **The venues are already there**, written by a migration: which ones exist,
   * where each is and what prefix it is rooted at are constants of this
   * application that live in the database so everything else can join against
   * them. Nothing here creates or corrects them — a venue that moves is a new
   * migration, which is to say a new release, exactly as a schema change is.
   *
   * What this does is hand those addresses back to the adapters, which is the
   * one place the two meet.
   */
  addressVenues(venues(db));

  logger.info({ venues: surveyable() }, 'Servers registered');

  /**
   * **One fact about the network, established once.** Without it every request
   * in flight discovers an outage separately, through its own retry budget, and
   * says so — which buries whatever was happening when the link went. Waiting
   * costs a request nothing but time, so nothing here has to be careful about
   * it: see `http.ts`, where every request passes through.
   *
   * **This service is not the expected case, and the defaults are wrong for
   * it.** They assume a probe answers quickly because the caller's own requests
   * do. Here they do not: a venue is walked on hundreds of lanes at once, and
   * with a thousand in flight the throughput settles around 300 a second —
   * which is a mean of over three seconds per request, and those are the
   * *successful* ones. Against the library's three-second deadline the gate was
   * timing out its own probes and reporting a link that was working perfectly
   * well; what it had actually measured was the contention this service creates.
   *
   * So the deadline is set above what this service's own traffic costs, and the
   * window is widened to match: the question a probe has to answer is whether
   * the network is *unusable*, and something slower than a browser is not that.
   *
   * The rest is where to report, since the library deliberately does no logging
   * of its own.
   */
  configure({
    /** Comfortably past the mean this service sees at full width, so slow is not read as gone. */
    timeoutMs: 10_000,

    /** Two failures in thirty seconds is a blip; three in a minute is a pattern. */
    window:    12,
    degradeAt: 3,
    closeAt:   6,

    onChange: ({ from, to, failed, window, heldMs, because }) =>
      logger.warn({ from, to, failed, probes: window.length, heldSeconds: Math.round(heldMs / 1000), because },
        to === 'open' ? 'The network is back' : 'The network is failing — requests are being held'),
  });

  /**
   * **Nothing starts unasked, and nothing stops on its own either.** A survey
   * begins when something asks for one, over the API — and from then on that
   * venue keeps itself current, walking once and updating daily, across any
   * number of restarts, until it is paused or refreshed.
   *
   * A restart is not a new question. It picks up the venues somebody already
   * enrolled and leaves everything else alone — see `resume`, below.
   *
   * That split is the least this service can know and still do its job.
   * *Whether* a venue should be surveyed at all depends on what somebody is
   * waiting for and what the disk can take, neither of which is visible from in
   * here. *How often a venue already being surveyed needs re-reading* is not
   * that question: the archives move once a day, so the answer is a day, and it
   * is not worth asking anybody.
   */
  const api = service.servers.get() as ExpressServerHandle;

  /**
   * **Routes first, then bind.** The server is built by the plugin but not
   * started, because `start()` is what appends the one complete error handler —
   * so anything mounted after it would sit behind the handler meant to be last.
   * Binding here also means the port opens only once there is something behind
   * it to answer.
   */
  mount(api.app, db, config.token, {
    venues: surveyable,
    start:  (venue, occasion, refresh) => survey(db, venue, occasion, refresh),
    pause:    venue => pause(db, venue),
    running,
    stopping,
    everyMs,
  });

  await api.start();

  logger.info({ port: config.port }, 'Catalog API listening');

  /**
   * **After the API is answering, not before.** Resuming starts long-running
   * passes, and a deployment coming back up should be answerable about them from
   * the first moment they exist — including to be paused again, which is the one
   * request somebody restarting a service is most likely to want.
   */
  resume(db);

  /**
   * **The one flush the series module cannot schedule for itself.**
   *
   * It writes its tips out on a full buffer or a quiet interval, so all that is
   * left is the moment nothing inside it can see coming. Losing this costs
   * probes rather than files — a tip that did not reach disk is lower than the
   * truth, and the next update simply asks about days already catalogued — so it
   * is worth doing and not worth blocking an exit for.
   */
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      const written = flushTips(db);

      if (written) logger.info({ tips: written }, 'Series tips flushed on shutdown');

      /**
       * **Closing is what checkpoints the write-ahead log.** SQLite folds it
       * back into the database and removes it when the *last* connection closes,
       * and never before — so a process that exits holding one leaves the log
       * behind at whatever size it reached, and the next open replays all of it
       * before answering anything. Measured after a day's surveying: 2.9 GB of
       * log beside the database, and a `-shm` still there to prove nobody had
       * closed it.
       *
       * Nothing is lost either way, which is why it went unnoticed — a log is
       * replayed, not discarded. What it costs is the replay, and a file that
       * grows across restarts because nothing ever reclaims it.
       */
      try {
        db.close();
      } catch (err) {
        logger.warn({ ...fault(err) }, 'The catalog did not close cleanly — its log will be replayed');
      }
    });
};

/**
 * Survey one venue, now, and keep it current from then on.
 *
 * Every host of it, because the caller asked about a venue. Unawaited on
 * purpose: the first pass runs for hours and the loop after it runs for as long
 * as the service does, neither of which a request should be held open for.
 *
 * **Not awaiting it was never enough** — see `begin`, which claims the venue
 * here and then hands the passes themselves to the next turn.
 */
export const survey = (
  db:       DatabaseSync,
  venue:    string,
  occasion: Occasion = 'full',
  refresh   = false,

  /**
   * Whether each host waits for its own due time before its first pass.
   *
   * **Only a resumption schedules.** An explicit request means now — somebody
   * asked — and a restart means carry on, which is not the same thing: a venue
   * updated an hour before the container was replaced is not owed another
   * update, and starting one would make a deployment's cadence a function of how
   * often it is restarted.
   */
  schedule  = false,
): void => {
  void begin(db, venue, occasion, refresh, schedule);
};

/**
 * Pick up where this deployment left off.
 *
 * **The enrolled venues carry on; nothing else starts.** A survey is something
 * somebody asked for once, and the `survey` table is where that decision lives —
 * so a restart is not an occasion to re-ask it. A venue nobody enrolled stays
 * untouched for ever, and a paused one stays paused, which is the whole reason
 * the pause is a row rather than a flag in memory.
 *
 * **What each host does is its own state, not the venue's.** Resumption runs
 * per host because the passes do: bybit's two servers keep separate run rows and
 * separate cursors, and one of them being mid-walk says nothing about the other.
 * See `dueFor` — an open job resumes at once, a host between passes waits out
 * the remainder of its interval, and neither is anything this has to decide.
 *
 * `PROSPECTOR_VENUES` still applies, so a deployment can be enrolled in a venue
 * it is not currently the one surveying.
 */
const resume = (db: DatabaseSync): void => {
  const carried: string[] = [];
  const stopped: string[] = [];

  for (const venue of surveyable()) {
    const held = enrolled(db, venue);

    if (! held) continue;

    if (held.pausedAt !== null) {
      stopped.push(venue);

      continue;
    }

    carried.push(venue);

    survey(db, venue, 'full', false, true);
  }

  logger.info({ resumed: carried, paused: stopped },
    carried.length > 0
      ? 'Enrolled venues resumed — each host from where it stopped'
      : 'No enrolled venue to resume — surveys start on request');
};

/**
 * When a host's next pass falls due, on being picked up.
 *
 * **Three answers, and only one of them is a wait.** A job left open is work
 * interrupted and resumes immediately, whatever its age. A host between passes
 * is due an interval after its last one *began* — usually already, in which case
 * this is in the past and nothing waits. And a host enrolled that has never run
 * has nothing to wait for.
 */
const dueFor = (db: DatabaseSync, adapter: Adapter): number => {
  const { open, started } = enrolment(db, venueIdOf(db, adapter.name, adapter.host ?? ''));

  return open !== null || started === null ? 0 : dueAfter(started);
};

/**
 * Start a venue's loop, having first stopped whatever was running.
 *
 * **Only the two modifiers interrupt.** A venue is surveyed by a loop that does
 * not end on its own, so *already running* is the ordinary state rather than a
 * conflict — an ordinary request finds the venue current and has nothing to add.
 *
 * A **refresh** interrupts because it is the one thing that must discard what is
 * there, and a **forced update** because the whole of it is skipping a wait that
 * this loop is in the middle of. Both stop the loop, wait for it to actually
 * stop, and start it again.
 *
 * **Waiting is the whole of it.** Resetting under a live walk would drop the
 * rows a partition is still committing cursors to, and the pass would carry on
 * writing against a job that no longer exists.
 */
const begin = async (
  db:       DatabaseSync,
  venue:    string,
  occasion: Occasion,
  refresh:  boolean,
  schedule  = false,
): Promise<void> => {
  /**
   * **A forced update is an interruption, because a wait is what it interrupts.**
   * The venue it is aimed at is idle between passes with its loop very much
   * alive, so leaving it alone as "already running" would make the modifier do
   * nothing in the one state it exists for.
   */
  const interrupt = refresh || occasion === 'partial';

  if (walking.has(venue)) {
    if (! interrupt) return;

    logger.info({ venue, for: refresh ? 'refresh' : 'update' },
      'Interrupting — stopping the current pass first');

    /**
     * **`halt`, not `pause`.** This is not somebody stopping the venue; it is
     * this request clearing the way for its own work, and writing the venue down
     * as paused for the second it takes would report it as stopped by a person.
     */
    halt(venue);

    await until(() => ! walking.has(venue));
  }

  /**
   * **Asking a paused venue to survey is how a pause is lifted.** There is no
   * separate resume: a pause left every cursor where it was, so starting is
   * continuing.
   */
  halting.delete(venue);

  /**
   * **Asking for a survey is what enrols a venue**, and asking for a paused one
   * is what lifts the pause. There is no separate verb for either: a pause left
   * every cursor where it was, so starting is continuing, and a venue nobody has
   * asked about is one this deployment leaves alone for ever.
   */
  enrol(db, venue, new Date().toISOString());

  if (resumeSurvey(db, venue)) logger.info({ venue }, 'Pause lifted');

  if (refresh) {
    const dropped = adaptersForVenue(venue)
      .reduce((gone, adapter) =>
        gone + resetRuns(db, venueIdOf(db, adapter.name, adapter.host ?? '')), 0);

    logger.info({ venue, dropped }, 'Progress discarded — surveying from nothing');
  }

  walking.add(venue);

  /**
   * **The claim above is synchronous and everything below it is not.**
   *
   * An `async` function runs synchronously until its first `await`, and
   * starting a venue does seconds of real work before it reaches one. Unawaited
   * or not, all of that ran inside whoever asked — so `POST /surveys` sat for
   * half a minute on work it had no interest in, having already decided every
   * word of its reply, and the venues' first log lines arrived in the same burst
   * as the response, because nothing could flush until the loop came back.
   *
   * The yield goes *after* `walking.add`, never before: the claim is what stops
   * a second request starting the same venue twice, and deferring that would
   * open exactly the race this guards against.
   */
  await new Promise(resolve => setImmediate(resolve));

  const done = adaptersForVenue(venue)
    .map(adapter => syncVenue(db, adapter, config, occasion, () => halting.has(venue),
      schedule ? dueFor(db, adapter) : 0));

  void Promise.allSettled(done).finally(() => {
    walking.delete(venue);
    halting.delete(venue);
  });
};

/**
 * Wait for a condition the survey loops clear on their own.
 *
 * Polled rather than signalled: a pass stops between pages and a page can be a
 * listing request, so the wait is seconds either way and a poll costs one map
 * lookup a beat.
 */
const until = async (met: () => boolean): Promise<void> => {
  while (! met()) await new Promise(resolve => setTimeout(resolve, 250));
};

/**
 * Ask a venue's survey to stop where it is.
 *
 * **Nothing is cancelled and nothing is lost.** The flag is read between pages,
 * so the walk finishes the one it is on, commits it, keeps every cursor and
 * leaves the job open. Starting the venue again continues from there.
 *
 * Answers whether there was anything to stop, which is what separates "paused
 * it" from "it was not running".
 */
export const pause = (db: DatabaseSync, venue: string): boolean => {
  /**
   * **Written down first, because a pause has to outlive the process.** Held
   * only in memory it was forgotten by the next start, and a deployment that
   * resumes what it finds open would then have restarted a venue somebody had
   * deliberately halted. The row is what keeps it stopped; `halt` is what stops
   * it now.
   */
  const recorded = pauseSurvey(db, venue, new Date().toISOString());

  if (! halt(venue)) {
    if (recorded) logger.info({ venue }, 'Pause recorded — the venue was not running');

    return recorded;
  }

  logger.info({ venue }, 'Pause asked for — the survey will stop after its current page');

  return true;
};

/**
 * Stop the loop where it is, and record nothing.
 *
 * **The half of a pause that is about this process.** A refresh and a forced
 * update both have to stop a running loop before they can do their own work, and
 * neither is anybody deciding the venue should be stopped — so neither writes
 * `survey.paused_at`.
 *
 * Routing them through the persisted pause meant a forced update wrote the row
 * and cleared it a moment later, and a status polled in between reported the
 * venue as **paused**: the one word that says a person stopped it, shown for
 * work a person had just asked for. What is honest during that gap is
 * `stopping`, which is what this sets.
 *
 * Answers whether there was a loop to stop.
 */
const halt = (venue: string): boolean => {
  if (! walking.has(venue)) return false;

  halting.add(venue);

  return true;
};

/**
 * Whether a stop has been asked for and **this process** has not acted on it.
 *
 * Distinct from the venue being paused, which is a row and survives a restart.
 * This is the moment between asking and the loop noticing — a page in flight,
 * at most.
 */
export const stopping = (venue: string): boolean => halting.has(venue);

/**
 * The venues this process is walking, which is not the same question as which
 * have work outstanding — see `Surveys.running`.
 */
const walking = new Set<string>();

/**
 * The venues asked to stop, which is a request rather than a state: a survey
 * clears its own entry when it actually finishes stopping.
 *
 * **Not the pause itself**, which is a row in `survey` and outlives the process.
 * This is only how the running loop is told, and it is deliberately forgotten on
 * a restart — there is no loop left to stop.
 */
const halting = new Set<string>();

export const running = (venue: string): boolean => walking.has(venue);

/**
 * The venues this deployment will survey: those with a scanner, narrowed by
 * `PROSPECTOR_VENUES` where it names any.
 *
 * A venue registered without a scanner is left out rather than offered and
 * refused — it cannot be read, so it is not something to ask about.
 */
export const surveyable = (): string[] =>
  [...new Set(adaptersFor(config.venues).filter(a => a.scanner.name !== 'none').map(a => a.name))];

SK.run(main);
