import { fetchHead, fetchText } from './http';
import { labelOf } from './pace';
import type { Adapter, ListingContext, RunKind, Scanner } from './types';

/**
 * The context a scanner of a listed archive expects, built from an adapter.
 *
 * **Every listing venue's `getContext` is this and nothing else**, so it lives
 * here rather than being written out eight times — binance, htx, kucoin, gate
 * and both bybit hosts differ in their addresses, not in what their scanner
 * needs.
 *
 * The two fetchers are bound to the adapter on the way through. That is the
 * point of them: `paceFor` keys a limiter on the host, and `labelOf` names the
 * venue in the log, so a scanner handed these cannot outrun a cadence, cannot
 * pick the wrong budget, and cannot log as the wrong venue — none of which it
 * has any business deciding.
 */
export const listing = (adapter: Adapter<Scanner<ListingContext>>): ListingContext => ({
  name:    adapter.name,
  list:    adapter.list,
  base:    adapter.base,
  root:    adapter.root,
  accepts: adapter.accepts,
  dateOf:  adapter.dateOf,
  text:    (url) => fetchText(adapter, url),
  head:    (url) => fetchHead(adapter, url),
});

/**
 * What kind of pass a venue is in the middle of, asked from anywhere.
 *
 * **Ambient because the question is ambient.** An adapter rule is handed one
 * answer about one key — a status, some headers, an attempt count — and cannot
 * be told which pass it belongs to without threading a parameter through every
 * caller between here and there. The rule is a property of the venue, so it asks
 * the venue.
 *
 * The distinction it exists for is what a `404` *means*. On a walk of a probing
 * venue the index has already said the file is there, so absence contradicts
 * evidence and is worth confirming hard. On an update the key was constructed
 * from a pattern and a date, so absence is the ordinary answer to a guess and
 * confirming it a hundred times is a hundred requests spent proving what one
 * said. Same status, same hook, opposite meanings.
 *
 * **Keyed per venue, because passes run concurrently.** One process surveys
 * every venue at once, so a single global would answer for whichever started
 * last.
 *
 * **What it cannot say is where a row came from**, and that is not what it is
 * for. It reports the pass in progress, so an update draining a walk's undrained
 * backlog would judge those rows as an update would. What a candidate's absence
 * is worth therefore comes from the candidate: `existence` records who named it
 * when it is parked, and the probe reads that rather than asking here.
 *
 * This stays for the questions that really are about the pass — an adapter's own
 * rule about how hard to press a status, which is a property of the venue and of
 * the moment rather than of the key.
 */
export const surveying = (adapter: Adapter): RunKind | null =>
  PASSES.get(labelOf(adapter)) ?? null;

/**
 * Run one pass with its kind on record, and take it off again however it ends.
 *
 * A scope rather than a pair of calls, so there is no path — a throw, a pause, a
 * venue blocking us — that leaves a venue looking like it is still walking long
 * after it stopped.
 */
export const surveyingAs = async <T>(
  adapter: Adapter,
  kind:    RunKind,
  run:     () => Promise<T>,
): Promise<T> => {
  const label = labelOf(adapter);

  PASSES.set(label, kind);

  try {
    return await run();
  } finally {
    PASSES.delete(label);
  }
};

const PASSES = new Map<string, RunKind>();
