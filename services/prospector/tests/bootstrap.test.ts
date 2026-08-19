import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchHead } from '../src/http';
import {
  _test_findEnd as findEnd,
  _test_lists as lists,
  _test_queries as queries,
  _test_laneGuard as laneGuard,
  Throttled,
} from '../src/adapters/okx/instruments';
import { okx } from '../src/adapters/okx';
import type { Series } from '../src/types';

vi.mock('../src/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/http')>()),
  fetchHead: vi.fn(),
}));

/**
 * Finding the bounds a span is still missing.
 *
 * **Which rows get asked is decided by the row, not by the news.** A symbol that
 * listed last week may not be publishing yet and one delisted yesterday may keep
 * publishing for days, so "changed state this pass" is the wrong trigger in both
 * directions — "has no start" and "has no end" are the right ones, and these are
 * the two searches that answer them.
 */

/**
 * One series, which carries its own grain and pattern: probing asks the row
 * rather than the dataset, so the grain of a search is a property of the row it
 * is searching.
 */
const span = (over: Partial<Series> = {}): Series => ({
  venueId: 1, market: 'SPOT', symbol: 'BTC-USDT', dataset: 'trades',
  grain:   'daily',
  pattern: 'okex/traderecords/trades/daily/{YYYY}{MM}{DD}/{SYMBOL}-trades-{YYYY}-{MM}-{DD}.zip',
  first:   null, last: null, tip: null,
  state:   'active', ...over,
});

/** Answers 200 for the days named, 404 for everything else. */
const serving = (...days: string[]) => {
  vi.mocked(fetchHead).mockImplementation(async (_adapter, url: string) => {
    const stamp = /(\d{4})-(\d{2})(?:-(\d{2}))?\.zip/.exec(url);
    const at    = stamp ? stamp[1]! + stamp[2]! + (stamp[3] ?? '') : '';

    return {
      status:  days.includes(at) ? 200 : 404,
      headers: new Headers(days.includes(at) ? { 'content-length': '10', etag: '"a"' } : {}),
    };
  });
};

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-08-17T10:00:00Z') }));

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(fetchHead).mockReset();
});


describe('finding an end', () => {
  /**
   * **Backwards from the last complete day, one at a time.** An archive that
   * stopped stopped once, so the boundary is at the tail. Nothing is sampled,
   * because a sample that misses reads exactly like an ending.
   */
  it('takes the last day that answers', async () => {
    serving('20260801', '20260802', '20260803');

    const found = await findEnd(okx, span({ first: '20260801', state: 'delisted' }));

    expect(found?.at).toBe('20260803');
  });

  /**
   * A delisted instrument whose archive runs on has no end to record — okx keeps
   * writing for a while after a listing stops — and an open span
   * is the true statement about it.
   */
  it('leaves a span open when the venue is still publishing', async () => {
    serving('20260816');

    expect(await findEnd(okx, span({ first: '20260101', state: 'delisted' }))).toBeNull();
  });

  /** Nothing above its own start means the archive is that one period. */
  it('falls back to the start when nothing answers above it', async () => {
    serving();

    const found = await findEnd(okx, span({ first: '20260810', state: 'delisted' }));

    expect(found?.at).toBe('20260810');
  });
});


/**
 * What the instrument listing licenses, and what it does not.
 *
 * Everything absent from it is retired, which makes the "absent" side of this
 * question the dangerous one: a retirement is not visible afterwards the way a
 * stopped survey is.
 */
describe('what the venue lists', () => {
  const universe = new Map([['SPOT', new Set(['BTC-USDT'])], ['OPTION', new Set(['BTC-USD'])]]);

  it('recognises an instrument the venue still lists', () => {
    expect(lists(universe, 'SPOT', 'BTC-USDT')).toBe(true);
  });

  it('does not recognise one it has stopped listing', () => {
    expect(lists(universe, 'SPOT', 'LUNA-USDT')).toBe(false);
  });

  /**
   * **A bucket is not an instrument.** The venue-wide files carry every
   * instrument of a market at once, so their rows have no symbol — and a list of
   * instruments can never name one. Read as a delisting it would retire every
   * bucket the venue has, on the first pass that got this far.
   */
  it('never retires a venue-wide file for being absent from an instrument list', () => {
    expect(lists(universe, 'SPOT', '')).toBe(true);
    expect(lists(new Map(), 'OPTION', '')).toBe(true);
  });
});

/**
 * Listing one market, which is one request everywhere but options.
 *
 * okx refuses `instType=OPTION` on its own — `50015, Either parameter uly or
 * instFamily is required` — so options are fetched per underlying. The two
 * parameters are **not** interchangeable: `instFamily` answers for `BTC-USD` and
 * `ETH-USD` and rejects `SOL-USD` and `XAU-USD`, while `uly` answers for all
 * four, and `uly` is what the underlying endpoint returns.
 */
describe('listing a market', () => {
  const fetching = (body: unknown) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  };

  afterEach(() => vi.unstubAllGlobals());

  it('asks once for a market that can be listed whole', async () => {
    expect(await queries('SPOT')).toEqual(['instType=SPOT']);
    expect(await queries('SWAP')).toEqual(['instType=SWAP']);
  });

  it('asks once per underlying for options, by uly', async () => {
    fetching({ code: '0', data: [['SOL-USD', 'BTC-USD']] });

    expect(await queries('OPTION')).toEqual([
      'instType=OPTION&uly=SOL-USD',
      'instType=OPTION&uly=BTC-USD',
    ]);
  });

  /**
   * An empty underlying list would leave options unasked-about, and everything
   * absent from a listing is retired — so it stops instead.
   */
  it('refuses to proceed with no underlyings', async () => {
    fetching({ code: '0', data: [[]] });

    await expect(queries('OPTION')).rejects.toThrow(/no option underlyings/);
  });
});


// ── what a lane does with what it threw ───────────────────────────────────────

/**
 * The bounds walk is hundreds of independent probes, and it used to be all or
 * nothing: `pool` gathers what its lanes threw and raises it once they drain, so
 * a handful of connect failures aborted the whole reconciliation — including
 * every bound that had just been established beside them.
 */
describe('a lane that fails', () => {
  it('keeps the rest going when one bound cannot be established', async () => {
    const lane = laneGuard('okx');
    const done: string[] = [];

    await lane.run(async () => { done.push('first'); });
    await lane.run(async () => { throw new TypeError('fetch failed'); });
    await lane.run(async () => { done.push('third'); });

    expect(done).toEqual(['first', 'third']);
    expect(lane.fatal).toBeNull();
    expect(lane.lost).toBe(1);
  });

  it('counts every bound it could not establish', async () => {
    const lane = laneGuard('okx');

    for (let at = 0; at < 6; at++)
      await lane.run(async () => { throw new TypeError('fetch failed'); });

    expect(lane.lost).toBe(6);
    expect(lane.fatal).toBeNull();
  });

  /**
   * A refusal is the one failure that is about the address rather than the key,
   * and it is sticky — so it stops every lane rather than costing one bound.
   */
  it('latches on a refusal and stops taking work', async () => {
    const lane = laneGuard('okx');
    const done: string[] = [];

    await expect(lane.run(async () => { throw new Throttled(403, 'x'); })).rejects.toThrow(Throttled);

    await lane.run(async () => { done.push('after'); });

    expect(done).toEqual([]);
    expect(lane.fatal).toBeInstanceOf(Throttled);
    expect(lane.lost).toBe(0);
  });
});
