import { fetchJson, metadataGap } from '../../metadata';
import { MARKET_OF, isTestPair } from './shapes';
import type { Instrument } from '../../types';

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

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_queries = queries;
