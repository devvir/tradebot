import { logger } from '@devvir/service-kit';
import { backoffDelay } from '@tradebot/utils';
import { fault } from './faults';
import {
  advanceRun,
  beginJob,
  everCompleted,
  closeRun,
  flushTips,
  openJob,
  openPartitions,
  parkSoon,
  refinePartition,
  putFiles,
  putUnreadable,
  seriesById,
  seriesOf,
  venueIdOf,
  walkSeries,
} from './catalog';
import { surveying } from './context';
import { loadExclusions, isExcluded } from './exclusions';
import { Refused, StoodDown, Stopped, answered, blocked } from './http';
import { describeWait, labelOf, lanesFor, paceFor, ticketing } from './pace';
import { byteOrder, ceiling, excludedAnywhere, relative } from './paths';
import { seriesSeededAt } from './database/migrations/seeds/seed';
import { flushCounts } from './counts';
import { timed, timingsOf } from './timings';
import { updatePage, updateScopes } from './update';
import type { Rules } from './update';
import type { Occasion, CatalogFile, Run, RunKind } from './types';
import type { DatabaseSync } from 'node:sqlite';
import type { Adapter, Config, Coverage, Listed, Span, Survey, Unreadable } from './types';

/**
 * Whether this pass has a probing half.
 *
 * **An update always probes, whatever the venue is.** It generates keys rather
 * than reading them, so nothing it emits carries metadata and nothing is
 * established until it is asked about — which is exactly the condition `probes`
 * describes. A listing venue that never probes while walking therefore starts
 * probing the moment it stops walking.
 *
 * **Stated once because three places read it**: the pass, which starts a probe
 * on it; the log that says whether a pass is complete or now probing; and the
 * walk's own job, which closes on it rather than on the kind. `adapter.probes`
 * alone is the wrong answer for all three on every update of a listing venue.
 */
export const probing = (adapter: Adapter, doing: Occasion): boolean =>
  adapter.probes === true || doing === 'partial';

/**
 * Survey one venue: get its partitions, then walk them to the end.
 *
 * **There is one decision here — build a new set of partitions, or continue the
 * open one — and every path converges immediately after it.** A first pass, a
 * refresh, and a resume of either are not three flows with shared parts; they
 * are one flow reached two ways. A first pass is a job with nothing before it, a
 * refresh is a job whose predecessor has aged out, and a resume is neither: it
 * is the same job, still open, still holding its cursors.
 *
 * That is why nothing below asks which kind of survey it is in. Nothing needs
 * to.
 *
 * **Nothing here fetches archive data** — only listings and the metadata they
 * carry. Establishing what exists is the entire job.
 */
export const surveyVenue = async (
  db:      DatabaseSync,
  adapter:  Adapter,
  config:   Config,
  occasion: Occasion,
  paused:   () => boolean = () => false,
): Promise<Survey> => {
  /**
   * **Said before anything slow happens.** Building a context and mapping the
   * archive can run for minutes before the first partition exists, and a survey
   * that answers `started` and then prints nothing is indistinguishable from one
   * that has failed.
   */
  logger.info({ venue: labelOf(adapter), occasion }, 'Survey starting');

  const venueId = venueIdOf(db, adapter.name, adapter.host ?? '');

  /**
   * **What this venue tolerates, never more than what the machine allows.** A
   * lane holds one request at a time, so more of them than either figure permits
   * is not parallelism — it is queueing, with a partition held open behind it.
   */
  const lanes = lanesFor(adapter, config.concurrency);

  /**
   * Read here rather than at startup, so a file excluded by hand takes effect on
   * the next job instead of the next deploy.
   */
  loadExclusions(db, adapter, venueId);

  /**
   * **One run, reached two ways.** A full survey walks the venue's keyspace; a
   * partial one generates the dates each series is missing and probes them.
   * Everything after the scopes exist is identical — the same scopes, the
   * same cursors committed page by page, the same job that stays open until each
   * is exhausted — which is what makes both stoppable and resumable by the same
   * code.
   *
   * They are kept in separate rows so that neither can be mistaken for the
   * other: an update's scopes say nothing about the keyspace a walk covers, and
   * `establishedAt` asks only about walks on a venue that has ever walked.
   */
  const kind: RunKind = occasion === 'partial' ? 'update' : 'walk';
  const open = openJob(db, venueId, kind);

  /**
   * **Everything the scanner will need, assembled once and carried down.**
   *
   * Built here rather than when the job opens, because a resume has no job to
   * open and still needs it — a context lives in memory, so a restart mid-walk
   * arrives with nothing.
   *
   * **Built from the pass being run**, which `passFor` chose before this was
   * called. No adapter's `getContext` contacts its venue, so a resume costs
   * nothing here.
   */
  const context = await adapter.getContext(db, occasion);

  /**
   * **Mapping can be refused too, and it is the first thing a new venue does.**
   * A block the venue's gate has latched is reported the way a walk reports
   * one, so the caller waits it out rather than asking again. Anything else —
   * a lone refusal included — is thrown, and retried like any failure.
   */
  let job: Run;

  try {
    job = open ?? await partition(db, adapter, lanes, venueId, context, kind);
  } catch (err) {
    if (! latched(adapter, err)) throw err;

    logger.error({
      err, venue: labelOf(adapter), status: err.status, ...err.detail, ...paceFor(adapter, err.url).rates(),
    }, `Venue refused the listing; retrying ${describeWait(paceFor(adapter, err.url).blockedFor())}`);

    return {
      venue: labelOf(adapter), partitions: 0, requests: 0, found: 0, failed: 1,
      blocked: true, paused: false,
    };
  }

  /**
   * The work is **read**, never re-derived. A partition leaves this list by
   * being walked to exhaustion, so what is left is exactly what is left — no
   * filter, no comparison against what an earlier attempt managed.
   *
   * It also means a resumed job does not re-map the archive, so a directory that
   * appeared after the job began waits for the next one. That costs nothing: the
   * guarantee was only ever *present at the start and still there at the end*,
   * and something that appeared midway was never inside it.
   */
  const partitions = openPartitions(db, venueId, kind);
  const started    = Date.now();

  logger.info({ venue: labelOf(adapter), [words(kind).units]: partitions.length, job: job.started },
    `${words(kind).doing} ${words(kind).units}`);

  const summary: Survey = {
    venue: labelOf(adapter), partitions: partitions.length,
    requests: 0, found: 0, failed: 0, blocked: false, paused: false,
  };

  let settled = 0;

  /** The scopes that failed in this pass: open at its end, and with a reason to be. */
  const failed = new Set<string>();

  /**
   * The work list, which **grows while it is being worked**.
   *
   * A survey ends when its slowest partition does, so one prefix holding a
   * disproportionate share of the archive decides the whole run however fast the
   * rest finish: tens of thousands of pages, walked by one worker while the
   * others idle.
   *
   * Which prefix that will be cannot be known before walking it: the mapping
   * sees shape, and shape is not size. So it is discovered instead. Whenever a
   * lane has nothing to take, the fattest partition still running is split into
   * its children and they join the queue — see `refine`.
   */
  const queue    = [...partitions];
  const running  = new Map<number, Runner>();
  const terminal = new Set<string>();

  /** One refinement at a time, so lanes cannot pick the same victim twice. */
  let refining: Promise<void> | null = null;

  /**
   * **Set once a lane has failed, and read by every other.** A lane fails only
   * on something outside a partition's own failure, which `walkOne` absorbs —
   * so the pass is ending, and every walk still running stops between pages
   * rather than carrying on behind a survey that has already answered.
   */
  let aborting = false;

  const walkOne = async (partition: Run, runner: Runner) => {
    /**
     * Once a venue is refusing this address, every remaining partition will be
     * refused too — and each attempt is another request against a ban that only
     * lapses while nothing is asking. So the rest of the venue is left for the
     * next turn of the loop, which by then will have waited.
     */
    if (summary.blocked || aborting || paused()) return;

    try {
      /**
       * **A partition already reading stops between pages, not at its own 403.**
       * Skipping only the partitions that had not started yet leaves the other
       * nineteen paging on, and each one earns its own refusal before it notices
       * — nineteen more requests against a ban that lapses only while nothing is
       * asking. They keep their cursors, so this costs nothing but the wait.
       */
      const done = await sweep(db, adapter, partition, context, kind, live,
        () => (summary.blocked ? 'blocked'
          : aborting ? 'aborting'
            : paused() ? 'paused'
              : runner.stopping ? 'splitting' : null));

      summary.requests += done.requests;
      summary.found    += done.found;

      /** Stopped between pages, it is still open and still owed: not settled, and nothing to report. */
      if (! done.closed) return;
    } catch (err) {
      /**
       * The partition keeps its row and its cursor, so this is a pause rather
       * than a loss. What matters is that the job is **not** closed below:
       * leaving it open is what brings the loop straight back here instead of
       * declaring the venue established and sleeping until the next refresh.
       */
      summary.failed++;
      failed.add(partition.scope);

      /**
       * **A block is what the venue's gate says it is.** One refusal that reads
       * as one fails its partition and nothing else; the pass stops only once
       * the gate has latched, which takes a run of them — see `Pace.block`.
       */
      if (latched(adapter, err)) summary.blocked = true;

      /**
       * The refusal's headers are spread out flat because a `Headers` has no
       * enumerable properties of its own — logged as an object it serialises to
       * `{}`, taking `server`, `x-cache` and `x-amz-error-code` with it. Those
       * three are the only thing separating a block from a refusal about one
       * key, so losing them is losing the answer.
       */
      logger.error({
        ...fault(err), venue: labelOf(adapter), scope: partition.scope,
        ...(err instanceof Refused ? { status: err.status, ...err.detail } : {}),
        ...(summary.blocked ? { blocked: true, ...paceFor(adapter, adapter.base).rates() } : {}),
      }, summary.blocked
        ? 'Venue blocked us; stopping this pass'
        : 'Partition failed; left for the next pass');
    }

    settled++;

    /** This partition is still in `running` until its lane takes the next, and is counted as settled. */
    logger.info({
      venue:    labelOf(adapter),
      progress: `${settled}/${settled + queue.length + running.size - 1}`,
      found:    summary.found,
      minutes:  Math.round(elapsed(started) / 60),
    }, words(kind).all);
  };

  /**
   * Split the busiest running partition, so the lanes calling this have
   * something to take.
   *
   * **The busiest is the one deciding when the survey ends**, and `requests`
   * already counts its pages, so it identifies itself. Refining anything else
   * terminates just as surely and helps just as little.
   */
  const refine = async (): Promise<void> => {
    const busiest = openPartitions(db, venueId, kind)
      .filter(one => running.has(one.id) && ! running.get(one.id)!.stopping)
      .filter(one => ! terminal.has(one.scope))
      .sort((a, b) => b.requests - a.requests)[0];

    /**
     * **An update's scopes cannot be split.** A series is the smallest thing that
     * can be generated independently — there is no prefix under it to divide —
     * so refinement, which exists to break up a fat listing prefix, has nothing
     * to do here.
     */
    if (! busiest || kind === 'update' || ! adapter.scanner.level) {
      // Nothing splittable. Said once per venue rather than per idle lane.
      terminal.add('');

      return;
    }

    const runner = running.get(busiest.id)!;

    /**
     * **Stopped before it is split, and only then.** `sweep` commits its cursor
     * on every page and returns without closing the run, so what it leaves is a
     * partition that knows exactly where it got to. Splitting under a running
     * walk would race that cursor, and the children would inherit a position
     * their parent had already moved past.
     */
    runner.stopping = true;

    await runner.finished;

    const at = openPartitions(db, venueId, kind).find(one => one.id === busiest.id);

    if (! at) return;   // it finished on its own between the two lines

    /**
     * **Whatever happens below, this partition is owed back.**
     *
     * It was stopped to be split, and `sweep` honoured that by returning without
     * closing it — so right now it is open, holding a cursor, and running
     * nowhere. Every path out of here that does not replace it with children
     * requeues it; one that did not would abandon it — not walked, not closed,
     * and invisible until something notices the venue can never be established.
     */
    const giveBack = () => { queue.push(at); };

    /**
     * **A level that cannot be read leaves the partition whole.** Reading its
     * children is a request like any other and can fail like any other; the
     * partition goes back on the queue holding its cursor, is not offered for
     * splitting again this pass, and the pass carries on. A refusal the venue's
     * gate has latched stops the pass, exactly as it does on a page.
     */
    let children: string[];
    let files:    boolean;

    try {
      const read = await withinSplit(adapter.scanner.level(context, adapter.keyRoot + at.scope));

      /**
       * **A split that takes too long is abandoned, not waited on.** Every idle
       * lane is parked on this answer and the partition itself was stopped for
       * it, so an answer that does not come is the whole survey standing
       * still. The partition is resumed whole and not offered for splitting
       * again this pass, which costs exactly what a prefix that could not be
       * split costs.
       */
      if (read === null) {
        terminal.add(at.scope);
        giveBack();

        logger.warn({ venue: labelOf(adapter), scope: at.scope, minutes: SPLIT_MS / 60_000 },
          'Partition split timed out; continuing without splitting');

        return;
      }

      ({ children, files } = read);
    } catch (err) {
      terminal.add(at.scope);
      giveBack();

      if (latched(adapter, err)) summary.blocked = true;

      logger.warn({ ...fault(err), venue: labelOf(adapter), scope: at.scope,
        ...(err instanceof Refused ? { status: err.status, ...err.detail } : {}),
        ...(summary.blocked ? { blocked: true } : {}) },
      'Could not split a partition; continuing without splitting');

      return;
    }

    /**
     * **A prefix holding a file of its own is never split.** A parent walks with
     * no delimiter and so covers every key beneath it; its children cover only
     * their own subtrees, and a key sitting directly here would belong to none
     * of them and vanish. Terminal is the honest answer, and the cost is a
     * partition that stays coarse in a layout venues do not actually produce.
     */
    if (files || children.length === 0) {
      terminal.add(at.scope);
      giveBack();

      logger.info({ venue: labelOf(adapter), scope: at.scope, reason: files ? 'holds files' : 'no children' },
        'Partition cannot be split; continuing');

      return;
    }

    const scopes = children.map(child => relative(adapter, child));

    /**
     * **A split that yields nothing must not close the parent.** Every child
     * sorting below the cursor means this prefix is genuinely finished, and the
     * walk would have closed it a page later — but so does a child list that
     * came back short, and the two are indistinguishable from here. Leaving the
     * run open costs one more pass; closing it wrongly loses the keyspace in
     * silence.
     */
    if (! divisible(at.cursor, scopes)) {
      terminal.add(at.scope);
      giveBack();

      logger.info({ venue: labelOf(adapter), scope: at.scope, children: scopes.length },
        'Partition cannot be split; continuing');

      return;
    }

    const made = refinePartition(db, at, scopes);

    queue.push(...made);

    logger.info({ venue: labelOf(adapter), scope: at.scope, into: made.length, pages: at.requests },
      'Partition split');
  };

  /**
   * Find a lane something to do, or tell it there is nothing left.
   *
   * Terminates because every path shrinks the problem: a refinement replaces a
   * prefix with strictly longer ones over a finite tree, and a prefix that
   * cannot be split is remembered so it is never examined twice.
   */
  const topUp = async (): Promise<boolean> => {
    for (;;) {
      if (summary.blocked || aborting || paused()) return false;
      if (queue.length > 0) return true;
      if (running.size === 0) return false;
      if (terminal.has('')) return false;

      /**
       * **Started once, awaited by every lane alike.** The lane that starts a
       * refinement is no different from one that finds it under way: each goes
       * round again and takes whatever it left on the queue. `refine` gives a
       * partition back on every path of its own; something failing outside
       * those ends refinement for the pass, since nothing says it would not
       * fail again.
       */
      refining ??= refine()
        .catch((err: unknown) => {
          terminal.add('');

          logger.error({ ...fault(err), venue: labelOf(adapter) }, 'Could not split a partition');
        })
        .finally(() => { refining = null; });

      await refining;
    }
  };

  const lane = async (): Promise<void> => {
    try {
      for (;;) {
        const next = queue.shift();

        if (! next) {
          if (! await topUp()) return;

          continue;
        }

        const runner: Runner = { stopping: false, finished: Promise.resolve() };

        running.set(next.id, runner);
        runner.finished = walkOne(next, runner);

        try {
          await runner.finished;
        } finally {
          running.delete(next.id);
        }
      }
    } catch (err) {
      aborting = true;

      for (const runner of running.values()) runner.stopping = true;

      throw err;
    }
  };

  /** Pages and files as they are read, across every lane — see the heartbeat. */
  const live = { pages: 0, found: 0 };

  /**
   * **Proof of life for the survey itself, not for any one partition.**
   *
   * A partition reports while it is turning pages, which says nothing when the
   * problem is that none of them are: partitions queued, no open sockets, an
   * idle event loop and no line at all reads exactly like a survey that has
   * quietly finished. The counts below separate them: a lane count that never
   * moves, with work still queued, is a stall and says so.
   *
   * `refining` is included because it is the one thing every idle lane waits on
   * at once, which makes a single stuck split look exactly like this.
   */
  const alive = setInterval(() => {
    const flow = paceFor(adapter, adapter.base).rates();

    logger.info({
      venue:    labelOf(adapter),

      /**
       * **What the pass has read so far, as it reads it.** The per-partition
       * totals reach the job only when a partition finishes, which on a large
       * one is hours — so these are counted page by page instead.
       */
      pages:    live.pages,
      found:    live.found,

      /** The same speed a probing pass reports, from the same limiter — see `probe.ts`. */
      'lastMinute (req/s)': flow.lastMinute,
      'lastHour (req/s)':   flow.lastHour,
      inFlight:             flow.inFlight,
      'retries (%)':        flow.sentTotal === 0 ? 0 : Math.round(1000 * flow.retries / flow.sentTotal) / 10,

      settled,
      queued:   queue.length,
      running:  running.size,
      refining: refining !== null,

      /**
       * **Which wait it is, when nothing is moving.** A request that is not
       * going out is held by this host's limiter or by the machine's pool, and
       * from outside the two are indistinguishable without this.
       */
      pace:     paceFor(adapter, adapter.base).state(),
      tickets:  ticketing(),

      /**
       * Where requests spent their time since the last line — see `timings.ts`.
       * **Only at debug**: it is for finding out why a walk is slow, and a
       * dozen lines of it on every heartbeat bury the ones read every day. It
       * is taken either way, so what it reports is always the last interval.
       */
      ...timingsAt(timingsOf(labelOf(adapter))),
    }, kind === 'walk' ? 'Walking' : 'Generating');
  }, HEARTBEAT_MS).unref();

  /**
   * **Every lane settles before the survey answers, whatever one of them did.**
   * A lane that throws stops the others between pages (see `aborting`), and
   * the failure is passed on only once nothing is walking — so a caller that
   * retries never starts a second set of lanes over partitions the first is
   * still reading.
   */
  let lost: { reason: unknown } | undefined;

  try {
    const ended = await Promise.allSettled(Array.from({ length: lanes }, () => lane()));

    await Promise.allSettled([...running.values()].map(runner => runner.finished));

    lost = ended.find((one): one is PromiseRejectedResult => one.status === 'rejected');
  } finally {
    clearInterval(alive);
  }

  if (lost) throw lost.reason;

  advanceRun(db, job.id, null, summary.requests, summary.found);
  flushCounts(db, adapter);

  /**
   * **A job closes only when every partition did**, and counting failures is not
   * enough to know that. A partition can end this loop neither failed nor
   * closed — stopped for a split that then did not happen — and such a run is
   * invisible to `summary`. Left unchecked the job closes over it, the venue
   * reads as established, and a prefix with a live cursor is never walked again
   * by anything.
   *
   * **A blocked pass explains its own.** Every partition it did not reach was
   * left on purpose, so they are counted as left for the next pass rather than
   * named as though something had lost them.
   */
  const left = openPartitions(db, venueId, kind)
    .filter(one => one.scope !== '' && ! failed.has(one.scope))
    .map(one => one.scope);

  const unexplained = summary.blocked ? [] : left;

  summary.paused = paused();

  if (summary.paused) {
    logger.info({ ...summary, job: job.started },
      'Survey paused');

    return summary;
  }

  if (! summary.blocked && summary.failed === 0 && unexplained.length === 0) {
    summary.generated = true;

    /**
     * **A job closes when its pass is over, and generation is not the end of a
     * pass that probes.**
     *
     * A walk over a venue that states everything in its listing ends here: the
     * keyspace has been read, the bounds are on disk, and the closed job is what
     * `phaseOf` and `establishedAt` read to say the venue is established.
     *
     * **Every other pass leaves it open**, because the keys are in `wip` and
     * mostly unasked, and probing them is where the hours go. The job is the
     * only durable record that they are owed: closed at this moment, a restart
     * during the drain finds nothing open, plans the whole pass again, and
     * throws away a per-series completion record for every series it had
     * finished — and the venue reads as *waiting* meanwhile, with its whole
     * backlog outstanding.
     *
     * That holds for an update and equally for a walk on a venue whose listing
     * cannot state a size or an etag, which is why the condition is `probing`
     * rather than the kind. What closes those instead is the drain returning —
     * `closeWalk` for a walk, `clearUpdate` for an update, both in `sync.ts`.
     */
    if (kind === 'walk' && ! probing(adapter, occasion)) {
      flushCounts(db, adapter);
      closeRun(db, job.id);
    }

    /**
     * **Tips are not stated here.** A walk proves what it proves by reading the
     * index to the end, and that is a claim about the whole venue rather than
     * about any partition — so it is made once the pass is over, by the same
     * `reconcile` an update earns. See `onePass`.
     */
    logger.info({ ...summary, established: job.started }, 'Venue surveyed');
  } else {
    /**
     * A scope that failed is counted and not named: it kept its cursor, each
     * was said as it happened, and the next pass resumes it. One that is open
     * with no failure to explain it is named, since nothing else will say so.
     */
    logger.warn({ ...summary, job: job.started,
      ...(summary.failed > 0 ? { failed: `${summary.failed} ${summary.failed === 1 ? 'scope' : 'scopes'} (will be retried)` } : {}),
      ...(summary.blocked && left.length > 0 ? { leftForNextPass: left.length } : {}),
      ...(unexplained.length > 0 ? { openWithoutAFailure: unexplained } : {}) },
    'Survey incomplete; the next pass resumes it');
  }

  return summary;
};

/**
 * What to call one unit of work in a log line.
 *
 * A walk's scope is a prefix and reads as itself. An update's is a series id,
 * which is a number nobody can act on — so it is resolved to the instrument and
 * shape it stands for, which is what somebody watching actually wants to see.
 */
const named = (db: DatabaseSync, kind: RunKind, scope: string): string => {
  if (kind === 'walk') return scope;

  const row = seriesById(db, Number(scope));

  return row ? `${row.symbol} ${row.dataset}${row.variant ? ` ${row.variant}` : ''}` : scope;
};

/**
 * What a unit of work is called, which is not the same thing in both passes.
 *
 * **A walk reads prefixes; an update generates for series.** They share the
 * machinery — a scope, a cursor, a row in `run` — and share nothing else worth
 * saying out loud. Logging "Walking partition" while generating keys for
 * `ADA260828` is the kind of line that makes somebody go and read the code to
 * find out what the service is actually doing.
 */
const words = (kind: RunKind): {
  unit: string; units: string; doing: string; done: string; all: string;
} => (kind === 'walk'
  ? { unit: 'partition', units: 'partitions', doing: 'Walking', done: 'Partition complete', all: 'Partitions walked' }
  : { unit: 'series', units: 'series', doing: 'Generating for', done: 'Series generated', all: 'Series generated' });

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * One lane's grip on the partition it is walking.
 *
 * `stopping` is how a refinement asks a walk to pause at the next page — the
 * cursor is committed by then, so the children it is about to be split into
 * inherit a position that is true. `finished` is how the refinement waits for
 * that to have happened, rather than assuming it.
 */
interface Runner {
  stopping: boolean;
  finished: Promise<void>;
}

/**
 * Why a walk is stopping between pages, or null to carry on.
 *
 * All four read identically from inside `sweep` — cursor committed, run left
 * open — and mean quite different things to whoever is watching: a venue turning
 * us away, this service reorganising its own work, somebody asking for the
 * survey to stop, or the pass ending because another lane failed.
 */
type StopReason = 'blocked' | 'splitting' | 'paused' | 'aborting' | null;

/**
 * Whether a failure is a venue turning us away, as its gate has concluded.
 *
 * A refusal that reads as a block (see `blocked`) counts only once the gate has
 * latched, which takes a run of them — see `Pace.block`. A lone one is a failure
 * of whatever asked, and nothing more. A `StoodDown` is the gate latching on a
 * `Retry-After` longer than the venue's ceiling, and counts the same way.
 */
const latched = (adapter: Adapter, err: unknown): err is Refused =>
  err instanceof Refused
  && (err instanceof StoodDown || blocked(adapter, err.status, err.headers))
  && paceFor(adapter, err.url).blockedFor() > 0;

/** Whether splitting here would actually produce work, rather than closing a run for nothing. */
const divisible = (cursor: string | null, children: readonly string[]): boolean =>
  cursor === null || children.some(child => byteOrder(cursor, ceiling(child)) < 0);

/**
 * A page's coverage as catalog paths, inside the partition being walked.
 *
 * **The partition bounds an open end.** A first page covers from the scope's
 * start and a last page to its end, which is the ceiling of the prefix — or, for
 * a venue walked from its root, everything there is.
 */
const spanOf = (adapter: Adapter, venueId: number, short: string, covers: Coverage): Span => {
  if ('directory' in covers)
    return {
      venueId,
      directory: relative(adapter, covers.directory),
      children:  covers.children.map(child => relative(adapter, child)),
    };

  return {
    venueId,
    low:      covers.after === null ? short : relative(adapter, covers.after),
    lowOpen:  covers.after !== null,
    high:     covers.through === null ? (short === '' ? EVERYTHING : ceiling(short)) : relative(adapter, covers.through),
    highOpen: covers.through === null,
  };
};

/** Above every path: the end of a venue walked from its root. */
const EVERYTHING = '\u{10FFFF}';

/** Pages between progress lines. Small enough to see movement, rare enough to read. */
const PROGRESS_EVERY = 25;

/**
 * How often one page is asked before its prefix is left for the next pass, and
 * the wait before asking again: doubled each time, up to a minute. Twelve
 * attempts are eleven waits, 422 seconds: just over seven minutes — longer than a lock or
 * a bad moment on the link lasts, and short enough that a page that can never
 * be read does not hold a lane for the afternoon.
 */
const PAGE_ATTEMPTS = 12;
const RETRY_MS      = 2_000;
const RETRY_MAX_MS  = 60_000;

/** The failed attempt at which a page is first said to be failing. */
const PAGE_ATTEMPTS_QUIET = 3;

let retryWait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * How long a split may take before it is given up on.
 *
 * A level read is one listing page wherever the prefix holds files, and a
 * handful where it holds only directories — seconds, at the slowest pace this
 * service has measured. Five minutes is two orders past that, and still short
 * of what a stall costs: thirty lanes and the busiest partition, all waiting.
 */
const SPLIT_MS = 5 * 60_000;

/**
 * The level read, or `null` once `SPLIT_MS` has passed without it.
 *
 * **The read is not cancelled, only no longer waited for.** It holds a slot like
 * any other request and releases it when it ends, so walking away from it costs
 * that slot for as long as it takes and nothing after.
 */
const withinSplit = async <T>(reading: Promise<T>): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      reading,
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), SPLIT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * How long a partition may say nothing before it says something anyway.
 *
 * The point is not the progress, it is the proof of life: a walk that is waiting
 * out a venue's `Retry-After` looks exactly like a walk that has stopped.
 */
const QUIET_MS = 120_000;

/** The timings as a heartbeat carries them: there at debug, and absent otherwise. */
const timingsAt = <T>(timings: T): { timings?: T } =>
  (logger.isLevelEnabled?.('debug') ? { timings } : {});

/** How often a pass reports its speed — the same clock the probe's heartbeat keeps. */
const HEARTBEAT_MS = 30_000;

/**
 * Map the archive and commit the partitions it yields, as one job.
 *
 * The only step that talks to the venue about *structure* rather than contents,
 * and it happens exactly once per job — never on a resume, because by then the
 * partitions are already written down.
 */
const partition = async (
  db:      DatabaseSync,
  adapter: Adapter,
  lanes:   number,
  venueId: number,
  context: unknown,
  kind:    RunKind,
): Promise<Run> => {
  /**
   * **An update maps nothing.** Its scopes are the series already recorded, one
   * each, so there is no archive to read and no request to make: what a walk
   * discovers by asking, this reads off the table.
   */
  if (kind === 'update') {
    const series = updateScopes(db, venueId);
    const job    = beginJob(db, venueId, kind, series);

    logger.info({ venue: labelOf(adapter), series: series.length, job: job.started },
      'Update started');

    return job;
  }

  logger.info({ venue: labelOf(adapter), keyRoot: adapter.keyRoot }, 'Mapping the archive');

  // Split for the workers this venue will actually have — see `lanesFor`.
  const mapped = await adapter.scanner.scopes(context, { concurrency: lanes });

  // Partitions are stored **relative** to the venue's key root, so they can be matched
  // against the paths in `file` and against an ancestor without anyone knowing
  // how a bucket is addressed.
  const job = beginJob(db, venueId, kind, mapped.map(scope => relative(adapter, scope)));

  logger.info({ venue: labelOf(adapter), partitions: mapped.length, job: job.started },
    'Job opened');

  return job;
};

/**
 * Read one partition to exhaustion, resuming wherever the last attempt stopped.
 *
 * A partition is walked page by page and each page is committed before the next
 * is requested. That is deliberate on two counts: a walk killed part-way resumes
 * from its cursor rather than from the beginning, and the write lock is held for
 * a batch at a time rather than for the length of a walk.
 */
const sweep = async (
  db:      DatabaseSync,
  adapter: Adapter,
  run:     Run,
  context: unknown,
  kind:    RunKind,
  live:    { pages: number; found: number },
  stopped: () => StopReason,
): Promise<{ requests: number; found: number; closed: boolean }> => {
  const short   = run.scope;
  const venueId = run.venueId;

  // The scanner works in the venue's own keyspace, so the key root goes back on;
  // the cursor needs no such treatment, being a marker the venue gave us and
  // which is handed back verbatim.
  const scope = adapter.keyRoot + short;

  const said = words(kind);

  logger.info(
    { venue: labelOf(adapter), [said.unit]: named(db, kind, short),
      ...(run.cursor ? { resumingFrom: run.cursor } : {}) },
    run.cursor ? `Resuming ${said.unit}` : `${said.doing} ${said.unit}`,
  );

  const started = Date.now();

  let cursor    = run.cursor;
  let requests  = 0;
  let found     = 0;
  let withdrawn = 0;
  let spoke     = Date.now();

  /** What generating a key takes is fixed for the partition, so it is read once — see `rulesFor`. */
  const rules = kind === 'update' ? rulesFor(db, venueId, adapter) : null;

  do {
    /**
     * **Hand the event loop back between pages, every time.**
     *
     * A listing scanner awaits a socket and yields as a side effect of doing its
     * job. A constructed-key scanner does no I/O at all — `page` is arithmetic
     * behind an `async` signature, so awaiting it resolves on the microtask queue
     * and control never reaches the I/O phase. One venue then holds the whole
     * process: its log lines are produced and never flushed, and every other
     * venue's sockets go unserviced, which reads exactly like a service that has
     * wedged while it is in fact running flat out.
     *
     * `setImmediate` costs one turn per thousand keys and makes the difference
     * between silence and a survey that can be watched.
     */
    await new Promise(resolve => setImmediate(resolve));

    /**
     * **A page that fails is asked again, here.** What fails a page is nearly
     * always what would fail any other at that moment — the link, the venue, a
     * write that could not get its turn — so moving on to another prefix gains
     * nothing and leaves this one half read. The page is read again from the
     * same cursor after a wait that grows, which is what resuming it later would
     * do anyway: nothing of a page counts until its cursor is written.
     *
     * A refusal that is the venue's final answer (see `answered`) is never
     * repeated here, nor is a `StoodDown`: the venue is paused, and the pass
     * ends on it as on a block. A retryable status that outlasted the fetch's
     * own attempts — a 5xx, a throttling 429 — is retried like a transport
     * error, and so is a transfer `deliver` refused. Past `PAGE_ATTEMPTS` the
     * page is taken to be wrong in a way waiting does not mend, and the prefix
     * is left for the next pass.
     */
    let read = 0;

    for (let attempt = 1; ; attempt++) {
      try {
        const page = kind === 'update'
          ? updatePage(db, venueId, short, cursor, rules!)
          : await adapter.scanner.page(context, scope, cursor);

        read = performance.now();

        const files = catalogued(db, adapter, venueId, page.listed,
          kind === 'walk' ? new Date(run.started) : null);

        /**
         * **A generated key is a backlog row and nothing else.** It carries no size
         * and no etag, so `putFiles` could only ever park it — the `file` table and
         * the month rollup have no part in an update. Going straight to `wip` lets
         * the pages of every lane and every venue share one transaction instead of
         * spending a slice, and a turn of the event loop, on sixteen rows.
         *
         * A walk keeps `putFiles`: its findings are a mix of rows that are complete
         * and rows that are not, and which table each lands in is that function's
         * whole job.
         *
         * Both await the write, so a cursor still only moves over work on disk.
         */
        if (kind === 'update') {
          /**
           * **What to ask next travels with the key, and only generation knows it.**
           * A `CatalogFile` is what a file *is*; what the venue said follows it is
           * how the period is finished, so it is carried across here rather than
           * written into the row's shape.
           */
          const parts = new Map(page.listed
            .filter(one => one.nextPart)
            .map(one => [relative(adapter, one.key), one.nextPart!]));

          await parkSoon(db, files.map(one => ({
            venueId:   one.venueId,
            path:      one.path,
            date:      one.date,
            seriesId:  one.seriesId,
            existence: one.existence,
            tries:     0,
            ...(parts.has(one.path) ? { nextPart: parts.get(one.path)! } : {}),
          })));
        }
        else
          /**
           * Committed in short slices with the loop handed back between them, so a
           * page of writes cannot hold the thread — see `putFiles`. Each slice is
           * still atomic, and still cannot interleave with another partition's.
           *
           * **Withdrawal rides the page.** What the page covered it covered in
           * full, so anything catalogued there that it did not list is gone — said
           * here, with nothing written for the keys that did not change. Only a walk
           * can say it: an update generates the dates a series is missing and claims
           * nothing about what is no longer offered.
           *
           * **Judged against what the page listed, not against what it
           * catalogued.** A key this catalog declines — excluded, refused by the
           * adapter, unplaceable — is still a key the venue serves, and its row,
           * where one exists, is not withdrawn for it.
           */
          withdrawn += await putFiles(db, files, page.covers && spanOf(adapter, venueId, short, page.covers),
            new Set(page.listed.map(entry => relative(adapter, entry.key))));

        /**
         * **Before the cursor, always.** The bounds this page derived are held in
         * memory, and the cursor is the promise that the page will not be read
         * again. Advancing one over the other is how a series ends up on disk with a
         * `first` later than the truth, and nothing afterwards re-reads the page
         * that would have corrected it — see `flushTips`.
         */
        flushTips(db);

        cursor = page.cursor;
        requests++;
        found += files.length;
        live.pages++;
        live.found += files.length;

        advanceRun(db, run.id, cursor, 1, files.length);

        /**
         * **On the cadence the cursor already sets.** A page is one listing request
         * or a thousand generated keys, so riding it writes the counts often enough
         * to watch and rarely enough to cost nothing next to the write above.
         */
        flushCounts(db, adapter);

        break;
      } catch (err) {
        // Told to stop while the request waited: where it stands is on disk, so it simply leaves.
        if (err instanceof Stopped) return { requests, found, closed: false };

        if ((err instanceof Refused && answered(adapter, err.status, err.headers))
          || err instanceof StoodDown || attempt >= PAGE_ATTEMPTS)
          throw err;

        // Said once it is clearly more than a blip, and not again for the same page.
        if (attempt === PAGE_ATTEMPTS_QUIET)
          logger.warn({ ...fault(err), venue: labelOf(adapter), scope: short, attempts: attempt },
            'A page keeps failing; still trying');

        await retryWait(backoffDelay(attempt, { baseMs: RETRY_MS, maxMs: RETRY_MAX_MS, jitter: 'none' }));

        // Told to stop while it waited: where it stands is on disk, so it simply leaves.
        if (stopped()) return { requests, found, closed: false };
      }
    }

    if (kind === 'walk') timed(labelOf(adapter), 'process', performance.now() - read);

    /**
     * A large prefix is thousands of pages and runs for hours. Without a line
     * while it works, a slow partition and a wedged one look identical — so it
     * reports where it has reached, which is the part that says whether anything
     * is moving.
     *
     * **Whichever comes first, pages or minutes.** Counting pages alone says
     * nothing while a partition is not turning any: a venue that asked us to
     * wait an hour, or a request that will not answer, produces exactly the same
     * silence as a survey that has finished.
     */
    if (requests % PROGRESS_EVERY === 0 || Date.now() - spoke > QUIET_MS) {
      spoke = Date.now();
      logger.info({
        venue:       labelOf(adapter),
        scope:       short,
        pages:       requests,
        found,
        at:          cursor ? relative(adapter, cursor) : null,
        // Rows kept per page, not the page size — a page is 1000 keys, and on a
        // venue publishing checksum sidecars half of them carry no date and are
        // never stored. Roughly 500 here means that filter is working.
        rowsPerPage: Math.round(found / requests),
      }, 'Surveying');
    }

    /**
     * Everything above this point is committed and the cursor is written down,
     * so leaving now costs nothing and the next turn resumes here. The run is
     * deliberately **not** closed: an unclosed run is what keeps the venue from
     * being claimed as established over keyspace nobody has read.
     */
    const why = stopped();

    if (why) {
      // A requested pause is said once, for the venue — not once per partition.
      if (why !== 'paused')
        logger.info({ venue: labelOf(adapter), [said.unit]: named(db, kind, short),
          pages: requests, found, at: cursor },
        why === 'blocked' ? 'Partition paused: venue blocking us'
          : why === 'aborting' ? 'Partition paused: the pass is ending'
            : 'Partition paused for splitting');

      return { requests, found, closed: false };
    }
  } while (cursor);

  closeRun(db, run.id);

  logger.info(
    { venue: labelOf(adapter), [said.unit]: named(db, kind, short), pages: requests, found,
      ...(withdrawn ? { withdrawn } : {}),
      established: run.started, seconds: elapsed(started) },
    said.done,
  );

  return { requests, found, closed: true };
};

/**
 * What the adapter contributes to generating a key, and what the seed does.
 *
 * **The seed's horizon is offered on a first pass and never again.** A venue
 * nothing can list arrives with its series declared rather than discovered, and
 * that declaration carries where each one had got to — so until a pass has
 * completed, generation can leave out the span between a series' newest seeded
 * file and the seed's own date, which the seeding pass already looked at. Once
 * any pass has completed, the catalog's own tips say how far it has been asked
 * and the seed has nothing left to add.
 *
 * A venue that can be walked never gets this: it discovers what it holds, so
 * there is no declaration to lean on and nothing to leave out.
 */
const rulesFor = (db: DatabaseSync, venueId: number, adapter: Adapter): Rules => {
  const rules: Rules = {
    slots: adapter.slotsFor,
    ...(adapter.probingLag !== undefined ? { lag: adapter.probingLag } : {}),
    ...(adapter.expandParts ? { parts: adapter.expandParts.bind(adapter) } : {}),
  };

  if (adapter.listable === false && ! everCompleted(db, venueId)) {
    const seeded = seriesSeededAt(adapter.name);

    if (seeded !== null) rules.seededAt = seeded;
  }

  return rules;
};

const catalogued = (
  db:      DatabaseSync,
  adapter: Adapter,
  venueId: number,
  listed:  readonly Listed[],

  /**
   * When the walk began, or null where these keys were generated rather than
   * read.
   *
   * **What separates the source of truth from a guess.** A walk states a
   * series' bounds from the file in front of it, because it is reading the
   * index and the index is the archive. An update has generated the key it is
   * holding, so a sighting says nothing about where the series starts or
   * whether it is finished — its only bound is the tip, and that moves on an
   * answer rather than on a candidate.
   */
  since:   Date | null,
): CatalogFile[] => {
  const files: CatalogFile[] = [];
  const seenAt = new Date().toISOString();

  /** Paths this venue's adapter could not place, kept for the worklist. */
  const unread: { path: string; reason: Unreadable['reason'] }[] = [];

  for (const entry of listed) {
    const path = relative(adapter, entry.key);

    // Policy first, then parsing: a venue may refuse a path outright, and one
    // that carries no date is not a file this catalog can place. The enumerated
    // known-bad files are checked before the adapter's rules, so a wrong file
    // never enters the catalog and nothing built on it has to know.
    if (isExcluded(adapter, path)) continue;

    if (adapter.accepts && ! adapter.accepts(path)) continue;

    /**
     * **What no venue should ever catalogue** — a checksum, an index page, an
     * uncompressed stray. Dropped before the reader, so that no adapter has to
     * carry a rule every archive shares.
     */
    if (excludedAnywhere(path)) continue;

    /**
     * **What this path is, where the source did not already say.**
     *
     * The series is recorded as a side effect of walking, which is the only
     * affordable moment: deriving the same thing later means a maximum per
     * series over millions of rows.
     *
     * **A key that arrived with its series is not read back.** It was generated
     * from that series, so parsing it can only agree or be wrong — and being
     * wrong is silent, filing a file under a neighbouring instrument. Which is
     * decided on the entry rather than on what kind of pass produced it: the
     * question is whether the fact is already in hand, not who is asking.
     *
     * A venue with no `inspectUrl` places nothing this way, so its paths are
     * listed as unplaced — a gap, not a wrong answer.
     */
    const seen = entry.seriesId === undefined ? adapter.inspectUrl?.(path) : undefined;

    /**
     * **A shape nobody anticipated is written down, not guessed at.** Reading it
     * anyway would put a plausible row naming a directory as though it were an
     * instrument into the catalog, and a wrong series is not visible afterwards.
     *
     * Its path goes to `unreadable` instead of `file`, so nothing is lost
     * while the shape waits for a reader: a walk after the adapter's
     * `inspectUrl` learns the shape catalogues it.
     */
    if (seen?.of === 'unknown') unread.push({ path, reason: 'unread' });

    /**
     * **Whichever reader already has it.** `inspectUrl` cannot place a path
     * without finding its date, so consulting `dateOf` afterwards re-derives
     * what was just returned; and a generated key carries the period it was
     * built for. `dateOf` remains the fallback because every adapter has one
     * while `inspectUrl` is optional.
     */
    const date = seen?.date ?? adapter.dateOf(path);

    // A path with no date is not a file this catalog can place.
    if (! date) continue;

    /**
     * **A walk states the bounds; an update states nothing.** The same sighting
     * means different things depending on which produced it, so the two take
     * different calls rather than one call with a flag buried in it.
     *
     * Reached only where the source did not name the series itself: a key built
     * from a row already has its id, and nothing here can improve on it.
     */
    const seriesId = entry.seriesId ?? (seen?.of !== 'series' ? null
      : since ? walkSeries(db, venueId, seen.found, date, since).id ?? null
        : seriesOf(db, venueId, seen.found)?.id ?? null);

    /**
     * **A file this catalog cannot place is not catalogued**, it is listed as
     * unreadable. A row with no series answers none of the questions `file`
     * exists to answer — no market, no symbol, no dataset — so it goes on the
     * list of shapes waiting for a reader instead, and a walk after one is
     * taught catalogues its files properly.
     *
     * A path the reader already declined is on that list from above; what is
     * added here is the rest — a venue with no reader at all, and a shape read
     * into a series this catalog does not hold.
     */
    if (seriesId === null) {
      if (seen?.of !== 'unknown') unread.push({ path, reason: 'unplaced' });

      continue;
    }

    files.push({
      venueId,
      path,
      date,
      seriesId,
      size:      entry.size,
      etag:      entry.etag,
      modified:  entry.modified,
      /**
       * **Who said this key exists.** A listing cannot name a file that is not
       * there, so anything a walk returns is established; a generated key is
       * supposed, and nothing has seen it yet.
       *
       * Recorded on the row because the probe that settles it may run under a
       * later pass of the other kind, and what a `404` is worth depends on
       * which of the two parked it rather than on which is running now.
       *
       * **Only an update demotes a key.** Where no pass is on record — nothing
       * is surveying, and a caller reached this directly — the patient budget is
       * the safe one: being slow to write a key off costs requests, while being
       * quick to costs the file.
       */
      existence: surveying(adapter) === 'update' ? 'assumed' : 'confirmed',
      seenAt,
    });
  }

  if (unread.length > 0) {
    putUnreadable(db, venueId, unread);

    logger.warn({
      venue: adapter.name,
      paths: unread.length,

      /**
       * One example rather than the list: a page can be a thousand keys of the
       * same unread shape, and what is wanted is the shape. The rest are in
       * `unreadable`, which is where they are read from afterwards.
       */
      example: unread[0]!.path,
    }, 'Unrecognised files; recorded for review');
  }

  return files;
};

/** Whole seconds, for a log line rather than for arithmetic. */
const elapsed = (since: number): number => Math.round((Date.now() - since) / 1000);

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_catalogued = catalogued;

export const _test_SPLIT_MS = SPLIT_MS;

/** Wait between attempts at a page as this says, or as the service does again. */
export const _test_retryWait = (wait: ((ms: number) => Promise<void>) | null): void => {
  retryWait = wait ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
};
