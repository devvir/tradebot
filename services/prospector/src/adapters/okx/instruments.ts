import { logger } from '@devvir/service-kit';
import { fetchJson, metadataGap } from '../../metadata';
import { etagOf, fetchHead } from '../../http';
import {
  keyFor, venueIdOf, seriesFor,
} from '../../catalog';
import { ceiling, nextMonth, prevMonth, yesterday } from '../../dates';
import { MARKET_OF, isTestPair } from './shapes';
import type { Adapter, Instrument, Listed, Publishing } from '../../types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Where okx's data is, established before a single key can be constructed.
 *
 * **Bootstrapping, not scanning.** A venue that publishes no listing has to know
 * its own bounds before it can build a URL, and finding them is a walk of the
 * whole instrument universe a month at a time — hours of requests answering one
 * question. That is the venue's business rather than the scanner's: the scanner
 * turns bounds into paths, and does not care how they were come by.
 *
 * It lives apart from the adapter for the same reason. An adapter should read as
 * a description of a venue — addresses, path shapes, what it tolerates — and
 * this is several hundred lines of probing strategy that would drown it.
 *
 * The `span` table it reads and writes belongs to the venues that construct
 * their keys, and to nobody else. The core does not model it, the scanner never
 * sees it, and what comes back out is a plain list of ranges.
 */

/**
 * Every range okx is known to publish, brought level with what it lists today.
 *
 * One call does the whole job: brings the table level with the venue's own
 * listing, measures the bounds that are still missing, and hands out what can
 * produce a path.
 *
 * The database is touched only here. Everything downstream — the scanner, the
 * core, the generated keys — works from the array this returns.
 */
export const symbolRanges = async (
  db:       DatabaseSync,
  adapter:  Adapter,
): Promise<readonly Publishing[]> => {
  // An upsert, and the core has already done it — asked again here so this owns
  // its own lookup rather than having the id threaded down to it.
  const venueId = venueIdOf(db, adapter.name, adapter.host ?? '');

  /**
   * **A row with no start produces no path, so the scanner never sees it.**
   *
   * Two different rows look like this — one the venue publishes nothing for and
   * one listed but not yet started — and telling them apart is the table's
   * business rather than this function's. Neither can be generated from.
   */
  return seriesFor(db, venueId, { live: true })
    .filter(one => one.first !== null);
};

/**
 * What a lane does with what it threw.
 *
 * **A refusal stops every lane; anything else stops one bound.**
 *
 * `pool` raises what its lanes threw only once they have all drained, and for a
 * refusal that is too late: a 403 from this venue is sticky and aimed at the
 * address, so ninety-nine lanes carrying on is how a stand-down becomes a ban.
 * The first one latches and the rest stop taking work.
 *
 * **Every other failure belongs to the bound that met it, and to nothing else.**
 * Letting those out of the lane threw the whole phase away: six probes out of
 * five hundred and fifty-four exhausted their retries on a connect that never
 * completed, `pool` gathered them into one error, and the phase aborted —
 * taking the five hundred and forty-eight that had just succeeded with it.
 * Thirty seconds later the venue began again from the listing, met the same
 * weather, and failed the same way. Nothing ever finished, and the log said only
 * that the venue had failed.
 *
 * A bound nobody could measure is simply not recorded. The row keeps its empty
 * `first` or `last`, which is exactly the state the next pass looks for, so the
 * work is retried without anything having to remember that it should be — the
 * same rule a partition follows when it keeps its cursor.
 */
const laneGuard = (venue: string) => {
  let fatal: Error | null = null;
  let lost = 0;

  return {
    get fatal(): Error | null { return fatal; },
    get lost():  number       { return lost; },

    async run(work: () => Promise<void>): Promise<void> {
      if (fatal) return;

      try {
        await work();
      } catch (err) {
        if (err instanceof Throttled) {
          fatal ??= err;

          logger.error({ venue, err: describe(err) },
            'Stopping every lane — the venue is refusing us');

          throw err;
        }

        lost++;

        logger.warn({ venue, err: describe(err) },
          'Could not establish one bound — it stays outstanding for the next pass');
      }
    },
  };
};

// ── Reconciling with the venue ────────────────────────────────────────────────

/** A venue answering this is refusing us, and the run stops rather than adapts. */
export class Throttled extends Error {
  constructor(public readonly status: number, public readonly path: string) {
    super(`OKX refused with ${status} — concurrency is too high: ${path}`);
    this.name = 'Throttled';
  }
}



/**
 * Whether the venue lists this symbol at all.
 *
 * **A bucket is not a symbol and never delists.** The venue-wide files carry
 * every instrument of a market at once, so their rows have no symbol to look up
 * — and an instrument listing, which names instruments, can never mention one.
 * Reading that absence as a delisting would retire every bucket the venue has on
 * the first pass that reached here.
 */
const lists = (
  universe: Map<string, Set<string>>,
  market:   string,
  symbol:   string,
): boolean => symbol === '' || (universe.get(market)?.has(symbol) ?? false);

/**
 * The last period there can be a complete file for, at this series' grain.
 *
 * A day-grained series can be asked about yesterday; a month-grained one only
 * about the last month that has closed.
 */
const latest = (span: Publishing): string =>
  (span.grain === 'daily' ? yesterday() : ceiling());

const step = (span: Publishing, at: string, by: number): string => {
  if (span.grain === 'monthly') return by > 0 ? nextMonth(at) : prevMonth(at);

  const on = new Date(Date.UTC(+at.slice(0, 4), +at.slice(4, 6) - 1, +at.slice(6) + by));

  return on.toISOString().slice(0, 10).replace(/-/g, '');
};

/**
 * Whether the venue holds this series' file for one period.
 *
 * **The pattern is the whole of it.** Where the instrument sits and how the
 * archive spells it were settled when the row was written, so asking is
 * substituting a date and nothing else.
 */
const exists = async (adapter: Adapter, span: Publishing, at: string): Promise<boolean> => {
  const path = keyFor(span, at);

  return await head(adapter, `${adapter.base}/${adapter.root}${path}`) !== null;
};

/**
 * Where a dead pair's archive stops, found from the end.
 *
 * **Backwards from the last complete period, one at a time.** An archive that
 * has stopped stopped once, so the boundary is at the tail — and the first
 * answer walking back is it. Nothing is sampled, because a sample that misses
 * reads exactly like an ending.
 *
 * A hit on the very first probe means it has not stopped at all: okx keeps
 * publishing for a delisted instrument, indefinitely for spot candlesticks. That
 * returns null and the span stays open, which is the true statement.
 *
 * The walk is bounded below by the pair's own start, since nothing can end
 * before it began. It is cheap for a symbol that has just gone quiet and dear
 * for one that went quiet long ago — which is the right way round, because the
 * second case only arises once and never repeats.
 */
const findEnd = async (
  adapter: Adapter,
  span:    Publishing,
): Promise<{ at: string; probes: number } | null> => {
  const floor = span.first!.length === 6 && span.grain === 'daily'
    ? `${span.first}01`
    : span.first!;

  let probes = 0;

  for (let period = latest(span); period >= floor; period = step(span, period, -1)) {
    probes++;

    if (! await exists(adapter, span, period)) continue;

    // Still publishing at the far end: there is no end to record.
    return probes === 1 ? null : { at: period, probes };
  }

  // Nothing anywhere above its own start, so the archive is a single period.
  return { at: floor, probes };
};




// ── The venue's instruments ───────────────────────────────────────────────────

/** What okx calls an instrument that is announced but not yet trading. */
const PREOPEN = 'preopen';

/**
 * What okx lists, in the catalog's words and the archive's spelling.
 *
 * **The only discovery okx has.** Its CDN, its OSS origin and its website
 * endpoint all refuse `ListObjects`, so nothing about this venue can be found
 * by looking at the archive.
 *
 * **The archive's spelling is the venue's own**, beyond okx's words for a
 * market. Where the two differ — a futures family served as
 * `<name>-futureschain` — the difference is a constant of the shape and lives
 * in the pattern, not beside the symbol.
 *
 * **A pre-open instrument is not live.** okx lists a symbol before it trades,
 * and one that has never traded has published nothing — so it is reported as not
 * live, which is the honest answer to what the venue offers today.
 */
export const okxInstruments = async (): Promise<Instrument[]> => {
  const out: Instrument[] = [];

  for (const market of ['SPOT', 'SWAP', 'FUTURES', 'OPTION']) {
    const canonical = MARKET_OF[market];

    if (! canonical) continue;

    for (const [symbol, is] of await states(market)) {
      /**
       * **Never listed, never retired.** A test pair publishes nothing, so a
       * series for it is probed for ever and answers never — see `isTestPair`.
       */
      if (isTestPair(symbol)) continue;

      out.push({ market: canonical, symbol, live: is !== PREOPEN });
    }

    await metadataGap();
  }

  return out;
};



/**
 * What the venue says about each instrument it currently lists.
 *
 * **The state is the reason to ask this endpoint at all.** The full listing —
 * `priapi/v5/broker/public/trade-data/instruments` — is the better universe,
 * since it carries the dead as well as the living, but it is names only, so it
 * cannot tell an instrument that has stopped publishing from one that has not
 * started. Only this can, and the one value acted on here is `preopen`: a symbol
 * okx lists before it trades has published nothing, and creating series for it
 * would have them probed daily for a file that cannot exist yet.
 *
 * The state values are okx's, documented with the endpoint. Nothing here
 * enumerates them, because a list written down in a comment is a list that goes
 * stale silently — this reads one value and treats every other as trading.
 *
 * Keyed by family wherever the venue gives one, because that is the grain the
 * files are published at: one row per contract, many contracts to a family.
 */
const states = async (market: string): Promise<Map<string, string>> => {
  const out = new Map<string, string>();

  for (const query of await queries(market)) {
    const body = await fetchJson<{ data?: { instId?: string; instFamily?: string; state?: string }[] }>(
      `https://www.okx.com/api/v5/public/instruments?${query}`, 'okx', throttled);

    for (const one of body.data ?? []) {
      /**
       * **The family is the instrument; the id is the family plus the market.**
       * `BTC-USD` is listed as `BTC-USD-SWAP`, `BTC-USD-260828` and
       * `BTC-USD-260828-42000-C` — one family, three markets — and the archive
       * appends the market in the same way, which is why the suffix lives in the
       * pattern. Spot has no family and is its own name.
       */
      const name = one.instFamily || one.instId || '';

      if (! name) continue;

      // A family is live while any of its contracts is, and preopen only while
      // none of them has started.
      if (one.state === 'live' || ! out.has(name)) out.set(name, one.state ?? '');
    }
  }

  /**
   * **An empty market is a fault, never an answer**, and has to be raised as
   * one here: an empty list is a well-formed answer meaning "okx lists nothing
   * in this market", which is never true and is not distinguishable downstream
   * from a call that failed.
   *
   * okx says as much itself: asked for options without a family it replies
   * `{"code":"50015","data":[]}`, an empty list beside the error explaining it.
   * The only thing that made that loud was the 400 alongside it.
   */
  if (out.size === 0) throw new Error(`okx listed no instruments for ${market}`);

  return out;
};

/**
 * okx's throttle, which arrives as a code inside a `200`.
 *
 * The portal answers successfully and says no in the body, so the status alone
 * cannot tell a list of instruments from a refusal to produce one.
 */
const throttled = (body: unknown): boolean =>
  (body as { code?: string }).code === '50011';

/**
 * The queries that list one market.
 *
 * One for every market but options, which **cannot be listed whole**: okx refuses
 * `instType=OPTION` on its own with `50015, Either parameter uly or instFamily is
 * required`, so its families are fetched one underlying at a time — four of them
 * today, and read from the venue rather than written down here.
 *
 * **By `uly`, not `instFamily`.** They are not interchangeable: `instFamily`
 * answers for `BTC-USD` and `ETH-USD` and rejects `SOL-USD` and `XAU-USD` with
 * `51000, Parameter instFamily error`, while `uly` answers for all four — and
 * `uly` is what the underlying endpoint returns, so the two halves fit.
 */
const queries = async (market: string): Promise<string[]> => {
  if (market !== 'OPTION') return [`instType=${market}`];

  const body = await fetchJson<{ data?: string[][] }>(
    'https://www.okx.com/api/v5/public/underlying?instType=OPTION', 'okx', throttled);

  const [underlyings = []] = body.data ?? [];

  if (underlyings.length === 0) throw new Error('okx listed no option underlyings');

  return underlyings.map(uly => `instType=OPTION&uly=${uly}`);
};

// ── The wire ──────────────────────────────────────────────────────────────────

/**
 * Does this key exist?
 *
 * **Through the shared sender, which is what paces it.** An earlier version used
 * a bare `fetch` on the argument that the Alibaba bucket refuses nothing — true,
 * and measured at 800 a second — but the venue is addressed at its CDN now, and
 * that has a real limit at somewhere between 100 and 200 requests a second.
 * `send` is the only thing that counts requests per host, so a probe outside it
 * is a probe outside the cadence.
 *
 * A refusal still stops the run rather than slowing it. `fetchHead` has already
 * retried what was worth retrying and stood the venue down, so anything arriving
 * here that is neither a hit nor a miss means the assumption behind the run is
 * wrong — and a bound recorded from a refusal is worse than no bound, because it
 * looks measured.
 */
const head = async (adapter: Adapter, url: string): Promise<Listed | null> => {
  const res = await fetchHead(adapter, url);

  if (res.status === 200) {
    const size = res.headers.get('content-length');

    return {
      key:      url,
      size:     size === null ? null : Number(size),
      etag:     etagOf(res.headers.get('etag')),
      modified: res.headers.get('last-modified'),
    };
  }

  if (res.status === 404) return null;

  throw new Throttled(res.status, url);
};

/**
 * One metadata call, waited on rather than crashed on.
 *
 * **okx.com is not the origin and does not behave like it.** The bucket takes a
 * hundred requests in flight without complaint; these endpoints refuse the
 * second or third in a row — the instrument lists are eight calls and that alone
 * trips a 429. So they are spaced, and a refusal here backs off and tries again.
 *
 * Deliberately unlike `head`, which crashes on anything but a hit or a miss. A
 * throttle during probing means the concurrency is wrong and the run should
 * stop; a throttle while fetching eight lists means okx wants a breath.
 */


/**
 * What actually went wrong, rather than the wrapper around it.
 *
 * `fetch` reports every transport fault as the same `TypeError: fetch failed`
 * and puts the reason in `cause` — a reset socket, a refused connection, a
 * connect that timed out, a keep-alive socket the far end had already closed.
 * Those want different answers, and a log that flattens the error to its
 * message cannot tell them apart: an hour of "fetch failed" says only that
 * something is wrong somewhere.
 */
const describe = (err: unknown): string => {
  if (! (err instanceof Error)) return String(err);

  const cause = err.cause;

  if (! (cause instanceof Error)) return `${err.name}: ${err.message}`;

  const code = (cause as { code?: string }).code;

  return `${err.name}: ${err.message} — ${code ?? cause.name}: ${cause.message}`;
};



// ── Test access ───────────────────────────────────────────────────────────────

export const _test_findEnd      = findEnd;
export const _test_lists        = lists;
export const _test_laneGuard    = laneGuard;
export const _test_queries      = queries;
