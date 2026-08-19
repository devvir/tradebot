import { logger } from '@devvir/service-kit';
import { fault } from './faults';
import { dropWip, missedFiles, parkKeys, settleFiles } from './catalog';
import { blocked, etagOf, fetchHead } from './http';
import { REFUSALS_BEFORE_BLOCK, describeWait, labelOf, paceFor } from './pace';
import { pool } from './pool';
import type { Parking, Settlement, Unsettled } from './types';
import type { DatabaseSync } from 'node:sqlite';
import type { Adapter, Pacing, Probe, Verdict, Work } from './types';

/**
 * Settle the metadata of files somebody already knows exist.
 *
 * **A walk establishes what is there; a probe establishes what it is.** On a
 * venue that publishes listings the two arrive together, because a listing
 * carries size and checksum. On a venue that publishes browsable indexes it
 * carries neither, and the difference matters: "how much disk does this cost,
 * and how long will it last" is unanswerable from paths alone.
 *
 * **Nothing here knows what it is probing.** The work arrives as a function that
 * hands back the next rows, so the same code serves a venue's whole catalog, one
 * month of it, or a table of candidates built for a venue that cannot be listed
 * at all. Give it rows, it settles them.
 *
 * **Nor does it decide how hard to push.** The rate belongs to the venue and is
 * enforced for every caller at the fetch itself, so nothing here has to hold
 * back — `concurrency` below is how many rows may be in hand at once, and the
 * gate decides when each of them actually goes out.
 *
 * It fetches nothing: a HEAD asks what a file is without moving it.
 */
export const probeFiles = async (
  db:      DatabaseSync,
  adapter: Adapter,
  work:    Work,
  pacing:  Pacing,
  paused:  () => boolean = () => false,
): Promise<Probe> => {
  const summary: Probe = {
    venue: labelOf(adapter), settled: 0, missing: 0, refused: 0, failed: 0, requests: 0,
    dropped: 0, implied: 0, absent: 0, abandoned: false, stopped: false,
  };

  const started = Date.now();
  const pace    = paceFor(adapter, adapter.base);

  /**
   * **Where the sweep has got to, as a row id.** Not a date: a walk running
   * beside this one parks rows for days already behind the cursor, and ordering
   * by date would leave them there until the next pass. An id only ever grows,
   * so a row parked mid-sweep lands ahead of it and is reached in this one.
   */
  let after = 0;
  let batches = 0;

  /**
   * Refusals aimed at us with no answer in between — the same rule the limiter
   * applies, kept here as well because this is what ends the pass.
   *
   * **One refusal is a bad second, not a ban.** bitget's CDN was asked 597,000
   * times in an afternoon, up to 3,500 a second, and refused nothing — so every
   * stand-down ever taken on that venue came from a one-off, and each cost a
   * pass. A venue genuinely turning us away fails every lane at once and reaches
   * this within a fraction of a second.
   */
  let refusals = 0;

  /**
   * **Whether this pass found anything to do**, which is what decides if the
   * backlog is worth counting at all.
   *
   * `wip` reaches tens of millions of rows per venue, and counting them is O(n)
   * however it is asked: every index of a `WITHOUT ROWID` table carries the
   * primary key, so `path` is in all of them and there is no narrow one to add
   * — SQLite already answers this from the smallest it has. Four seconds for
   * bitget, synchronous, with the whole process stopped behind it.
   *
   * Against a pass that runs for hours that is nothing, and the figure is what
   * says how far along it is. Against a pass with an empty backlog it is the
   * entire cost of the pass, paid every time a venue is idle. So it is counted
   * once the first batch proves there is work, and not before.
   */
  let working = false;

  /**
   * **A heartbeat on a clock, not on batch boundaries.**
   *
   * Docker logs are how this service is watched, and a pass that reports only
   * when a batch lands is indistinguishable from a dead one whenever it is slow,
   * paused or stuck — which are exactly the states somebody is looking for. So
   * it speaks on a timer instead, and says whether it is paused, which separates
   * "waiting out a refusal" from "wedged".
   */
  const heartbeat = setInterval(() => {
    const paused   = pace.blockedFor();
    const produced = work.produced?.() ?? null;
    const flow     = pace.rates();

    logger.info({
      venue: labelOf(adapter),

      /**
       * **What the producing half has written, against what this has settled.**
       *
       * The pair is the whole point. `settled` alone says nothing about whether
       * a pass is nearly done or barely started, and the backlog read once at
       * the start is worse than nothing — a walk keeps writing rows, so the pass
       * settling them overtakes it and the line reads "96,000 of 39,882".
       *
       * This comes from the producer's own running total instead, so it moves,
       * and the gap between the two says whether the probe is keeping up.
       */
      ...(produced === null ? {} : { produced }),
      requests: summary.requests,
      settled:  summary.settled,
      missing:  summary.missing,

      /**
       * **One field, because they are one question.** Both are zero on every
       * healthy pass this venue has ever run, and two zeroes repeated every
       * thirty seconds train the eye to skip the line. The pair is spelled out
       * only when there is something in it.
       */
      'refused / failed': summary.refused === 0 && summary.failed === 0
        ? 0
        : `${summary.refused} / ${summary.failed}`,

      /**
       * **A share rather than a count, because the count means nothing alone.**
       * Five hundred retries is a healthy afternoon at a thousand a second and a
       * venue falling over at ten. Measured against everything that left the
       * gate, since that is what a retry is a part of.
       */
      'retries (%)': share(flow.retries, flow.sentTotal),

      /**
       * **What the pass is actually running at, over minutes rather than
       * seconds.** A ten-second window on a venue that pauses reports a collapse
       * whenever a stand-down falls inside it and full speed whenever one does
       * not, so it says more about where the window landed than about the pass.
       * The short windows and the peak are kept for the lines about a venue
       * refusing us, where a burst and a steady climb are what have to be told
       * apart — see `pace.rates`.
       */
      'lastMinute (req/s)': flow.lastMinute,
      'lastHour (req/s)':   flow.lastHour,
      inFlight:             flow.inFlight,
      ...(paused > 0 ? { pausedSeconds: Math.round(paused / 1000) } : {}),
    }, paused > 0 ? 'Probing — paused, waiting out a refusal' : 'Probing');
  }, HEARTBEAT_MS);

  heartbeat.unref();

  for (;;) {
    /**
     * **Read every time a batch is loaded, because that is the only boundary
     * this loop has.** A pass ends when the backlog empties, and on a venue
     * whose keys are constructed that is a week away — so a stop read once per
     * pass is a stop that never lands. Somebody who asks for a pause watches
     * the heartbeat go on printing and concludes the service ignored them.
     *
     * Here rather than inside the pool: the batch in flight settles, records
     * its attempts and moves the cursor exactly as it would have, so nothing is
     * cancelled and nothing is asked twice. The cost of that is the seconds one
     * batch takes, which is what "stops after the page it is on" means
     * everywhere else in this service.
     */
    if (paused()) {
      summary.stopped = true;

      break;
    }

    const batch = work.next(after, pacing.batch);

    if (batch.length === 0) break;

    /** There is work, so the backlog is worth what it costs to state. */
    if (! working) {
      working = true;

      logger.info({
        venue:       labelOf(adapter),
        outstanding: work.remaining?.() ?? null,
        perSecond:   pacing.perSecond,
        lanes:       pacing.concurrency,
      }, 'Probing files for existence and metadata');
    }

    const settled: Settlement[] = [];

    /** Asked and not settled — their attempt is counted whatever the reason. */
    const missed:  Unsettled[]  = [];

    /** Spent: nobody is going to settle these, so they stop being offered. */
    const spent:   Unsettled[]  = [];

    /**
     * Keys the venue's answers implied, which nothing generated: the next part
     * of a split file, the members a manifest names. Parked before the row that
     * revealed them settles, so a crash between the two costs a repeated probe
     * rather than the keys.
     */
    const implied: Parking[]    = [];

    /**
     * What becomes of a row the venue did not settle.
     *
     * **Absence is the only answer that takes a row off the list**, and only
     * once it has been given more than once. A single 404 is not enough: the key
     * may be published moments later, and a pass that took the first miss as
     * final would leave the period to be retired wholesale by reconciliation
     * without ever being asked again. `CONFIRMATIONS` attempts across the pass'
     * sweeps is what makes it an answer rather than a moment.
     *
     * How a venue *spells* absence is the adapter's to say — bitget's bucket
     * grants `GetObject` without `ListBucket`, so a key it does not have comes
     * back `403 AccessDenied`, separable only by its headers. A `drop` verdict
     * means absence however it arrived; `keep` overrules in the other direction.
     *
     * **Everything else keeps its row, for as long as the service runs.** A 429,
     * a 5xx, a reaped connection say nothing whatever about the file, so there
     * is nothing to conclude and no count to run down. The row stays in `wip`
     * and the pass does not finish — which is exactly what should happen, and
     * what makes a venue answering nonsense visible rather than quietly worked
     * around. Every venue here is S3, OSS, or a known CDN in front of one; if
     * that stops being true it will be a venue with a name, and it can have a
     * rule of its own then.
     *
     * **Nothing here settles a period by the clock.** `OVERDUE_DAYS` acts once,
     * in reconciliation, over a pass that finished.
     */
    const judge = (
      row:     Unsettled,
      status:  number,
      verdict: Verdict | null,
    ): void => {
      missed.push(row);

      if (verdict === 'keep') return;

      const absent = verdict === 'drop' || status === 404;

      if (! absent) return;

      /**
       * **A confirmation is progress even though nothing moved.** The caller
       * paces its rounds on this: a venue repeating that a key is not there is
       * working towards an answer, while one repeating a 5xx is not, and the two
       * are indistinguishable from the settled and retired counts alone.
       */
      summary.absent++;

      /**
       * **`'drop'` means now, and that is what the verdict is for.** The core's
       * own rule asks again because a `404` a moment before publication is
       * truthful and wrong; an adapter that answers `'drop'` is saying it knows
       * better for its venue — bitget's bucket spells absence as a `403` and has
       * no other meaning for it — and asking twice more only spends requests
       * confirming what one already said.
       */
      if (verdict === 'drop' || row.tries + 1 >= confirmations(row)) spent.push(row);
    };

    await pool(batch, pacing.concurrency, async (row) => {
      // A pass that has given up drains its lanes rather than serving out a
      // pause one row at a time.
      if (summary.abandoned) return;

      try {
        const seen = await fetchHead(adapter, url(adapter, row));

        summary.requests++;

        if (seen.status === 200) {
          const found  = settlement(row, seen.headers);
          const ruling = adapter.ruleOnSuccess?.(row, found.size) ?? null;

          /**
           * **Implied, so assumed.** Nothing listed these: a part arriving is
           * what suggests the next one, and the chain ends at the first miss.
           * Absence is the ordinary way to learn where a split file stops.
           */
          if (ruling?.next)
            for (const path of [ruling.next].flat())
              implied.push({ venueId: row.venueId, path, date: row.date, tries: 0,
                seriesId: row.seriesId, existence: 'assumed' });

          /**
           * **A replaced key is discarded, not settled.** The venue published it
           * and it is still not a file this catalog holds — a manifest is the
           * case — so it leaves `wip` with nothing written, and what it named
           * takes its place.
           */
          if (ruling?.action === 'replace') spent.push(row);
          else settled.push(found);

          return;
        }

        const verdict = adapter.ruleOnFailure?.(seen.status, seen.headers, row.tries + 1) ?? null;

        /**
         * **Absence, however the venue spells it.**
         *
         * Most buckets admit a key is missing with a `404`. Bitget's does not:
         * it grants `GetObject` and not `ListBucket`, so every key it does not
         * have comes back `403 AccessDenied` — the same status as being turned
         * away, separable only by the headers, which is exactly what its
         * `ruleOnFailure` reads.
         *
         * **So the ruling decides the count, not the status.** Counting a ruled
         * absence as a refusal is what stood the venue down after fifty
         * perfectly ordinary gaps and logged it as the venue refusing us — on a
         * probe whose whole job is asking about keys that may not be there, and
         * which meets runs of them at every series' trailing edge.
         */
        if (absent(adapter, seen.status) || verdict === 'drop') {
          /**
           * **Counted, and eventually acted on.** A file an index named an hour
           * ago may have been withdrawn, or a CDN may be having a bad minute, and
           * those look identical from here — so one miss rules nothing out. What
           * separates them over time is persistence, which is what `tries`
           * records and what lets a key that was never going to exist stop being
           * asked about. The adapter decides whether that applies to it.
           */
          summary.missing++;
          refusals = 0;

          judge(row, seen.status, verdict);

          /**
           * **`debug`, not `warn`.** A probe exists to ask whether a key is
           * there; absence is one of the two ordinary answers, not a fault —
           * see the note above. Warning on it would flag every trailing edge
           * every series has.
           */
          if (summary.missing <= REPORTED)
            logger.debug({ venue: labelOf(adapter), path: row.path, tries: row.tries + 1 },
              'Probed file is missing');

          return;
        }

        summary.refused++;

        judge(row, seen.status, verdict);

        /**
         * Reported in full the first few times, because a 403 has two very
         * different meanings and the headers are what separate them. Without
         * this in the log the only way to tell them apart is to go and ask by
         * hand.
         */
        if (summary.refused <= REPORTED)
          logger.warn({
            venue:    labelOf(adapter),
            status:   seen.status,
            path:     row.path,
            server:   seen.headers.get('server'),
            cache:    seen.headers.get('x-cache'),
            amzError: seen.headers.get('x-amz-error-code'),
          }, 'Venue refused a probe');

        /**
         * **A run of refusals aimed at us ends the pass.** The venue is already
         * paused — `send` latched it, along with the rate it was seeing when it
         * happened — so what is left here is to stop queueing work behind that
         * pause and let the loop above decide when to come back. A refusal aimed
         * at a single key is an answer about that key, and the pass carries on.
         *
         * **A run of them, not one**, because ending on the first costs minutes
         * of surveying every time an edge has a bad second. The limiter applies
         * the same rule to the host at the same time, so a venue that really is
         * turning us away is both stood down and out of this pass; one that
         * hiccuped is neither.
         */
        if (blocked(adapter, seen.status, seen.headers)
          && ++refusals >= REFUSALS_BEFORE_BLOCK) summary.abandoned = true;
        else if (summary.settled === 0 && summary.refused >= pacing.giveUpAfter)
          summary.abandoned = true;
      } catch (err) {
        // Retries are spent. The row stays unsettled, so the next pass has it.
        summary.failed++;

        logger.error({ ...fault(err), venue: labelOf(adapter), path: row.path }, 'Probe failed');
      }
    });

    // Before the settlement that implied them, so nothing can arrive without
    // its successor being on the list.
    if (implied.length > 0) summary.implied += parkKeys(db, implied);

    summary.settled += settleFiles(db, settled);

    /**
     * **Counted before dropped, and both before the cursor moves.** A row whose
     * attempt is recorded but which is then left in place is merely asked again;
     * one dropped without its siblings counted would give them a free retry. The
     * order matters only if the process dies between the two, and this way that
     * costs a repeated attempt rather than a lost one.
     */
    missedFiles(db, missed);
    summary.dropped += dropWip(db, spent);

    after = batch[batch.length - 1]!.seq;

    if (summary.abandoned) {
      /**
       * **Says how long, because "later" reads as "next time round".** The pass
       * ends here and the drain picks it straight back up once the venue's own
       * pause lapses — minutes, not the interval between updates — and a line
       * that does not say so describes a service that has given up for the day.
       */
      const paused = pace.blockedFor() || pacing.standDownMs;

      logger.error({ ...summary, venue: labelOf(adapter), ...pace.rates(),
        pausedMinutes: Math.round(paused / 60_000) },
      `Venue is blocking us, or every request this pass has been refused — pausing ${describeWait(paused)}, then carrying on from where this stopped`);

      break;
    }

    /**
     * The cursor moves past rows that did **not** settle as well as rows that
     * did, so one stubborn file cannot hold an archive behind it. They are not
     * lost: the next pass starts from the beginning and offers them again.
     */
    batches++;
  }

  clearInterval(heartbeat);

  /** Only where the pass had a backlog to work on — see `working`. */
  const left = working ? work.remaining?.() ?? null : null;

  logger.info({
    ...summary,
    batches,
    minutes:  Math.round(elapsed(started) / 60),
    ...pace.rates(),
    ...(left === null ? {} : { left }),
  }, summary.abandoned ? 'Probe pass abandoned'
    : summary.stopped ? 'Probe pass stopped — the backlog is kept and the next start carries on from here'
      : 'Probe pass complete');

  return summary;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Between heartbeats. Often enough to see life, rare enough to read a day of them. */
const HEARTBEAT_MS = 30_000;

/**
 * One count against another, as a percentage — a number, with its unit in the
 * field's name, so that nothing numeric is logged as a string.
 *
 * **Significant figures rather than fixed decimals.** What is worth reporting
 * here is a fraction of a percent — one retry in a hundred thousand is a healthy
 * pass, and `toFixed` would round it to zero, throwing away the only thing the
 * field exists to show: the day it stops being small.
 */
const share = (part: number, whole: number): number =>
  (whole === 0 ? 0 : Number((part / whole * 100).toPrecision(2)));

/** Refusals reported in full before the count alone will do. */
const REPORTED = 3;

/**
 * How many times a venue must say a key is not there before that is an answer.
 *
 * **Not a retry budget** — it is the difference between a moment and a fact. A
 * key probed the instant before it was published answers `404` truthfully and is
 * wrong about the archive; reconciliation then retires the whole period on a
 * pass that never asked again. Three attempts across a pass' sweeps closes that
 * window at a cost of two extra requests per key that really is absent.
 *
 * It applies to absence and to nothing else. A status that says nothing about
 * the file has no count to run down: the row simply stays — see `judge`.
 *
 * **How many depends on who said the key exists.** A listing named a confirmed
 * one, so absence contradicts evidence: the venue may be mid-write, or serving a
 * bad minute, and the archive is worth several passes of patience. An assumed
 * one was built from a pattern and a date, and absence is the ordinary answer to
 * a guess — asking thirty times would spend thirty requests proving what the
 * first already said, on keyspaces that are mostly empty.
 */
export const CONFIRMATIONS = { confirmed: 30, assumed: 2 } as const;

/**
 * The attempts this row's absence is worth, from the row rather than the pass —
 * an update draining a walk's backlog must not judge walked keys as guesses.
 */
const confirmations = (row: Unsettled): number =>
  row.existence === 'assumed' ? CONFIRMATIONS.assumed : CONFIRMATIONS.confirmed;

/**
 * Whether this status is the venue saying the key is not there.
 *
 * `404` everywhere, and whatever else a venue names — a bucket that grants
 * `GetObject` without `ListBucket` answers `403` rather than admit what it does
 * not hold. A venue whose status is ambiguous does not list it here and rules on
 * the headers instead; see `notFoundCodes`.
 */
const absent = (adapter: Adapter, status: number): boolean =>
  (adapter.notFoundCodes ?? NOT_FOUND).includes(status);

const NOT_FOUND: readonly number[] = [404];

/** A URL is rebuilt from what the catalog stores, exactly as a consumer would. */
const url = (adapter: Adapter, row: Unsettled): string =>
  `${adapter.base}/${adapter.root}${row.path}`;

/**
 * What a HEAD says about a file.
 *
 * `etag` loses its quotes, and a `-gzip` suffix a CDN adds when it re-encodes on
 * the way out — but never a `-<n>` suffix, which is S3 saying the object was
 * uploaded in that many parts and is part of the real checksum.
 */
const settlement = (row: Unsettled, headers: Headers): Settlement => {
  // A header that is not there is unknown, not zero — and `Number(null)` is 0,
  // which would quietly record every unanswered probe as an empty file.
  const length   = headers.get('content-length');
  const size     = length === null ? Number.NaN : Number(length);
  const modified = Date.parse(headers.get('last-modified') ?? '');

  return {
    venueId:  row.venueId,
    path:     row.path,
    size:     Number.isFinite(size) ? size : null,
    etag:     etagOf(headers.get('etag')),
    modified: Number.isNaN(modified) ? null : new Date(modified).toISOString(),
    seenAt:   new Date().toISOString(),
  };
};

const elapsed = (since: number): number => Math.round((Date.now() - since) / 1000);

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_settlement = settlement;
export const _test_url        = url;
