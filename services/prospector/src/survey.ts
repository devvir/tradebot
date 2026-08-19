import { logger } from '@devvir/service-kit';
import { fault } from './faults';
import {
  advanceRun,
  beginJob,
  everCompleted,
  closeRun,
  flushTips,
  markWithdrawn,
  openJob,
  openPartitions,
  refinePartition,
  putFiles,
  putUnreadable,
  seriesById,
  seriesOf,
  settleWalk,
  venueIdOf,
  walkSeries,
} from './catalog';
import { surveying } from './context';
import { loadExclusions, isExcluded } from './exclusions';
import { Refused, blocked } from './http';
import { describeWait, labelOf, lanesFor, paceFor } from './pace';
import { ceiling, excludedAnywhere, relative } from './paths';
import { seriesSeededAt } from './database/migrations/seeds/seed';
import { updatePage, updateScopes } from './update';
import type { Rules } from './update';
import type { Occasion, CatalogFile, Run, RunKind } from './types';
import type { DatabaseSync } from 'node:sqlite';
import type { Adapter, Config, Listed, Survey } from './types';

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
   * **Said before anything slow happens.** Establishing a constructed-key
   * venue's bounds can run for minutes before the first partition exists, and a
   * survey that answers `started` and then prints nothing is indistinguishable
   * from one that has failed.
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
  loadExclusions(db, adapter.name, venueId);

  /**
   * **One run, reached two ways.** A full survey walks the venue's keyspace; a
   * partial one generates the dates each series is missing and probes them.
   * Everything after the scopes exist is identical — the same partitions, the
   * same cursors committed page by page, the same job that stays open until each
   * is exhausted — which is what makes both stoppable and resumable by the same
   * code.
   *
   * They are kept in separate rows so that neither can be mistaken for the
   * other: an update's scopes say nothing about the keyspace a walk covers, and
   * `establishedAt` asks only about walks.
   */
  const kind: RunKind = occasion === 'partial' ? 'update' : 'walk';
  const open = openJob(db, venueId, kind);

  /**
   * **Everything the scanner will need, assembled once and carried down.**
   *
   * Built here rather than when the job opens, because a resume has no job to
   * open and still needs it — a context lives in memory, so a restart mid-walk
   * arrives with nothing. For a venue that constructs its keys this is also
   * where its bounds are established, which is why it may take a while.
   *
   * **Built from what was asked for, not from what happens to be open.** A
   * resume works from what is already known and asks the venue nothing; only a
   * refresh sends an adapter back to establish its own knowledge. Inferring
   * this from an open job made every resume of a closed-but-incomplete venue a
   * full re-establishment.
   */
  const context = await adapter.getContext(db, occasion);

  /**
   * **Mapping can be refused too, and it is the first thing a new venue does.**
   * Left to throw, it leaves the loop above with nothing to say the venue is
   * blocking us, so the generic failure path retries in thirty seconds — against
   * a ban, forever. It reports the same way a walk does instead.
   */
  let job: Run;

  try {
    job = open ?? await partition(db, adapter, lanes, venueId, context, kind);
  } catch (err) {
    if (! (err instanceof Refused) || ! blocked(adapter, err.status, err.headers)) throw err;

    logger.error({
      err, venue: labelOf(adapter), status: err.status, ...err.detail, ...paceFor(adapter, adapter.list).rates(),
    }, `Venue refused the archive mapping — nothing is established yet, ` +
       `retrying ${describeWait(paceFor(adapter, adapter.list).blockedFor())}`);

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

  /**
   * The work list, which **grows while it is being worked**.
   *
   * A survey ends when its slowest partition does, so one prefix holding a
   * disproportionate share of the archive decides the whole run however fast the
   * rest finish — binance's spot klines is 29,150 pages and gate's spot books
   * around 9,500, each walked by one worker while the others idle.
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

  const walkOne = async (partition: Run, runner: Runner) => {
    /**
     * Once a venue is refusing this address, every remaining partition will be
     * refused too — and each attempt is another request against a ban that only
     * lapses while nothing is asking. So the rest of the venue is left for the
     * next turn of the loop, which by then will have waited.
     */
    if (summary.blocked || paused()) return;

    try {
      /**
       * **A partition already reading stops between pages, not at its own 403.**
       * Skipping only the partitions that had not started yet leaves the other
       * nineteen paging on, and each one earns its own refusal before it notices
       * — nineteen more requests against a ban that lapses only while nothing is
       * asking. They keep their cursors, so this costs nothing but the wait.
       */
      const done = await sweep(db, adapter, partition, context, kind,
        () => (summary.blocked ? 'blocked'
          : paused() ? 'paused'
            : runner.stopping ? 'splitting' : null));

      summary.requests += done.requests;
      summary.found    += done.found;
    } catch (err) {
      /**
       * The partition keeps its row and its cursor, so this is a pause rather
       * than a loss. What matters is that the job is **not** closed below:
       * leaving it open is what brings the loop straight back here instead of
       * declaring the venue established and sleeping until the next refresh.
       */
      summary.failed++;

      if (err instanceof Refused && blocked(adapter, err.status, err.headers)) summary.blocked = true;

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
        ...(summary.blocked ? { blocked: true, ...paceFor(adapter, adapter.list).rates() } : {}),
      }, summary.blocked
        ? 'Partition refused — the venue is blocking us, so the rest of this pass stops'
        : 'Partition failed — the job stays open and it will be retried');
    }

    settled++;

    logger.info({
      venue:    labelOf(adapter),
      progress: `${settled}/${settled + queue.length + running.size}`,
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
     * nowhere. Every path out of here that does not replace it with children has
     * to requeue it, or it is simply abandoned: not walked, not closed, and
     * invisible until something notices the venue can never be established.
     *
     * That is not hypothetical. Two gate book prefixes were left exactly this
     * way, stopped mid-alphabet with 3,378 requests of progress, under a job
     * that closed over them twenty-two hours later.
     */
    const giveBack = () => { queue.push(at); };

    /**
     * **Whatever this throws, the partition is owed back.** It was stopped to be
     * split and `sweep` honoured that by returning without closing it, so right
     * now it is open, holding a cursor and running nowhere. Reading its children
     * is a request like any other and can fail like any other — and a failure
     * here without giving it back would leave it in neither the queue nor the
     * running set, invisible until somebody noticed the venue could never be
     * established.
     */
    let children: string[];
    let files:    boolean;

    try {
      ({ children, files } = await adapter.scanner.level(context, adapter.root + at.scope));
    } catch (err) {
      giveBack();

      throw err;
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
        'Partition cannot be split further — resuming it whole');

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
        'Partition cannot be split further — every child is behind its cursor, resuming it whole');

      return;
    }

    const made = refinePartition(db, at, scopes);

    queue.push(...made);

    logger.info({ venue: labelOf(adapter), scope: at.scope, into: made.length, pages: at.requests },
      'Partition split — its children are queued');
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
      if (summary.blocked || paused()) return false;
      if (queue.length > 0) return true;
      if (running.size === 0) return false;
      if (terminal.has('')) return false;

      if (refining) {
        await refining;

        continue;
      }

      refining = refine();

      try {
        await refining;
      } catch (err) {
        logger.error({ ...fault(err), venue: labelOf(adapter) }, 'Could not split a partition');

        return false;
      } finally {
        refining = null;
      }
    }
  };

  const lane = async (): Promise<void> => {
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
  };

  /**
   * **Proof of life for the survey itself, not for any one partition.**
   *
   * A partition reports while it is turning pages, which says nothing when the
   * problem is that none of them are. htx stopped with 46 partitions queued, no
   * open sockets, an idle event loop and not one line in an hour — and there was
   * no way to tell that from a survey that had quietly finished. The counts
   * below separate them: a lane count that never moves, with work still queued,
   * is a stall and says so.
   *
   * `refining` is included because it is the one thing every idle lane waits on
   * at once, which makes a single stuck split look exactly like this.
   */
  const alive = setInterval(() => {
    logger.info({
      venue:    labelOf(adapter),
      settled,
      queued:   queue.length,
      running:  running.size,
      refining: refining !== null,
      scopes:   [...running.keys()].length,
    }, 'Survey still working');
  }, QUIET_MS).unref();

  try {
    await Promise.all(Array.from({ length: lanes }, () => lane()));
  } finally {
    clearInterval(alive);
  }

  advanceRun(db, job.id, null, summary.requests, summary.found);

  /**
   * **A job closes only when every partition did**, and counting failures is not
   * enough to know that. A partition can end this loop neither failed nor
   * closed — stopped for a split that then did not happen — and such a run is
   * invisible to `summary`. Left unchecked the job closes over it, the venue
   * reads as established, and a prefix with a live cursor is never walked again
   * by anything.
   */
  const abandoned = openPartitions(db, venueId, kind).filter(one => one.scope !== '');

  summary.paused = paused();

  if (summary.paused) {
    logger.info({ ...summary, job: job.started },
      'Venue paused — every cursor is kept and starting it again continues from here');

    return summary;
  }

  if (summary.failed === 0 && abandoned.length === 0) {
    summary.generated = true;

    /**
     * **A walk's job closes here; an update's does not.**
     *
     * For a walk this is the end of the pass: the keyspace has been read, the
     * bounds are on disk, and the closed job is what `phaseOf` and
     * `establishedAt` read to say the venue has been established.
     *
     * For an update it is only the end of *generation*. The keys are in `wip`
     * and mostly unasked — probing them is where the hours go — and the pass
     * ends when they have been drained and the tips settled. Closing the job at
     * this moment is what made a restart during the drain find nothing open and
     * plan the whole pass again, throwing away a per-series completion record
     * for every series it had already finished.
     *
     * What ends an update instead is reconciliation deleting its rows — see
     * `clearUpdate`.
     */
    if (kind === 'walk') closeRun(db, job.id);

    /**
     * **The tips are earned here, and nowhere earlier.** A walk states each
     * series' start and newest file as it meets them, but a tip is a claim about
     * a *range* having been asked about, and no single file is evidence of that
     * — reading the index to the end is. So it is stated once, over every series
     * of the venue, at the one moment that is true.
     *
     * Which is why it is inside this branch: a walk that left a partition unread
     * offered part of a keyspace and proved nothing about the rest, and a tip
     * does not come back.
     */
    const settled = kind === 'walk' ? settleWalk(db, venueId, new Date(job.started)) : 0;

    logger.info({ ...summary, established: job.started, ...(settled > 0 ? { settled } : {}) },
      'Venue surveyed');
  } else {
    logger.warn({ ...summary, job: job.started,
      ...(abandoned.length > 0 ? { abandoned: abandoned.map(one => one.scope) } : {}) },
    'Venue incomplete — the job stays open and its partitions will be retried');
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
 * All three read identically from inside `sweep` — cursor committed, run left
 * open — and mean quite different things to whoever is watching: a venue turning
 * us away, this service reorganising its own work, or somebody asking for the
 * survey to stop.
 */
type StopReason = 'blocked' | 'splitting' | 'paused' | null;

/** Whether splitting here would actually produce work, rather than closing a run for nothing. */
const divisible = (cursor: string | null, children: readonly string[]): boolean =>
  cursor === null || children.some(child => cursor < ceiling(child));

/** Pages between progress lines. Small enough to see movement, rare enough to read. */
const PROGRESS_EVERY = 25;

/**
 * How long a partition may say nothing before it says something anyway.
 *
 * The point is not the progress, it is the proof of life: a walk that is waiting
 * out a venue's `Retry-After` looks exactly like a walk that has stopped.
 */
const QUIET_MS = 120_000;

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
      'Update opened — generating what each series is missing');

    return job;
  }

  logger.info({ venue: labelOf(adapter), root: adapter.root }, 'Mapping the archive');

  // Split for the workers this venue will actually have — see `lanesFor`.
  const mapped = await adapter.scanner.scopes(context, { concurrency: lanes });

  // Partitions are stored **relative** to the venue root, so they can be matched
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
  stopped: () => StopReason,
): Promise<{ requests: number; found: number }> => {
  const short   = run.scope;
  const venueId = run.venueId;

  // The scanner works in the venue's own keyspace, so the root goes back on;
  // the cursor needs no such treatment, being a marker the venue gave us and
  // which is handed back verbatim.
  const scope = adapter.root + short;

  const said = words(kind);

  logger.info(
    { venue: labelOf(adapter), [said.unit]: named(db, kind, short),
      ...(run.cursor ? { resumingFrom: run.cursor } : {}) },
    run.cursor ? `Resuming ${said.unit}` : `${said.doing} ${said.unit}`,
  );

  const started = Date.now();

  let cursor   = run.cursor;
  let requests = 0;
  let found    = 0;
  let spoke    = Date.now();

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

    const page  = kind === 'update'
      ? updatePage(db, venueId, short, cursor, rulesFor(db, venueId, adapter))
      : await adapter.scanner.page(context, scope, cursor);
    const files = catalogued(db, adapter, venueId, page.listed,
      kind === 'walk' ? new Date(run.started) : null);

    // Committed in short slices with the loop handed back between them, so a page
    // of writes cannot hold the thread — see `putFiles`. Each slice is still
    // atomic, and still cannot interleave with another partition's.
    await putFiles(db, files);

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

    advanceRun(db, run.id, cursor, 1, files.length);

    /**
     * A prefix the size of binance's spot klines is thousands of pages and runs
     * for hours. Without a line while it works, a slow partition and a wedged
     * one look identical — so it reports where it has reached, which is the part
     * that says whether anything is moving.
     *
     * **Whichever comes first, pages or minutes.** Counting pages alone says
     * nothing while a partition is not turning any: a venue that asked us to
     * wait an hour, or a request that will not answer, produces exactly the same
     * silence as a survey that has finished — which is the state that cost an
     * afternoon to tell apart.
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
      logger.info({ venue: labelOf(adapter), [said.unit]: named(db, kind, short),
        pages: requests, found, at: cursor },
      why === 'blocked'
        ? `Pausing ${said.unit} — the venue is blocking us, and its cursor is kept`
        : why === 'paused'
          ? `Pausing ${said.unit} — a stop was asked for, and its cursor is kept`
          : `Pausing ${said.unit} — it is being split, and its children resume from its cursor`);

      return { requests, found };
    }
  } while (cursor);

  /**
   * Anything in this range the venue did not offer this time has been withdrawn.
   * It is marked, never removed: what a venue once published stays on record,
   * and a consumer that wants only live files says so.
   *
   * The epoch is the **job's** start, shared by every partition, so a walk that
   * began hours after the job did still measures against the moment the job
   * targeted. Only meaningful on a re-walk: the first job over a venue has
   * nothing older than itself, so this marks nothing.
   *
   * **Only a walk can say a file was withdrawn**, because only a walk covers a
   * range exhaustively. An update generates the dates a series is missing and
   * claims nothing about what is no longer offered, so a range it finished says
   * nothing about the keys inside it that it never asked for.
   */
  const withdrawn = kind === 'walk'
    ? markWithdrawn(db, venueId, short, ceiling(short), run.started)
    : 0;

  closeRun(db, run.id);

  logger.info(
    { venue: labelOf(adapter), [said.unit]: named(db, kind, short), pages: requests, found,
      ...(withdrawn ? { withdrawn } : {}),
      established: run.started, seconds: elapsed(started) },
    said.done,
  );

  return { requests, found };
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
  const rules: Rules = { slots: adapter.slotsFor };

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
  const unread: { path: string; reason: string }[] = [];

  for (const entry of listed) {
    const path = relative(adapter, entry.key);

    // Policy first, then parsing: a venue may refuse a path outright, and one
    // that carries no date is not a file this catalog can place. The enumerated
    // known-bad files are checked before the adapter's rules, so a wrong file
    // never enters the catalog and nothing built on it has to know.
    if (isExcluded(adapter.name, path)) continue;

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
     * A venue with no `inspectUrl` yet takes the old path and records nothing —
     * a gap, not a wrong answer.
     */
    const seen = entry.seriesId === undefined ? adapter.inspectUrl?.(path) : undefined;

    /**
     * **A shape nobody anticipated is written down, not guessed at.** Reading it
     * anyway would put a plausible row naming a directory as though it were an
     * instrument into the catalog, and a wrong series is not visible afterwards.
     *
     * The file is still catalogued if it carries a date, so nothing is lost
     * while the shape waits to be read — it simply has no series, which is what
     * `unreadable` is the list of.
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
    }, 'Paths this venue cannot yet be read into a series — recorded for review');
  }

  return files;
};

/** Whole seconds, for a log line rather than for arithmetic. */
const elapsed = (since: number): number => Math.round((Date.now() - since) / 1000);

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_catalogued = catalogued;
