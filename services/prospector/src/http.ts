import { logger } from '@devvir/service-kit';
import { pass } from '@devvir/netgate';
import { labelOf, paceFor } from './pace';
import { countAsked, countSent } from './counts';
import { carry } from './transport';
import { timed } from './timings';
import type { Adapter, Carried, PageFormat, Pages, PageRead, Probed, Reply } from './types';

/**
 * A venue declined to answer, with what it said while declining.
 *
 * Carries the headers because a 403 has two very different meanings and only the
 * headers separate them — see `blocked`. They are copied into a plain object as
 * well: a `Headers` has no enumerable properties of its own, so a logger writes
 * it as `{}` and the one detail worth reading is the one that never arrives.
 */
export class Refused extends Error {
  readonly detail: Record<string, string | null>;

  constructor(
    readonly status:  number,
    readonly headers: Headers,
    readonly url:     string,
  ) {
    super(`Refused ${status}: ${url}`);

    this.name   = 'Refused';
    this.detail = {
      server:   headers.get('server'),
      cache:    headers.get('x-cache'),
      amzError: headers.get('x-amz-error-code'),
    };
  }
}

/**
 * Whether a refusal is aimed at **us** rather than at one key.
 *
 * S3 answers for a single object and says so — an `x-amz-error-code`, and
 * `AmazonS3` as the server. A CDN turning us away serves its own error page with
 * none of that, which is what bybit's block looked like, down to
 * `x-cache: Error from cloudfront`. So anything refusing without naming a key is
 * treated as the second kind, because that is the direction where being wrong is
 * cheap: a stood-down venue costs minutes, a banned address costs the venue.
 *
 * **Except where the venue has told us otherwise.** That reading assumes a
 * bucket willing to admit an object is missing, and bitget's is not: its S3
 * grants `GetObject` and not `ListBucket`, so *every* key it does not have comes
 * back `403 AccessDenied` — indistinguishable, by status alone, from being
 * turned away. Reading those as a block would stand the venue down on its first
 * missing file and never probe it again. So an adapter that can tell the two
 * apart says so in `refusesUs`, and the guess below is what applies where none
 * does.
 */
export const blocked = (adapter: Adapter, status: number, headers: Headers): boolean =>
  adapter.refusesUs?.(status, headers) ?? standard(status, headers);

const standard = (status: number, headers: Headers): boolean =>
  (status === 403 || status === 429) && headers.get('x-amz-error-code') === null;

/**
 * Fetch a listing page, read, retrying only what is worth retrying.
 *
 * Transport errors and 5xx/429 are retried; a 403 or 404 is an answer, and
 * repeating it just delays the inevitable. The jitter is full rather than
 * partial so that several scopes backing off at once do not synchronise into
 * a thundering herd against the same venue.
 *
 * S3 reaps idle keep-alive connections and undici will reuse one it has already
 * closed, which surfaces as `fetch failed: other side closed` every few minutes
 * on whichever scope lists slowly enough for its sockets to go idle. That is
 * ordinary internet, not a fault worth losing a scope over.
 *
 * **A request that hangs is a failure, not a wait.** A venue that has not
 * replied in time, or has stopped replying part-way, is not going to — see
 * `deliver` for both bounds — and without them it would park a partition for as
 * long as the socket stays open. Both are retried like any transport error, and
 * a partition that exhausts its attempts keeps its cursor and its open run, so
 * it is picked up again on the next turn of the venue's loop. Nothing is ever
 * skipped.
 */
export const fetchPage = async <F extends PageFormat>(
  adapter: Adapter,
  url:     string,
  format:  F,
  prefix = '',
): Promise<Pages[F]> => {
  /** One request needed, whatever the attempts below cost to get an answer. */
  countAsked(adapter);

  let last: unknown;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    /** Here rather than at each `continue`, so every way round the loop counts. */
    if (attempt > 1) paceFor(adapter, url).retry();

    try {
      const res = await send(adapter, url, { format, prefix });

      if (res.ok) return res.page as Pages[F];

      if (answered(adapter, res.status, res.headers)) throw new Refused(res.status, res.headers, url);

      last = new Refused(res.status, res.headers, url);

      // A venue asking for a slower pace is the one signal worth obeying
      // exactly, rather than guessing with the usual backoff.
      const after = retryAfterMs(res.headers.get('retry-after'));

      if (after !== null) {
        await waitOut(adapter, url, after);

        continue;
      }
    } catch (err) {
      // A refusal is an answer; only the retryable statuses come back here.
      if (err instanceof Refused && answered(adapter, err.status, err.headers)) throw err;

      last = err;
    }

    if (attempt < ATTEMPTS) await sleep(delayFor(attempt));
  }

  throw last instanceof Error ? last : new Error(`Listing failed: ${url}`);
};

/**
 * Ask what a venue holds at a URL without fetching it, retrying only what is
 * worth retrying.
 *
 * **A 404 is an answer here, not a failure.** Where a listing that 404s means a
 * prefix is gone, a probe's whole job is asking a question whose answer may be
 * "no" — so a status the caller has to weigh is returned rather than thrown, and
 * only the retryable cases (5xx, 429, transport, timeout) are retried to
 * exhaustion before giving up.
 *
 * Rate-limit headers are handed back untouched. No venue probed so far sends
 * any, which is exactly why the rate this service measures for itself is the
 * only figure there is — see `pace.ts`.
 */
export const fetchHead = async (adapter: Adapter, url: string): Promise<Probed> => {
  /** One request needed, whatever the attempts below cost to get an answer. */
  countAsked(adapter);

  let last: unknown;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    /** Here rather than at each `continue`, so every way round the loop counts. */
    if (attempt > 1) paceFor(adapter, url).retry();

    try {
      const res = await send(adapter, url, null);

      if (answered(adapter, res.status, res.headers)) return { status: res.status, headers: res.headers };

      last = new Error(`Probe failed ${res.status}: ${url}`);

      const after = retryAfterMs(res.headers.get('retry-after'));

      if (after !== null) {
        await waitOut(adapter, url, after);

        continue;
      }
    } catch (err) {
      last = err;
    }

    if (attempt < ATTEMPTS) await sleep(delayFor(attempt));
  }

  throw last instanceof Error ? last : new Error(`Probe failed: ${url}`);
};

// ── Internals ─────────────────────────────────────────────────────────────────

const ATTEMPTS = 5;
const BASE_MS  = 500;
const MAX_MS   = 30_000;

/**
 * Whether a status settles the question, leaving nothing for another attempt.
 *
 * A 5xx or a 429 may go differently next time. A 403 or 404 will not — and a
 * block least of all: `send` has already paused the venue, so a retry would wait
 * out that pause and then spend a request confirming what this one established,
 * against the one venue where an extra request is the thing being avoided.
 */
const answered = (adapter: Adapter, status: number, headers: Headers): boolean =>
  blocked(adapter, status, headers) || (status < 500 && status !== 429);

/**
 * Every request this service makes to a venue, and the only one.
 *
 * **The gate is here because this is the single place all of it passes.** A
 * limiter anywhere else limits one caller: the walk, the archive mapping and the
 * probe are three callers of one host, and a venue counts the host. Retries pass
 * through too, which is what stops five attempts from going out as one request's
 * worth of budget at exactly the moment a venue is already unhappy.
 *
 * A block is latched here rather than by whoever happens to read the status,
 * so every other caller — including ones already waiting for a slot — stops
 * without having to be told.
 */
const send = async (adapter: Adapter, url: string, read: PageRead | null): Promise<Reply> => {
  const pace = paceFor(adapter, url);

  /**
   * **Before the venue's own pacing, because it is a different question.** The
   * limiter asks how fast this host may be asked; this asks whether the network
   * is worth asking anything at all. Waiting here costs a request nothing but
   * time — no attempt is spent and no retry consumed — so an outage is a pause
   * rather than every worker discovering it separately.
   */
  const asked = performance.now();

  await pass();

  await pace.slot();

  const slotted = performance.now();

  timed(labelOf(adapter), 'slot', slotted - asked);

  /** Counted once it has a slot, so every attempt is one request sent. */
  countSent(adapter);

  /**
   * **Held until the transfer ends, not until the reply starts.** `carry`
   * settles once the body is read or dropped, so a slot counts a request for as
   * long as the venue is sending it — a hundred permitted requests stay a
   * hundred open transfers, however many megabytes each one is.
   */
  let carried: Carried;
  let back = 0;

  try {
    carried = await carry(url, read);
    back    = performance.now();
  } catch (err) {
    // Never reached the venue, or never finished. Counted, because retrying an
    // unreachable host is what turns an outage into an outage plus a leak — see
    // `Pace.faulted`.
    pace.faulted(url, err);

    throw err;
  } finally {
    pace.done();
  }

  /**
   * **Where the slot's time went.** What the worker measured is the request
   * itself; whatever else passed between handing it over and hearing back is
   * the trip to the worker and its queue there.
   */
  if (carried.timing) {
    const venue = labelOf(adapter);
    const { firstByte, body, parse } = carried.timing;

    timed(venue, 'firstByte', firstByte);
    timed(venue, 'body',      body);
    timed(venue, 'parse',     parse);
    timed(venue, 'handoff',   Math.max(0, back - slotted - firstByte - body - parse));
  }

  const headers = new Headers(carried.headers);

  if (blocked(adapter, carried.status, headers)) pace.block(carried.status, url, headers);
  else pace.eased();

  return {
    status: carried.status,
    ok:     carried.status >= 200 && carried.status < 300,
    headers,
    page:   carried.page,
  };
};

/**
 * Wait as long as a venue asked, saying so for as long as it takes.
 *
 * **The wait is not shortened.** A venue is the authority on its own pace, and
 * trimming what it asked for is how a 429 becomes a ban — a run keeps its cursor
 * and a survey is measured in days, so nothing is lost by obeying.
 *
 * **But it is never silent.** One line at the start and then nothing is
 * indistinguishable from a wedged service, which is exactly what an hour of
 * quiet looked like: partitions open, nothing logged, no way to tell waiting
 * from stuck. So it reports while it waits, and says when it will be back.
 */
const waitOut = async (adapter: Adapter, url: string, ms: number): Promise<void> => {
  const until = Date.now() + ms;

  logger.warn({ venue: labelOf(adapter), url, ms, until: new Date(until).toISOString() },
    'Venue asked us to slow down');

  for (let left = ms; left > 0; left = until - Date.now()) {
    await sleep(Math.min(left, SAYING_MS));

    const remaining = until - Date.now();

    if (remaining > 0)
      logger.warn({ venue: labelOf(adapter), seconds: Math.round(remaining / 1000) },
        'Still waiting out the pause a venue asked for');
  }
};

/** How long the wait above may go unmentioned. */
const SAYING_MS = 60_000;

/** Exponential with full jitter, so retries across scopes do not synchronise. */
const delayFor = (attempt: number): number =>
  Math.floor(Math.random() * Math.min(BASE_MS * 2 ** (attempt - 1), MAX_MS));

/**
 * How long a venue asked us to wait, in either form the header takes — a count of
 * seconds or an HTTP date.
 *
 * **Honoured as sent, never capped.** A venue is the authority on its own pace,
 * and shortening the wait it asked for is how a 429 becomes a ban. Nothing is
 * lost by waiting: the run keeps its cursor, and a survey is measured in days
 * against a refresh interval of weeks.
 */
const retryAfterMs = (header: string | null): number | null => {
  if (! header) return null;

  const seconds = Number(header);

  if (Number.isFinite(seconds)) return Math.max(seconds * 1000, 0);

  const at = Date.parse(header);

  return Number.isNaN(at) ? null : Math.max(at - Date.now(), 0);
};

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_delayFor     = delayFor;
export const _test_retryAfterMs = retryAfterMs;
