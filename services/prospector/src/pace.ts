import { logger } from '@devvir/service-kit';
import { faultLine } from './faults';
import type { Adapter, Pacing, Rates } from './types';

/**
 * How a server is named in a log line and keyed in the registry below.
 *
 * A venue served by one host is just its name; a venue served by several needs
 * the pair, or two servers share a limiter and a log line cannot say which of
 * them refused.
 */
export const labelOf = (adapter: Adapter): string =>
  adapter.host ? `${adapter.name}/${adapter.host}` : adapter.name;

/**
 * Consecutive refusals, with no answer between them, before a venue is stood
 * down.
 *
 * **Small, because it is not a tolerance — it is the difference between one
 * answer and a pattern.** Every lane in flight fails at roughly the same instant
 * when a venue really does turn us away, so a genuine block reaches this within
 * a fraction of a second and loses nothing; a single bad reply from a CDN edge
 * never gets there, because the next answer clears the count.
 */
export const REFUSALS_BEFORE_BLOCK = 5;

/**
 * What to use when a caller has no opinion.
 *
 * **A venue that needs less says so in its adapter**, where the evidence for the
 * number can be written down beside it — as bybit does, having earned its 30 by
 * turning us away above it. Nothing here is a measurement of any venue in
 * particular, so a venue still on this figure is one nobody has had a reason to
 * measure.
 *
 * The two below are different kinds of limit, and only one of them is a limit at
 * all. `perSecond` is the hard cap and the only line a venue could object to.
 * `concurrency` merely allows that cap to be reached: a request spends most of
 * its life waiting, and how many must be outstanding before the rate arrives
 * depends on latency, on the link, and on whatever else is competing for both —
 * none of which is knowable from here, and none of which stays still.
 */
export const STEADY: Pacing = {
  perSecond:   100,
  concurrency: 100,
  ceilingMs:   30 * 60_000,
  standDownMs: 2 * 60_000,
  giveUpAfter: 50,
  batch:       10000,
};

/**
 * How many requests a venue will have in flight of its own, and therefore how
 * many workers are worth giving it.
 *
 * **The adapter's figure, because it is a fact about the venue.** More workers
 * than this cannot make a venue go faster — they would queue on its own gate —
 * and fewer would leave its cadence unreachable. A venue that has never been
 * measured takes the default, which is the same statement made by nobody in
 * particular.
 */
export const lanesFor = (adapter: Adapter, ceiling = Infinity): number =>
  Math.min(adapter.pacing?.concurrency ?? STEADY.concurrency, ceiling);

/**
 * How long a wait is, in words — never "the usual interval" or "standing
 * down", neither of which says anything a reader could act on without going
 * and finding the number behind it.
 *
 * Rounded to whichever unit the wait is actually worth stating in: hours where
 * there is at least one, minutes below that, and "shortly" below one — a count
 * of zero minutes would be true and useless.
 */
export const describeWait = (ms: number): string => {
  const hours = Math.round(ms / 3_600_000);

  if (hours > 0) return `in about ${hours}h`;

  const minutes = Math.round(ms / 60_000);

  return minutes > 0 ? `in about ${minutes}m` : 'shortly';
};

/**
 * The one budget a **host** gets, for the life of the process.
 *
 * **A venue counts requests from an address, not from a code path.** The walk,
 * the archive mapping and the probe are three callers of one host, so a limiter
 * belonging to any one of them is not a limit — it is a limit on a third of the
 * traffic. All three draw on the same counter, and a stand-down declared by any
 * of them stops all of them.
 *
 * **Keyed by hostname, not by venue.** Our names for venues are not what the
 * other end counts. Binance and gate publish to the same bucket service —
 * `s3-ap-northeast-1.amazonaws.com` — so keying on the venue gave each a full
 * budget against one machine, and the machine saw the sum of two limiters that
 * each believed they were alone. It answered with `Refused` and connect
 * timeouts, on those two venues and no others.
 *
 * The reverse case is served correctly by the same rule: one venue across two
 * hosts gets two budgets, because they are two machines. And a venue that lists
 * from one address while serving files from another — binance lists at the
 * bucket and downloads from CloudFront — is paced separately on each, which is
 * what those two hosts would each want.
 *
 * Lasts the whole process rather than a pass, so a brake that escalated does not
 * reset every fifteen minutes.
 */
export const paceFor = (adapter: Adapter, url: string): Pace => {
  const key  = hostOf(url);
  const held = paces.get(key);

  if (held) return held;

  const made = new Pace(key, { ...STEADY, ...adapter.pacing });

  paces.set(key, made);

  return made;
};

/**
 * The host a URL addresses, or the whole string when it is not one.
 *
 * A limiter keyed on something unparseable would be shared by every malformed
 * URL at once, which is a stranger failure than simply pacing it alone.
 */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * The machine's whole allowance of requests in flight, shared by every host.
 *
 * **A ticket booth, not an allocator.** It does not know who is asking, does not
 * divide anything between venues, and holds no opinion about fairness beyond the
 * order people arrived in. There is a fixed number of tickets; you get one or you
 * wait, and you give it back when the request is answered.
 *
 * That is enough because the two limits answer different questions and compose
 * without either knowing about the other. A venue's `concurrency` is what *that
 * venue* will tolerate, and it still holds — a venue at its own limit never asks
 * for a ticket. This is what *this machine* will hold open at once, across every
 * venue at once, and it is the figure that was missing: the seven hosts surveyed
 * today permit 360 requests in flight between them, every one of those figures
 * defensible on its own, and connect timeouts are what the sum bought.
 *
 * **A ticket is transferred rather than released.** Handing it straight to the
 * next waiter keeps the count exact: were it given back to the pool first, a
 * caller arriving in the gap could take it while the woken waiter also believed
 * it had one, and the ceiling would drift upward by one every time that raced.
 */
class Tickets {
  #limit:   number;
  #taken   = 0;
  #waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** Wait for a ticket. Every call that returns owes exactly one `give`. */
  take(): Promise<void> | void {
    if (this.#taken < this.#limit) {
      this.#taken++;

      return;
    }

    return new Promise<void>(release => this.#waiting.push(release));
  }

  /** Done with it. The next in line gets it before the pool does. */
  give(): void {
    const next = this.#waiting.shift();

    if (next) next();
    else this.#taken--;
  }

  /**
   * Resize the pool.
   *
   * Only ever grows or shrinks the ceiling: tickets already out stay out, so a
   * shrink is reached by attrition rather than by taking anything back, and a
   * growth releases whoever is already queued for the room that just appeared.
   */
  resize(limit: number): void {
    this.#limit = limit;

    while (this.#taken < this.#limit && this.#waiting.length > 0) {
      this.#taken++;
      this.#waiting.shift()!();
    }
  }

  get limit(): number {
    return this.#limit;
  }

  get outstanding(): number {
    return this.#taken;
  }

  get queued(): number {
    return this.#waiting.length;
  }
}

/**
 * How many requests this machine will hold open at once, over every venue.
 *
 * Generous by default, because the bound that matters is the one the deployment
 * sets: a machine nobody has measured should behave as it did before this
 * existed rather than be throttled by a number picked here.
 */
let tickets = new Tickets(1_000);

/** Set the machine-wide ceiling. Called once, from the configuration. */
export const capacity = (limit: number): void => tickets.resize(limit);

/** What the pool is doing, for a log line or a status route. */
export const ticketing = (): { limit: number; outstanding: number; queued: number } =>
  ({ limit: tickets.limit, outstanding: tickets.outstanding, queued: tickets.queued });

/**
 * The rate every request passes through, and the latch behind it.
 *
 * **A venue budgets requests per second, so requests per second is what is
 * counted.** Concurrency sets a rate only by accident — multiply it by whatever
 * latency happens to be that day — which is why a pool width is not a limit and
 * never was.
 *
 * The counter is a sliding second: the times requests went out, with anything
 * older than the window dropped. A request is allowed when fewer than
 * `perSecond` of them fall inside the last second, and otherwise waits exactly
 * as long as it takes the oldest to fall out. Nothing to reset and no bucket to
 * refill — the same list is also what the log reports, so the rate stated when a
 * venue turns us away is the rate that was actually being sent.
 */
export class Pace {
  constructor(
    readonly venue:  string,
    readonly pacing: Pacing,
  ) {}

  /** When requests went out, newest last, trimmed to `HISTORY_MS`. */
  private readonly sent: number[] = [];

  /**
   * Lanes waiting for one of this host's in-flight slots.
   *
   * **`concurrency` is a bound on a host, and was only ever enforced per venue.**
   * Each venue runs its own pool, so two venues sharing an address ran twice the
   * intended number of sockets against it — binance and gate are both
   * `s3-ap-northeast-1.amazonaws.com`, and with Node's default dispatcher
   * opening as many connections per origin as it is asked to, the surplus does
   * not queue: it opens more sockets, until new ones stop being accepted and
   * every request dies on its own timeout having never sent a byte.
   *
   * That reads as a venue problem and is not one. The bound belongs here for the
   * same reason the rate does — one address, one budget, however many venues
   * happen to share it.
   */
  private readonly waiting: (() => void)[] = [];

  private inFlight = 0;
  private peak     = 0;
  private total    = 0;
  private retried  = 0;

  /**
   * **Counts per second and per minute, because timestamps do not scale to an
   * hour.** The list above is exact and has to be — the cadence check asks how
   * many went out in the last second and when the oldest of them left — but an
   * hour of it at this venue's rate is millions of numbers held to answer one
   * log line. A bucket per second for the minute, and a bucket per minute for
   * the hour, is 120 numbers for the same two answers.
   *
   * Rings: each slot is the count for one second (or minute), and advancing
   * past a slot clears it. A gap longer than the ring clears the whole thing,
   * which is what an idle venue should report.
   */
  private readonly perSecond = new Uint32Array(60);
  private readonly perMinute = new Uint32Array(60);

  /** The second and minute each ring is currently writing into. */
  private second = Math.floor(Date.now() / 1_000);
  private minute = Math.floor(Date.now() / 60_000);

  /** When counting began, so a window reports over what has actually elapsed. */
  private readonly countingFrom = Date.now();

  /** While in the future, nothing goes out. */
  private until  = 0;

  /** The pause this venue would take now, doubling while it keeps refusing. */
  private paused = 0;

  /** When it last refused us, so the doubling can be forgotten after a quiet spell. */
  private blockedAt = 0;

  /** Consecutive requests that never reached the venue at all. */
  private faults = 0;

  /** Consecutive refusals with no answer in between — see `block` and `eased`. */
  private refusals = 0;

  /**
   * When the current ramp began — see `allowed`.
   *
   * Set at construction and again whenever a pause lifts, because coming back
   * from a block is exactly when arriving at full concurrency in one instant is
   * least welcome.
   */
  private rampFrom = Date.now();


  /**
   * Wait for this request's turn, then count it as sent.
   *
   * The check and the claim happen in the same tick with no `await` between
   * them, so two lanes cannot both look at a window with one slot left and both
   * take it.
   */
  async slot(): Promise<void> {
    /**
     * **The host's own limit is taken before the machine's, never the other way
     * round.** A lane holding a ticket while it waits for its venue to free a
     * slot is holding the scarcer of the two for the sake of the looser one, and
     * every venue pays for it. Taken in this order — and in this order
     * everywhere — nothing waits on anything that is waiting on it.
     */
    let ticketed = false;

    try {
      for (;;) {
        const now  = Date.now();
        const held = this.until - now;

        if (held > 0) {
          if (ticketed) { tickets.give(); ticketed = false; }

          await sleep(held);

          /**
           * **The ramp starts again on the way out of a pause.** Every lane
           * held here wakes within a moment of the same instant, so without
           * this the venue that just refused us would be met with the full
           * limit at once — the one moment where that is least likely to be
           * forgiven.
           */
          this.rampFrom = Date.now();

          continue;
        }

        // Nothing else may be tried while this host is already carrying its
        // share: a request that cannot be sent should wait here rather than open
        // a socket nobody is going to answer on.
        if (this.inFlight >= this.allowed) {
          if (ticketed) { tickets.give(); ticketed = false; }

          /**
           * **Woken by a departure once the limit is fixed, by the clock while
           * it is not.** `done` releases one waiter per answer, which is the
           * whole story at full concurrency — but during the ramp the limit
           * rises on its own, and a lane parked on the queue would sleep through
           * every rise until something happened to finish. Polling is confined
           * to those first seconds, where it is a handful of wakeups and the
           * point is to be going slowly anyway.
           */
          if (this.ramping()) await sleep(RAMP_POLL_MS);
          else await new Promise<void>(release => this.waiting.push(release));

          continue;
        }

        if (! ticketed) {
          await tickets.take();

          ticketed = true;

          // The wait may have been long, and this host's state is read fresh
          // above rather than trusted from before it.
          continue;
        }

        this.trim(now);

        const within = this.since(now - 1000);

        if (within >= this.pacing.perSecond) {
          /**
           * **The ticket is kept across this wait, deliberately.** It is a
           * second at the outside, and letting it go would put every lane that
           * cleared the rate check back in the queue — to be released together,
           * later, and sent in one burst that is exactly what `perSecond` exists
           * to prevent.
           */
          const oldest = this.sent[this.sent.length - within]!;

          await sleep(Math.max(1, oldest + 1000 - now));

          continue;
        }

        this.sent.push(now);
        this.inFlight++;
        this.total++;
        this.count(now);

        if (within + 1 > this.peak) this.peak = within + 1;

        return;
      }
    } catch (err) {
      if (ticketed) tickets.give();

      throw err;
    }
  }

  /**
   * How many requests may be in flight *right now*, which is the full figure
   * only once the ramp has finished opening.
   *
   * **Concurrency is for keeping the pipe full while answers are outstanding,
   * not for arriving all at once.** Opening every socket in the same
   * millisecond is what a host sees as a burst rather than as throughput: htx
   * took 100 connections from a standing start, answered none of them, and
   * every one died on its own 15-second deadline having never been replied to.
   * A venue that would happily serve 100/s sustained can still refuse to be met
   * with 100 at once.
   *
   * So it opens in tenths: a tenth of the limit in the first second, two tenths
   * in the next, at full in nine — slow enough that a host sees a rise rather
   * than a wall, brief enough that it costs nothing against a run measured in
   * hours.
   */
  private get allowed(): number {
    const steps = Math.floor((Date.now() - this.rampFrom) / RAMP_STEP_MS) + 1;

    if (steps >= RAMP_STEPS) return this.pacing.concurrency;

    /**
     * **Never below a handful, because a handful is not a burst.** A tenth of a
     * limit of two is one, and holding the second connection back for five
     * seconds delays a venue nobody could accuse of being stormed. The floor is
     * what keeps this a rule about arriving all at once rather than a tax on
     * every small limit.
     */
    return Math.min(
      this.pacing.concurrency,
      Math.max(RAMP_FLOOR, Math.ceil(this.pacing.concurrency * steps / RAMP_STEPS)),
    );
  }

  /**
   * Whether the limit is still opening, and so still moving on its own.
   *
   * Read from the figure rather than the clock: a limit at or under the floor is
   * never held back at all, and there is nothing for a waiting lane to wait for.
   */
  private ramping(): boolean {
    return this.allowed < this.pacing.concurrency;
  }

  /** This request is answered, however it turned out. Pairs with `slot`. */
  done(): void {
    this.inFlight--;

    this.waiting.shift()?.();

    tickets.give();
  }

  /**
   * A request that never reached the venue.
   *
   * **Noise, and reported as noise.** A connect that times out says nothing
   * about the venue: a full run of all six archives takes hours and produces a
   * scattering of these throughout, on links and hosts that are working
   * perfectly well. Measured on okx while the service had stood itself down for
   * twenty minutes over exactly this — a hundred concurrent HEADs from a fresh
   * process in the same container, 281 a second, not one failure.
   *
   * **So nothing here pauses anything.** The retry ladder in `http.ts` already
   * covers a bad moment, five attempts with backoff, and a host that is really
   * gone simply fails those cheaply. Standing a venue down for minutes because
   * a socket timed out costs hours of surveying and buys nothing — the venue was
   * never objecting, and there is nobody to appease.
   *
   * What it does do is say so, once per run of them, with the reason unwrapped
   * from `cause` — because "some timeouts in the log" is worth being able to see
   * and count, and a silent one is how a genuine outage looked like a hang.
   */
  faulted(url: string, err: unknown): void {
    this.faults++;

    if (this.faults % this.pacing.giveUpAfter !== 0) return;

    logger.warn({
      venue: this.venue, url, err: faultLine(err), inARow: this.faults, ...this.rates(),
    }, 'Requests are not reaching the venue — retrying, not standing down');
  }

  /**
   * Stop the whole venue.
   *
   * **A block is waited out, not slowed down.** It lapses only while nothing is
   * asking, so every further request is one that may extend it — and the address
   * here is static, which makes a permanent ban the one outcome with no recovery.
   *
   * **One pause per round, not one per refusal.** Every lane in flight fails at
   * roughly the same instant, so counting each of them would escalate to the
   * ceiling in milliseconds, before the venue has had any chance to answer
   * differently, and with one identical warning per lane to read afterwards. A
   * refusal arriving while a pause is already in force is that same round.
   *
   * **And a round is a run of them, not one.** A single refusal is far more
   * often an edge having a bad second than a venue objecting: bitget's CDN was
   * asked 597,000 times in one afternoon, up to 3,500 a second, and refused
   * nothing — so on that venue every stand-down ever taken came from a one-off.
   * Standing a venue down on the first costs a survey minutes for something that
   * would have answered on the retry, so it takes `REFUSALS_BEFORE_BLOCK` of
   * them with no success in between. `eased` clears the count, which is what
   * makes them consecutive rather than merely numerous.
   */
  block(status: number, url: string, headers: Headers): void {
    if (Date.now() < this.until) return;

    this.refusals++;

    if (this.refusals < REFUSALS_BEFORE_BLOCK) {
      logger.warn({
        venue: this.venue, status, url, inARow: this.refusals,
        server: headers.get('server'), cache: headers.get('x-cache'),
      }, 'Venue refused a request — retrying rather than standing down');

      return;
    }

    this.paused = Math.min(
      this.paused === 0 ? this.pacing.standDownMs : this.paused * 2,
      this.pacing.ceilingMs,
    );

    this.blockedAt = Date.now();
    this.until     = this.blockedAt + this.paused;

    /**
     * **What the rate was at the moment of the block, not on average.** A
     * per-pass average includes every second spent paused, so it understates the
     * only number that matters here by however long the pass has been running —
     * and the whole question about this venue is what it will tolerate. These are
     * measured over the last second, five and ten before it refused.
     */
    logger.error({
      venue:    this.venue,
      status,
      url,
      server:   headers.get('server'),
      cache:    headers.get('x-cache'),
      amzError: headers.get('x-amz-error-code'),
      ...this.rates(),
      capPerSecond: this.pacing.perSecond,
      minutes:      Math.round(this.paused / 60_000),
    }, 'Blocked by venue — every request to it is paused');
  }

  /** How long the pause still has to run, so a caller can say why nothing moves. */
  blockedFor(): number {
    return Math.max(0, this.until - Date.now());
  }

  /**
   * What is going out, for a log line.
   *
   * Three windows because one does not separate the cases: a burst that lasted
   * a second and a steady climb over ten look identical at either extreme, and
   * which of the two triggered a block is the question being asked.
   */
  rates(): Rates {
    const now = Date.now();

    this.trim(now);
    this.count(now, 0);

    const running = now - this.countingFrom;

    return {
      lastSecond:    this.since(now - 1_000),
      last5Seconds:  Math.round(this.since(now - 5_000) / 5),
      last10Seconds: Math.round(this.since(now - 10_000) / 10),
      lastMinute:    rate(this.perSecond, Math.min(running, 60_000)),
      lastHour:      rate(this.perMinute, Math.min(running, 3_600_000)),
      peakPerSecond: this.peak,
      inFlight:      this.inFlight,
      sentTotal:     this.total,
      retries:       this.retried,
    };
  }

  /** One more attempt at a request already made — see `Rates.retries`. */
  retry(): void {
    this.retried++;
  }

  /**
   * Forget an escalated stand-down once the venue has been answering for a
   * while.
   *
   * **Measured from the last refusal, not from a run of clean replies.** A count
   * of good answers is a proxy for time that the rate decides the meaning of:
   * two hundred of them is four seconds at 50/s and forty at 5/s. What the
   * doubling is protecting against is repeated blocks in close succession, so
   * the thing to measure is how long it has been since the last one.
   */
  eased(): void {
    // An answer of any kind means the venue is reachable, whatever it said.
    this.faults = 0;

    /**
     * **This is what makes a run of refusals consecutive.** `eased` is called
     * for every reply that is not a refusal, so a venue that refuses one request
     * and answers the next never accumulates towards a stand-down — which is the
     * whole difference between "a bad second" and "we are being turned away".
     */
    this.refusals = 0;

    if (this.paused === 0 || this.blockedFor() > 0) return;

    if (Date.now() - this.blockedAt < EASE_AFTER_MS) return;

    this.paused = 0;
  }

  /** Drop what has aged out. The list is time-ordered, so this is a prefix. */
  private trim(now: number): void {
    const cut = now - HISTORY_MS;

    let stale = 0;

    while (stale < this.sent.length && this.sent[stale]! < cut) stale++;

    if (stale > 0) this.sent.splice(0, stale);
  }

  /**
   * Move both rings up to `now` and add `by` to the current slot.
   *
   * **Advancing is what clears, so a ring never holds a stale count.** Every
   * slot passed over belongs to a second or minute that has ended and is zeroed
   * on the way; a gap longer than the ring clears all of it, which is the right
   * answer for a venue that has sent nothing in a minute. Called with nothing to
   * add when a reader needs the rings current.
   */
  private count(now: number, by = 1): void {
    const second = Math.floor(now / 1_000);
    const minute = Math.floor(now / 60_000);

    advance(this.perSecond, this.second, second);
    advance(this.perMinute, this.minute, minute);

    this.second = second;
    this.minute = minute;

    this.perSecond[second % 60]! += by;
    this.perMinute[minute % 60]! += by;
  }

  /** How many requests went out at or after `from`. */
  private since(from: number): number {
    let count = 0;

    for (let at = this.sent.length - 1; at >= 0 && this.sent[at]! >= from; at--) count++;

    return count;
  }
}

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Zero every slot between two positions of a ring, so what is read back covers
 * only the window it claims to.
 *
 * A jump of a whole lap or more clears the lot: nothing in it can still be
 * inside the window.
 */
const advance = (ring: Uint32Array, from: number, to: number): void => {
  const steps = to - from;

  if (steps <= 0) return;

  if (steps >= ring.length) {
    ring.fill(0);

    return;
  }

  for (let at = from + 1; at <= to; at++) ring[at % ring.length] = 0;
};

/**
 * Requests per second over a ring, against the time it actually covers.
 *
 * **Divided by what has elapsed, not by the ring's length.** A process two
 * minutes old has fifty-eight empty minute slots, and dividing by all sixty
 * would report an hourly rate a thirtieth of the truth — a number that reads as
 * a service barely working, for the whole first hour of every run.
 */
const rate = (ring: Uint32Array, coveringMs: number): number => {
  let total = 0;

  for (const count of ring) total += count;

  return Math.round(total / Math.max(1, coveringMs / 1_000));
};

const paces = new Map<string, Pace>();

/** How much of the recent past the counter keeps, being the widest window reported. */
const HISTORY_MS = 10_000;

/**
 * How the concurrency limit opens from cold — see `Pace.allowed`.
 *
 * Ten steps a second apart, so a venue is met with a tenth of the limit and
 * reaches all of it nine seconds later. The shape matters more than the
 * numbers: what a host refuses is the wall, not the height.
 */
const RAMP_STEPS   = 10;
const RAMP_STEP_MS = 1_000;

/**
 * The fewest requests the ramp ever holds a host to.
 *
 * A limit at or below this opens in full immediately: what this guards against
 * is a hundred sockets in one millisecond, and four is not that.
 */
const RAMP_FLOOR = 4;

/**
 * How often a lane waiting on the ramp looks again. Short enough that a step is
 * taken up promptly, and only ever paid during those first seconds.
 */
const RAMP_POLL_MS = 100;

/** Quiet for this long since the last refusal before the doubling is forgotten. */
const EASE_AFTER_MS = 30 * 60_000;

/**
 * What actually went wrong, rather than the wrapper around it.
 *
 * `fetch` reports every transport fault as the same `TypeError: fetch failed`
 * and puts the reason in `cause`. A log that keeps only the message says a venue
 * is unreachable without ever saying whether the socket was refused, the name
 * would not resolve, or our own deadline fired — which are three different
 * problems with three different answers.
 */
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_paces   = paces;
export const _test_tickets = (): Tickets => tickets;

/** A fresh pool, because tickets outlive the request that took one. */
export const _test_pool = (limit: number): void => { tickets = new Tickets(limit); };
