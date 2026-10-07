import { logger } from '@devvir/service-kit';
import { fetchJson, metadataGap } from '../../metadata';
import { etagOf } from '../../etag';
import { fetchHead } from '../../http';
import {
  keyFor, venueIdOf, seriesFor,
} from '../../catalog';
import { ceiling, nextMonth, prevMonth, yesterday } from '../../dates';
import { MARKET_OF, isTestPair } from './shapes';
import type { Adapter, Instrument, Listed, Publishing } from '../../types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Where okx's data is: the ranges its keys are constructed inside, measured
 * against the venue because nothing lists them. The `span` table is this
 * file's, and what leaves it is a plain list of ranges.
 */

/**
 * Every range okx is known to publish, brought level with its listing and with the
 * bounds still missing measured.
 */
export const symbolRanges = async (
  db:       DatabaseSync,
  adapter:  Adapter,
): Promise<readonly Publishing[]> => {
  // An upsert, and the core has already done it — asked again here so this owns
  // its own lookup rather than having the id threaded down to it.
  const venueId = venueIdOf(db, adapter.name, adapter.host ?? '');

  /** A row with no start produces no path, so it is not handed out. */
  return seriesFor(db, venueId, { live: true })
    .filter(one => one.first !== null);
};

/**
 * What a lane does with what it threw: a refusal stops every lane, and any
 * other failure leaves its one bound unmeasured for the next pass.
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
            'Stopped: okx is refusing us');

          throw err;
        }

        lost++;

        logger.warn({ venue, err: describe(err) },
          'Could not find where one instrument starts; will try next pass');
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



/** Whether the venue lists this symbol. A bucket is not a symbol, and is never taken for delisted. */
const lists = (
  universe: Map<string, Set<string>>,
  market:   string,
  symbol:   string,
): boolean => symbol === '' || (universe.get(market)?.has(symbol) ?? false);

/**
 * The last period there can be a complete file for: yesterday for a day, the last
 * closed month for a month.
 */
const latest = (span: Publishing): string =>
  (span.grain === 'daily' ? yesterday() : ceiling());

const step = (span: Publishing, at: string, by: number): string => {
  if (span.grain === 'monthly') return by > 0 ? nextMonth(at) : prevMonth(at);

  const on = new Date(Date.UTC(+at.slice(0, 4), +at.slice(4, 6) - 1, +at.slice(6) + by));

  return on.toISOString().slice(0, 10).replace(/-/g, '');
};

/** Whether the venue holds a series' file for one period. */
const exists = async (adapter: Adapter, span: Publishing, at: string): Promise<boolean> => {
  const path = keyFor(span, at);

  return await head(adapter, `${adapter.base}/${adapter.keyRoot}${path}`) !== null;
};

/**
 * Where a dead pair's archive stops: walked back from the last complete period,
 * one at a time, to the first file there is. Null where the newest period is
 * still published.
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
 * What okx lists, in the catalog's words. Its only discovery; an instrument listed
 * before it trades is not live.
 */
export const okxInstruments = async (): Promise<Instrument[]> => {
  const out: Instrument[] = [];

  for (const market of ['SPOT', 'SWAP', 'FUTURES', 'OPTION']) {
    const canonical = MARKET_OF[market];

    if (! canonical) continue;

    for (const [symbol, is] of await states(market)) {
      /** A test pair publishes nothing — see `isTestPair`. */
      if (isTestPair(symbol)) continue;

      out.push({ market: canonical, symbol, live: is !== PREOPEN });
    }

    await metadataGap();
  }

  return out;
};



/** The state okx gives each instrument it lists, by family where it has one. Only `preopen` is acted on. */
const states = async (market: string): Promise<Map<string, string>> => {
  const out = new Map<string, string>();

  for (const query of await queries(market)) {
    const body = await fetchJson<{ data?: { instId?: string; instFamily?: string; state?: string }[] }>(
      `https://www.okx.com/api/v5/public/instruments?${query}`, 'okx', throttled);

    for (const one of body.data ?? []) {
      /** The family is the instrument; the id adds the market. Spot has no family and is its own name. */
      const name = one.instFamily || one.instId || '';

      if (! name) continue;

      // A family is live while any of its contracts is, and preopen only while
      // none of them has started.
      if (one.state === 'live' || ! out.has(name)) out.set(name, one.state ?? '');
    }
  }

  /** An empty market is a fault, never an answer, and is raised as one. */
  if (out.size === 0) throw new Error(`okx listed no instruments for ${market}`);

  return out;
};

/** Okx's throttle, which arrives as a code inside a `200`. */
const throttled = (body: unknown): boolean =>
  (body as { code?: string }).code === '50011';

/**
 * The queries that list one market: one, except options, which are asked an
 * underlying at a time, by `uly`.
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
 * Whether a key exists, asked through the shared sender so that it is paced.
 * Anything but a hit or a miss stops the run.
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
 * One metadata call: these endpoints throttle after a few in a row, so a refusal
 * backs off and tries again.
 */


/** The cause of a transport fault, which `fetch` hides behind one message. */
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
