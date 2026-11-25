import { logger } from '@devvir/service-kit';
import { pass } from '@devvir/netgate';
import { labelOf, paceFor } from './pace';
import { countAsked, countSent } from './counts';
import { declined, REDIRECT_REFUSED } from './deliver';
import { faultLine } from './faults';
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
 * S3 answers for a single object and says so, with an `x-amz-error-code`. A CDN
 * turning us away serves its own error page without one — bybit's, for one,
 * down to `x-cache: Error from cloudfront`. So anything refusing without naming
 * a key is treated as the second kind, because that is the direction where
 * being wrong is cheap: a stood-down venue costs minutes, a banned address costs
 * the venue.
 *
 * **Except where the venue has told us otherwise.** That reading assumes a
 * bucket willing to admit an object is missing, and bitget's is not: its S3
 * grants `GetObject` and not `ListBucket`, so *every* key it does not have comes
 * back `403 AccessDenied` — indistinguishable, by status alone, from being
 * turned away. Reading those as a block would stand the venue down on its first
 * missing file and never probe it again. So an adapter that can tell the two
 * apart says so in `refusesUs` — bitget's reads the `server` header — and the
 * guess below is what applies where none does.
 */
export const blocked = (adapter: Adapter, status: number, headers: Headers): boolean =>
  adapter.refusesUs?.(status, headers) ?? standard(status, headers);

const standard = (status: number, headers: Headers): boolean =>
  (status === 403 || status === 429) && headers.get('x-amz-error-code') === null;

/**
 * A venue answered a listing with a success and a body that is not one — see
 * `Malformed`.
 *
 * **Not a `Refused`, because it is not an answer.** An empty listing would say
 * nothing is there; this says nothing at all, so it is retried like a 5xx and,
 * past the attempts, fails the page with its cursor kept.
 */
export class MalformedListing extends Error {
  constructor(
    readonly url:         string,
    readonly contentType: string | null,
    readonly snippet:     string,
  ) {
    super(`Not a listing: ${url} (${contentType ?? 'no content-type'}) ${snippet}`);

    this.name = 'MalformedListing';
  }
}

/**
 * A venue asked for a longer wait than its pacing ever stands down for — see
 * `retryAfterMs`.
 *
 * **A `Refused`, because it settles the request.** The venue's gate is already
 * latched for `ceilingMs` by the time this is thrown, so every request to the
 * host waits that out, and asking again here would only queue behind it.
 */
export class StoodDown extends Refused {
  constructor(
    status:           number,
    headers:          Headers,
    url:              string,
    readonly askedMs: number,
  ) {
    super(status, headers, url);

    this.name    = 'StoodDown';
    this.message = `Stood down: ${url} asked for ${Math.round(askedMs / 1000)}s`;
  }
}

/**
 * A wait ended early because its `StopSignal` was raised.
 *
 * **Not a failure.** The request was never answered, so nothing is known about
 * what it asked for: the page or HEAD it interrupted is still owed.
 */
export class Stopped extends Error {
  constructor(readonly url: string) {
    super(`Stopped while waiting: ${url}`);

    this.name = 'Stopped';
  }
}

/**
 * Whether the caller wants its request to stop waiting. Read during every wait
 * in this file, so a stop does not have to outlast a venue's `Retry-After`.
 */
export type StopSignal = () => boolean;

/**
 * Fetch a listing page, read, retrying only what is worth retrying.
 *
 * Transport errors, 5xx/429 and a success whose body is not a listing are
 * retried; a 403 or 404 is an answer, and repeating it just delays the
 * inevitable. The jitter is full rather than partial so that several scopes
 * backing off at once do not synchronise into a thundering herd against the
 * same venue.
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
 *
 * **What the transfer refused is not retried here** — a redirect off the host
 * or a body over its format's ceiling (see `deliver`). The same request gets
 * the same reply, so it fails at once, as a transport error does once its
 * attempts are spent.
 *
 * **Every wait ends on `stop`**, with a `Stopped`: the backoff between attempts
 * and a venue's `Retry-After` alike.
 */
export const fetchPage = async <F extends PageFormat>(
  adapter: Adapter,
  url:     string,
  format:  F,
  prefix = '',
  stop:    StopSignal = never,
): Promise<Pages[F]> => {
  /** One request needed, whatever the attempts below cost to get an answer. */
  countAsked(adapter);

  let last: unknown;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    /** Here rather than at each `continue`, so every way round the loop counts. */
    if (attempt > 1) paceFor(adapter, url).retry();

    try {
      const res = await send(adapter, url, { format, prefix });

      if (res.ok && res.page !== null && 'malformed' in res.page)
        throw new MalformedListing(url, res.headers.get('content-type'), res.page.malformed);

      if (res.ok) return res.page as Pages[F];

      if (answered(adapter, res.status, res.headers)) throw new Refused(res.status, res.headers, url);

      last = new Refused(res.status, res.headers, url);

      // A venue asking for a slower pace is the one signal worth obeying
      // exactly, rather than guessing with the usual backoff.
      const after = retryAfterMs(res.headers.get('retry-after'));

      if (after !== null) {
        await obey(adapter, url, after, res.status, res.headers, stop);

        continue;
      }
    } catch (err) {
      // A refusal is an answer; only the retryable statuses come back here.
      if (err instanceof Refused && answered(adapter, err.status, err.headers)) throw err;

      if (err instanceof StoodDown || err instanceof Stopped || declined(err)) throw err;

      last = err;
    }

    if (attempt < ATTEMPTS) await waitFor(delayFor(attempt), url, stop);
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
 *
 * Waits end on `stop` as they do in `fetchPage`.
 */
export const fetchHead = async (adapter: Adapter, url: string, stop: StopSignal = never): Promise<Probed> => {
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
        await obey(adapter, url, after, res.status, res.headers, stop);

        continue;
      }
    } catch (err) {
      if (err instanceof StoodDown || err instanceof Stopped) throw err;

      last = err;
    }

    if (attempt < ATTEMPTS) await waitFor(delayFor(attempt), url, stop);
  }

  throw last instanceof Error ? last : new Error(`Probe failed: ${url}`);
};

// ── Internals ─────────────────────────────────────────────────────────────────

const ATTEMPTS = 5;
const BASE_MS  = 500;
const MAX_MS   = 30_000;

/** The stop signal of a caller that has none. */
const never: StopSignal = () => false;

/**
 * Whether a status settles the question, leaving nothing for another attempt.
 *
 * A 5xx or a 429 may go differently next time. A 403 or 404 will not — and a
 * block least of all: `send` has already counted it towards the venue's
 * stand-down, so a retry would spend a request confirming what this one
 * established, against the one venue where an extra request is the thing being
 * avoided. A `Refused` this does not call an answer is a retryable status that
 * ran out of attempts.
 */
export const answered = (adapter: Adapter, status: number, headers: Headers): boolean =>
  blocked(adapter, status, headers) || (status < 500 && status !== 429);

/**
 * Every request this service makes to a venue's archive host.
 *
 * Not a venue's own API: its instrument listings and searches are asked through
 * `fetchJson` in `metadata.ts`, or by the adapter itself, and do not pass here.
 *
 * **The gate is here because this is the single place the archive's traffic
 * passes.** A limiter anywhere else limits one caller: the walk, the archive
 * mapping and the probe are three callers of one host, and a venue counts the
 * host. Retries pass through too, which is what stops five attempts from going
 * out as one request's worth of budget at exactly the moment a venue is already
 * unhappy.
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

    // The error names where the redirect pointed, which is the part worth reading.
    if (declined(err) === REDIRECT_REFUSED)
      logger.warn({ venue: labelOf(adapter), url, err: faultLine(err) }, 'Redirect refused');

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
 * Do what a venue's `Retry-After` asked, within what its pacing allows.
 *
 * **Up to `ceilingMs`, waited out here**, by the request that was told — see
 * `waitOut`. **Beyond it, the venue stops instead**: its gate latches for
 * `ceilingMs`, so nothing at all goes to the host for the longest stand-down it
 * is ever given, and the request fails with a `StoodDown` rather than holding
 * its lane for however long was asked.
 */
const obey = async (
  adapter: Adapter,
  url:     string,
  ms:      number,
  status:  number,
  headers: Headers,
  stop:    StopSignal,
): Promise<void> => {
  const pace = paceFor(adapter, url);

  if (ms > pace.pacing.ceilingMs) {
    pace.standDown(ms, status, url, headers);

    throw new StoodDown(status, headers, url, ms);
  }

  await waitOut(adapter, url, ms, stop);
};

/**
 * Wait as long as a venue asked, saying so for as long as it takes.
 *
 * **The wait is not shortened.** Within its ceiling a venue is the authority on
 * its own pace, and trimming what it asked for is how a 429 becomes a ban — a
 * run keeps its cursor and a survey is measured in days, so nothing is lost by
 * obeying.
 *
 * **But it is never silent.** One line at the start and then nothing is
 * indistinguishable from a wedged service, which is exactly what an hour of
 * quiet looked like: partitions open, nothing logged, no way to tell waiting
 * from stuck. So it reports while it waits, and says when it will be back.
 *
 * **And it ends on `stop`**, within `STOP_POLL_MS`, with a `Stopped`.
 */
const waitOut = async (adapter: Adapter, url: string, ms: number, stop: StopSignal): Promise<void> => {
  const until = Date.now() + ms;

  logger.warn({ venue: labelOf(adapter), url, ms, until: new Date(until).toISOString() },
    'Venue asked us to slow down');

  for (let said = Date.now(); until > Date.now(); ) {
    await waitFor(Math.min(until - Date.now(), SAYING_MS - (Date.now() - said)), url, stop);

    const remaining = until - Date.now();

    if (remaining > 0 && Date.now() - said >= SAYING_MS) {
      said = Date.now();

      logger.warn({ venue: labelOf(adapter), seconds: Math.round(remaining / 1000) },
        'Still waiting out the pause a venue asked for');
    }
  }
};

/** How long the wait above may go unmentioned. */
const SAYING_MS = 60_000;

/** Sleep for `ms`, looking at `stop` every `STOP_POLL_MS`; a stop ends it with a `Stopped`. */
const waitFor = async (ms: number, url: string, stop: StopSignal): Promise<void> => {
  const until = Date.now() + ms;

  for (;;) {
    if (stop()) throw new Stopped(url);

    const left = until - Date.now();

    if (left <= 0) return;

    await sleep(Math.min(left, STOP_POLL_MS));
  }
};

/** How often a wait looks at its stop signal. */
const STOP_POLL_MS = 250;

/** Exponential with full jitter, so retries across scopes do not synchronise. */
const delayFor = (attempt: number): number =>
  Math.floor(Math.random() * Math.min(BASE_MS * 2 ** (attempt - 1), MAX_MS));

/**
 * How long a venue asked us to wait, in either form the header takes — a count of
 * seconds or an HTTP date.
 *
 * **Read as sent.** What a wait beyond the venue's `ceilingMs` turns into is
 * `obey`'s to decide.
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

export const _test_retryAfterMs = retryAfterMs;
