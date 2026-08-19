import { guardBody, logger } from '@devvir/service-kit';
import { pass } from '@devvir/netgate';
import { labelOf, paceFor } from './pace';
import type { Adapter, Probed } from './types';

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
 * An ETag reduced to what actually identifies the object.
 *
 * **Lower-cased, because the case belongs to the server rather than to the
 * file.** OKX serves the same order-book file from two clouds under two
 * prefixes — byte-identical, same length, and the same md5 in opposite cases,
 * uppercase from Alibaba OSS and lowercase from S3. A comparison that keeps the
 * case reads that as a new version: it appends a revision and clears
 * `downloaded_at`, marking a file already on disk as owed again. Nothing about
 * a hex digest is case-bearing, so normalising cannot lose a distinction.
 *
 * Quotes go because every venue sends them and none means them, and Apache's
 * `-gzip` suffix goes because it describes the transfer rather than the entity.
 */
export const etagOf = (raw: string | null | undefined): string | null =>
  raw?.replace(/^&quot;|&quot;$/g, '')
    .replace(/^"|"$/g, '')
    .replace(/-gzip$/, '')
    .toLowerCase() ?? null;

/**
 * Fetch a listing, retrying only what is worth retrying.
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
 * **A request that hangs is a failure, not a wait.** A listing takes about a
 * second, so a venue that has not replied by `ANSWER_MS`, or has stopped
 * replying for `STALL_MS`, is not going to — and without either bound it would
 * park a partition for as long as the socket stays open, which no retry policy
 * can rescue because nothing ever throws. Both are retried like any transport
 * error, and a partition that exhausts its attempts keeps its cursor and its
 * open run, so it is picked up again on the next turn of the venue's loop.
 * Nothing is ever skipped.
 */
export const fetchText = async (adapter: Adapter, url: string): Promise<string> => {
  let last: unknown;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    /** Here rather than at each `continue`, so every way round the loop counts. */
    if (attempt > 1) paceFor(adapter, url).retry();

    try {
      const res = await send(adapter, url, 'GET');

      if (res.ok) return await res.text();

      // Nothing below reads a refusal's body, and the gate is not freed until
      // something finishes with it — see `send`.
      await discard(res);

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
  let last: unknown;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    /** Here rather than at each `continue`, so every way round the loop counts. */
    if (attempt > 1) paceFor(adapter, url).retry();

    try {
      const res = await send(adapter, url, 'HEAD');

      // A `HEAD` has no body to read, and a venue answering with one anyway would
      // otherwise hold the gate for a transfer nobody is making.
      await discard(res);

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

/** A listing answers in about a second; anything not replying by now is wedged. */
const ANSWER_MS = 15_000;

/**
 * How long a reply already in flight may go quiet.
 *
 * Separate from `ANSWER_MS` because it measures a different thing: not how long
 * the whole transfer takes, which is a fact about its size, but how long it goes
 * without progressing, which is the only evidence that it never will.
 *
 * **Deliberately close to the floor.** A body under load arrives a chunk per turn
 * of the event loop, so this has to clear the loop's own lag or it fires on a
 * healthy transfer — and a false stall costs a whole re-request, which against a
 * megabyte of listing is how a timeout turns into a rate limit. The lag it has
 * to clear is a second or so, and the worst gap ever measured here was three, so
 * ten is several times the headroom needed and still fails loudly enough to be
 * the first sign that this machine is oversubscribed.
 */
const STALL_MS = 10_000;

/** Finish with a body nobody is going to read, so its gate is freed. */
const discard = async (res: Response): Promise<void> => {
  if (res.body) await res.body.cancel().catch(() => {});
};

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
const send = async (adapter: Adapter, url: string, method: 'GET' | 'HEAD'): Promise<Response> => {
  const pace = paceFor(adapter, url);

  /**
   * **Before the venue's own pacing, because it is a different question.** The
   * limiter asks how fast this host may be asked; this asks whether the network
   * is worth asking anything at all. Waiting here costs a request nothing but
   * time — no attempt is spent and no retry consumed — so an outage is a pause
   * rather than every worker discovering it separately.
   */
  await pass();

  await pace.slot();

  /**
   * **Held until the transfer ends, not until the reply starts.**
   *
   * `fetch` resolves at the headers, and freeing the gate there counts a request
   * as finished while its body is still on the wire — which for a listing is
   * nearly all of it. The figure then means "requests waiting for a reply"
   * while claiming to mean "requests in flight", and the two diverge by however
   * many megabytes are being read: a hundred permitted requests can be a
   * thousand open sockets.
   *
   * So the slot is surrendered by whatever ends the body — read to the end,
   * failed, or cancelled unread — which is what `onSettled` reports. A caller
   * that walks away from a body it does not want must cancel it, or the venue
   * is left holding a slot for a transfer nobody is making.
   */
  let holding = true;

  const release = (): void => {
    if (! holding) return;

    holding = false;

    pace.done();
  };

  /**
   * **The deadline is on the answer, and silence is on the body.**
   *
   * `fetch` resolves at the headers, so a deadline around it asks the only
   * question a deadline can answer: did the venue reply. Left running over the
   * body it asks something else entirely — did the reply finish in time — and
   * that is a question about size, which is never a fault. A listing page runs
   * to megabytes and is entitled to take as long as it takes.
   *
   * `guardBody` holds the body to silence instead, restarting its clock on every
   * chunk. A page still arriving is never cut off; one that stopped fails within
   * `STALL_MS`, on the body itself rather than through the abort — an aborted
   * fetch does not reliably settle, and a listing nobody is ever answered about
   * parks a partition for the life of the process.
   */
  const control = new AbortController();
  const answer  = setTimeout(() => control.abort(), ANSWER_MS);

  let res: Response;

  try {
    res = await fetch(url, { method, signal: control.signal });
  } catch (err) {
    release();

    // Never reached the venue. Counted, because retrying an unreachable host is
    // what turns an outage into an outage plus a leak — see `Pace.faulted`.
    pace.faulted(url, err);

    throw err;
  } finally {
    clearTimeout(answer);
  }

  if (blocked(adapter, res.status, res.headers)) pace.block(res.status, url, res.headers);
  else pace.eased();

  return guardBody(res, {
    stallMs:   STALL_MS,
    onStall:   () => control.abort(),
    onSettled: release,
  });
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
