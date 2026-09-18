import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Pace, REFUSALS_BEFORE_BLOCK, STEADY, capacity, paceFor, reopenGradually, ticketing, _test_paces, _test_pool,
} from '../src/pace';
import { bybitPrimary as bybit } from '../src/adapters/bybit.primary';
import { htx } from '../src/adapters/htx';
import { binance } from '../src/adapters/binance';
import { gate } from '../src/adapters/gate';
import type { Adapter, Pacing } from '../src/types';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addressVenues } from '../src/venues';
import { venues } from '../src/catalog';
import { openCatalog } from '../src/database';

/** Fast enough not to slow the suite, and the shape a caller really passes. */
/**
 * `concurrency` is deliberately far above anything these tests reach: they are
 * about cadence and stand-down, and the in-flight bound is a separate rule with
 * its own test that sets its own figure.
 */
const pacing: Pacing = {
  perSecond: 100, concurrency: 100, ceilingMs: 400, standDownMs: 100, giveUpAfter: 50, batch: 500,
};

const cloudfront = new Headers({ server: 'CloudFront', 'x-cache': 'Error from cloudfront' });

/**
 * A venue turning us away, as a limiter sees it: a run of refusals with nothing
 * answering in between. One refusal is not a block — see `REFUSALS_BEFORE_BLOCK`
 * — so a test that means "the venue refused us" has to say it that many times.
 */
const refuses = (pace: Pace, url = 'https://venue/a'): void => {
  for (let i = 0; i < REFUSALS_BEFORE_BLOCK; i++) pace.block(403, url, cloudfront);
};

beforeEach(() => _test_paces.clear());

/**
 * A venue's traffic to one address is counted together, so every caller that
 * reaches that address has to draw on the same budget — and nothing beyond it.
 */
describe('one budget per venue per host', () => {
  it('hands the same gate to everyone asking about a venue at a host', () => {
    expect(paceFor(bybit, bybit.base)).toBe(paceFor(bybit, bybit.base));
  });

  it('keeps unrelated hosts apart', () => {
    expect(paceFor(bybit, bybit.base)).not.toBe(paceFor(htx, htx.base));
  });

  /**
   * **Two venues behind one endpoint are two budgets.** binance and gate sit on
   * the same S3 host, one bucket each, and each bucket took ~1,700 requests a
   * second without a throttle — so sharing one limiter only let whichever venue
   * started first set the other's pace.
   */
  it('keeps two venues on the same host apart', () => {
    expect(new URL(binance.base).host).toBe(new URL(gate.base).host);
    expect(paceFor(binance, binance.base)).not.toBe(paceFor(gate, gate.base));
  });

  /** And one venue at two hosts — its archive and its own API — is paced apart. */
  it('keeps one venue\'s hosts apart', () => {
    expect(paceFor(binance, binance.base)).not.toBe(paceFor(binance, 'https://api.binance.com/api/v3/exchangeInfo'));
  });

  /** A brake that reset every pass is a brake that never applies twice. */
  it('outlives the pass that first asked for it', () => {
    refuses(paceFor(bybit, bybit.base), 'https://public.bybit.com/spot/');

    expect(paceFor(bybit, bybit.base).blockedFor()).toBeGreaterThan(0);
  });

  /**
   * Bybit states a rate and a width, having measured them; what it says nothing
   * about falls back. So the pair worth asserting is a field it declares against
   * the two it leaves alone — a stand-down is deliberately not among them, since
   * the figure it once carried described a different host's ban policy.
   */
  it('takes the venue figure where there is one, and the default elsewhere', () => {
    expect(paceFor(bybit, bybit.base).pacing.perSecond).toBe(bybit.pacing!.perSecond);
    expect(paceFor(bybit, bybit.base).pacing.standDownMs).toBe(STEADY.standDownMs);
    expect(paceFor(bybit, bybit.base).pacing.ceilingMs).toBe(STEADY.ceilingMs);
  });
});

describe('the rate it allows', () => {
  it('spaces requests to the cap it was given', async () => {
    const pace = new Pace('test', { ...pacing, perSecond: 5 });
    const at   = Date.now();

    // Five fit inside the first second; the sixth has to wait for one to age out.
    // Released as they go, because a slot is a request in flight and every
    // caller pairs the two — `send` does it in a `finally`.
    for (let i = 0; i < 6; i++) { await pace.slot(); pace.done(); }

    expect(Date.now() - at).toBeGreaterThanOrEqual(900);
  }, 10_000);

  /**
   * Lanes are handed slots one at a time from a counter checked and claimed in
   * the same tick, so concurrent callers cannot all read the same free slot and
   * all take it — which is how a cap of five becomes a burst of twenty.
   */
  it('does not let concurrent lanes overshoot the cap', async () => {
    const pace = new Pace('test', { ...pacing, perSecond: 5 });
    const at   = Date.now();

    await Promise.all(Array.from({ length: 5 }, () => pace.slot()));

    expect(Date.now() - at).toBeLessThan(500);
    expect(pace.rates().lastSecond).toBe(5);
  });

  /**
   * **The cap belongs to the host, not to whoever is walking it.** Two venues
   * can share an address — binance and gate are both
   * `s3-ap-northeast-1.amazonaws.com` — and each running its own pool meant
   * twice the intended sockets against it, which does not queue politely: it
   * opens connections until new ones stop being accepted and every request dies
   * on its own timeout having sent nothing.
   */
  it('holds a lane once the host is carrying its share', async () => {
    const pace = new Pace('test', { ...pacing, perSecond: 1000, concurrency: 2 });

    await pace.slot();
    await pace.slot();

    let third = false;

    const waiting = pace.slot().then(() => { third = true; });

    await new Promise(resolve => setTimeout(resolve, 30));
    expect(third).toBe(false);

    pace.done();
    await waiting;

    expect(third).toBe(true);
  });

  /**
   * **Concurrency is for keeping the pipe full, not for arriving all at once.**
   * htx took a hundred connections from a standing start, answered none of
   * them, and every one died on its own deadline having never been replied to —
   * a host that serves 100/s sustained can still refuse to be met with 100 in
   * the same millisecond. So the limit opens in tenths rather than instantly.
   */
  it('opens a large limit gradually rather than all at once', async () => {
    const pace = new Pace('cold', { ...pacing, perSecond: 10_000, concurrency: 100 });

    // A tenth of the limit is available immediately, and no more.
    for (let at = 0; at < 10; at++) await pace.slot();

    let eleventh = false;

    void pace.slot().then(() => { eleventh = true; });

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(eleventh).toBe(false);
  });

  /**
   * **A handful is not a burst.** A tenth of a limit of two is one, and holding
   * the second connection back would tax every small limit to guard against a
   * storm it could never produce.
   */
  it('opens a small limit in full at once', async () => {
    const pace = new Pace('small', { ...pacing, perSecond: 10_000, concurrency: 4 });

    let all = false;

    void (async () => {
      for (let at = 0; at < 4; at++) await pace.slot();

      all = true;
    })();

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(all).toBe(true);
  });
});

describe('when a venue turns us away', () => {
  /**
   * Every lane in flight fails at roughly the same instant. Counting each of
   * them would escalate to the ceiling in milliseconds, before the venue has had
   * any chance to answer differently.
   */
  it('pauses once for a round of refusals, not once per lane', () => {
    const pace = new Pace('test', pacing);

    for (let i = 0; i < 50; i++) pace.block(403, 'https://venue/a', cloudfront);

    expect(pace.blockedFor()).toBeLessThanOrEqual(pacing.standDownMs);
  });

  /** A venue that keeps refusing is left alone for longer each time, up to the cap. */
  it('doubles the stand-down on a later round and stops at the ceiling', async () => {
    const pace = new Pace('test', { ...pacing, standDownMs: 50, ceilingMs: 120 });

    refuses(pace);
    await new Promise(resolve => setTimeout(resolve, 60));

    refuses(pace);
    expect(pace.blockedFor()).toBeGreaterThan(50);

    await new Promise(resolve => setTimeout(resolve, 110));

    refuses(pace);
    expect(pace.blockedFor()).toBeLessThanOrEqual(120);
  });

  /**
   * The doubling protects against repeated blocks in close succession, so it is
   * forgotten on time since the last one — never on a count of good answers,
   * which is a proxy for time whose meaning the rate decides.
   */
  it('keeps the escalation until the venue has been quiet for long enough', async () => {
    const pace = new Pace('test', { ...pacing, standDownMs: 20, ceilingMs: 10_000 });

    refuses(pace);

    await new Promise(resolve => setTimeout(resolve, 30));

    // Answering cleanly straight after a block does not undo it.
    await pace.slot();
    pace.eased();
    refuses(pace);

    expect(pace.blockedFor()).toBeGreaterThan(20);
  });

  /** Nothing goes out while the latch holds, whichever caller is asking. */
  it('holds a request until the stand-down has run', async () => {
    const pace = new Pace('test', { ...pacing, standDownMs: 200 });
    const at   = Date.now();

    refuses(pace);
    await pace.slot();

    expect(Date.now() - at).toBeGreaterThanOrEqual(180);
  });
});

/**
 * The measurement the whole exercise is for: an average over a pass counts the
 * time spent paused, so it reads far below what was actually being sent at the
 * moment a venue refused.
 */
describe('what it reports', () => {
  it('counts only the requests inside the window', async () => {
    const pace = new Pace('test', { ...pacing, perSecond: 1000 });

    for (let i = 0; i < 8; i++) await pace.slot();

    expect(pace.rates().lastSecond).toBe(8);
    expect(pace.rates().peakPerSecond).toBe(8);
  });

  it('keeps the peak after the window has emptied', async () => {
    const pace = new Pace('test', { ...pacing, perSecond: 1000 });

    for (let i = 0; i < 4; i++) await pace.slot();

    await new Promise(resolve => setTimeout(resolve, 1100));

    expect(pace.rates().lastSecond).toBe(0);
    expect(pace.rates().peakPerSecond).toBe(4);
  }, 10_000);

  it('counts what is out and not yet answered', async () => {
    const pace = new Pace('test', { ...pacing, perSecond: 1000 });

    await pace.slot();
    await pace.slot();

    expect(pace.rates().inFlight).toBe(2);

    pace.done();

    expect(pace.rates().inFlight).toBe(1);
  });

  it('counts an attempt at a request already made', async () => {
    const pace = new Pace('test', { ...pacing, perSecond: 1000 });

    await pace.slot();

    expect(pace.rates().retries).toBe(0);

    pace.retry();
    pace.retry();

    expect(pace.rates().retries).toBe(2);
  });
});

/**
 * **The windows a steady pass is judged on.** Ten seconds says where the window
 * landed rather than how the pass is going: on a venue that stands down, it
 * reports a collapse whenever a pause falls inside it and full speed whenever
 * one does not. Minutes and hours are what a survey running for days is read on,
 * and they are counted in buckets because an hour of timestamps at these rates
 * is millions of numbers held to answer one log line.
 */
describe('the rate over minutes and hours', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    _test_pool(1000);
  });

  afterEach(() => vi.useRealTimers());

  /** Enough to measure, under the ramp's first-second allowance. */
  const sixty = async (pace: Pace) => {
    for (let i = 0; i < 60; i++) await pace.slot();
  };

  it('averages over the time actually elapsed, not the width of the window', async () => {
    const pace = new Pace('test', { ...pacing, perSecond: 1000, concurrency: 1000 });

    await sixty(pace);

    vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'));

    /**
     * Sixty requests, thirty seconds old. Divided by the window's full width
     * this would read as 1/s, and a service would look asleep for its first
     * hour of every run.
     */
    expect(pace.rates().lastMinute).toBe(2);
    expect(pace.rates().lastHour).toBe(2);
  });

  it('forgets a minute that has passed, and the hour remembers it', async () => {
    const pace = new Pace('test', { ...pacing, perSecond: 1000, concurrency: 1000 });

    await sixty(pace);

    vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));

    expect(pace.rates().lastMinute).toBe(0);
    expect(pace.rates().lastHour).toBe(1);
  });

  /** A gap wider than the ring clears all of it rather than wrapping onto stale counts. */
  it('reports nothing for a venue that has been idle', async () => {
    const pace = new Pace('test', { ...pacing, perSecond: 1000, concurrency: 1000 });

    await sixty(pace);

    vi.setSystemTime(new Date('2026-01-01T02:00:00.000Z'));

    expect(pace.rates().lastMinute).toBe(0);
    expect(pace.rates().lastHour).toBe(0);
  });
});

/** A venue with no opinion gets the timid default rather than a guess. */
describe('a venue that states nothing', () => {
  it('is paced by STEADY', () => {
    const quiet = { ...htx, name: 'quiet', pacing: undefined } as Adapter;

    expect(paceFor(quiet, quiet.base).pacing).toEqual(STEADY);
  });
});

/**
 * Give the adapters their addresses, as startup does.
 *
 * **Where a venue is lives in the `venue` table**, written by a migration, so an
 * adapter carries no address until it is handed one. A test that uses a real
 * venue needs that step; one that invents its own venue does not.
 */
const address = () => {
  const here = mkdtempSync(join(tmpdir(), 'addresses-'));
  const db   = openCatalog(join(here, 'catalog.db'));

  addressVenues(venues(db));

  db.close();
  rmSync(here, { recursive: true, force: true });
};

address();


// ── the machine-wide ticket pool ──────────────────────────────────────────────

describe('the ticket pool every host draws from', () => {
  /** A host with room to spare, so only the pool can be what holds anything up. */
  const roomy = (name: string): Pace =>
    new Pace(name, { ...STEADY, perSecond: 10_000, concurrency: 10_000 });

  /** Long enough for a released waiter to run, and no longer. */
  const settle = async (): Promise<void> => {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
  };

  it('hands out no more than the machine allows, however many hosts ask', async () => {
    _test_pool(3);

    const hosts = [roomy('a'), roomy('b'), roomy('c')];

    await Promise.all(hosts.map(one => one.slot()));

    expect(ticketing().outstanding).toBe(3);

    let fourth = false;

    void roomy('d').slot().then(() => { fourth = true; });

    await settle();

    expect(fourth).toBe(false);
    expect(ticketing().queued).toBe(1);

    hosts[0]!.done();

    await settle();

    expect(fourth).toBe(true);
  });

  it('serves waiting hosts in the order they asked', async () => {
    _test_pool(1);

    const holder = roomy('holder');

    await holder.slot();

    const order:  string[] = [];
    const queued = ['b', 'c', 'd'].map(name => {
      const host = roomy(name);

      void host.slot().then(() => { order.push(name); });

      return host;
    });

    await settle();

    expect(order).toEqual([]);

    holder.done();
    await settle();
    expect(order).toEqual(['b']);

    queued[0]!.done();
    await settle();
    expect(order).toEqual(['b', 'c']);

    queued[1]!.done();
    await settle();
    expect(order).toEqual(['b', 'c', 'd']);
  });

  it('never lets a host exceed its own limit, whatever the pool allows', async () => {
    _test_pool(1_000);

    const host = new Pace('tight', { ...STEADY, perSecond: 10_000, concurrency: 2 });

    await host.slot();
    await host.slot();

    let third = false;

    void host.slot().then(() => { third = true; });

    await settle();

    expect(third).toBe(false);
    // Waiting on its own limit, so it is not sitting on a ticket meanwhile.
    expect(ticketing().outstanding).toBe(2);

    host.done();

    await settle();

    expect(third).toBe(true);
  });

  it('gives a lone host the whole pool rather than a share of it', async () => {
    _test_pool(5);

    const only = roomy('alone');

    for (let at = 0; at < 5; at++) await only.slot();

    expect(ticketing().outstanding).toBe(5);
  });

  it('releases whoever is queued when the ceiling is raised', async () => {
    _test_pool(1);

    const host = roomy('grow');

    await host.slot();

    let second = false;

    void host.slot().then(() => { second = true; });

    await settle();

    expect(second).toBe(false);

    capacity(2);

    await settle();

    expect(second).toBe(true);
  });
});


// ── the pool opens gradually ──────────────────────────────────────────────────

/**
 * A start releases every venue at once, and every request over HTTP/1.1 is a
 * TLS handshake on a transport worker's one thread. So the machine's ceiling is
 * reached a hundred at a time, a step for every thousand requests answered.
 */
describe('the machine-wide ceiling', () => {
  const roomy = (): Pace => new Pace('ramp', { ...STEADY, perSecond: 1_000_000, concurrency: 1_000_000 });

  const answer = async (host: Pace, count: number): Promise<void> => {
    for (let i = 0; i < count; i++) {
      await host.slot();
      host.done();
    }
  };

  afterEach(() => _test_pool(1_000));

  it('starts at a hundred, whatever the configured ceiling', () => {
    capacity(3_000);

    expect(ticketing()).toMatchObject({ limit: 100, ceiling: 3_000 });
  });

  it('widens by a hundred for every thousand requests answered', async () => {
    capacity(3_000);

    const host = roomy();

    await answer(host, 999);

    expect(ticketing().limit).toBe(100);

    await answer(host, 1);

    expect(ticketing().limit).toBe(200);
  });

  it('never passes the configured ceiling', async () => {
    capacity(150);

    await answer(roomy(), 1_000);

    expect(ticketing().limit).toBe(150);
  });

  /** The network gate releasing everything it held is a start all over again. */
  it('starts over from a hundred when asked to reopen', async () => {
    capacity(3_000);

    await answer(roomy(), 2_000);

    expect(ticketing().limit).toBe(300);

    reopenGradually();

    expect(ticketing().limit).toBe(100);
  });

  it('is a plain ceiling below a hundred', () => {
    capacity(40);

    expect(ticketing().limit).toBe(40);
  });
});

// ── a venue that cannot be reached at all ─────────────────────────────────────

/**
 * **A timeout is noise, not a verdict.** A full run of six archives takes hours
 * and scatters connect failures throughout, on hosts that are answering other
 * callers perfectly well the whole time. Standing a venue down over one costs
 * hours of surveying and buys nothing, since the venue was never objecting.
 */
describe('a request that never reaches the venue', () => {
  const host = (over: Partial<Pacing> = {}): Pace =>
    new Pace('gone', { ...STEADY, perSecond: 10_000, concurrency: 10_000, giveUpAfter: 3, ...over });

  it('never pauses the venue, however many fail', () => {
    const pace = host();

    for (let at = 0; at < 50; at++) pace.faulted('https://gone/x', new Error('boom'));

    expect(pace.blockedFor()).toBe(0);
  });

  it('leaves the gate open so the next request goes straight out', async () => {
    _test_pool(10);

    const pace = host();

    for (let at = 0; at < 20; at++) pace.faulted('https://gone/x', new Error('boom'));

    const waited = Date.now();

    await pace.slot();

    expect(Date.now() - waited).toBeLessThan(50);
  });

  /** A refusal is a different claim, and that one does still escalate. */
  it('still escalates when the venue actually refuses us', () => {
    const pace = host({ standDownMs: 10 });
    const head = new Headers();

    for (let i = 0; i < REFUSALS_BEFORE_BLOCK; i++) pace.block(403, 'https://gone/x', head);
    const first = pace.blockedFor();

    return new Promise<void>(done => setTimeout(() => {
      for (let i = 0; i < REFUSALS_BEFORE_BLOCK; i++) pace.block(403, 'https://gone/x', head);

      expect(pace.blockedFor()).toBeGreaterThan(first);
      done();
    }, 20));
  });
});
