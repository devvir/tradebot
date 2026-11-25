import { fetchHead, fetchPage } from './http';
import { labelOf } from './pace';
import type { Adapter, ListingContext, RunKind, Scanner } from './types';

/**
 * The context a scanner of a listed archive expects, built from an adapter.
 *
 * **Every listing venue's `getContext` is this and nothing else**, so it lives
 * here rather than being written out once per adapter: listing venues differ in
 * their addresses, not in what their scanner needs.
 *
 * The two fetchers are bound to the adapter on the way through. That is the
 * point of them: `paceFor` keys a limiter on the venue and the host, and
 * `labelOf` names the venue in the log, so a scanner handed these cannot outrun
 * a cadence, cannot pick the wrong budget, and cannot log as the wrong venue —
 * none of which it has any business deciding. They are bound to the venue's
 * stop as well — see `halted` — so a wait inside either ends when the pass is
 * asked to stop.
 */
export const listing = (adapter: Adapter<Scanner<ListingContext>>): ListingContext => ({
  name:    adapter.name,
  host:    adapter.host,
  base:    adapter.base,
  keyRoot: adapter.keyRoot,
  accepts: adapter.accepts,
  dateOf:  adapter.dateOf,
  page:    (url, format, prefix) => fetchPage(adapter, url, format, prefix, () => halted(adapter)),
  head:    (url) => fetchHead(adapter, url, () => halted(adapter)),
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
 * **What the kind says is who named the keys the pass meets.** A walk reads the
 * venue's own index, so a key it meets is one the venue said exists; an update
 * builds its keys from a pattern and a date, so a key it meets is a guess.
 *
 * **Keyed per venue, because passes run concurrently.** One process surveys
 * every venue at once, so a single global would answer for whichever started
 * last.
 *
 * **It answers for the pass in progress, not for the pass that parked a row.**
 * An update also drains whatever a walk left in `wip`, so a row being probed may
 * have been named by either kind. Who named a parked row is the row's own
 * `existence`, fixed when it was parked; this answers only what is true of the
 * moment — which pass is parking a key now, and how hard an adapter's rule
 * presses a status on this pass.
 */
export const surveying = (adapter: Adapter): RunKind | null =>
  PASSES.get(labelOf(adapter))?.kind ?? null;

/**
 * Whether the pass in progress on a venue has been asked to stop.
 *
 * **Ambient for the same reason as `surveying`.** A request waiting out a
 * venue's `Retry-After` is several calls below the pass, inside a scanner that
 * has no business knowing about it, and the stop is a property of the pass. With
 * no pass in progress, nothing has been asked to stop.
 */
export const halted = (adapter: Adapter): boolean =>
  PASSES.get(labelOf(adapter))?.stop() ?? false;

/**
 * Run one pass with its kind and its stop on record, and take them off again
 * however it ends.
 *
 * A scope rather than a pair of calls, so there is no path — a throw, a pause, a
 * venue blocking us — that leaves a venue looking like it is still walking long
 * after it stopped.
 */
export const surveyingAs = async <T>(
  adapter: Adapter,
  kind:    RunKind,
  run:     () => Promise<T>,
  stop:    () => boolean = () => false,
): Promise<T> => {
  const label = labelOf(adapter);

  PASSES.set(label, { kind, stop });

  try {
    return await run();
  } finally {
    PASSES.delete(label);
  }
};

const PASSES = new Map<string, { kind: RunKind; stop: () => boolean }>();
