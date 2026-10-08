import { info, warn } from '../../../shared/ui/logger';
import type { CatalogPartition, ListedLens, ListedSlice } from './types';
import type { ColdConfig } from '../types';

/**
 * The catalog, as `cold` asks it: which venues there are, which lenses, and
 * which partitions of a venue are ready to be stored.
 */

/** Every venue the catalog holds anything for. */
export const venues = async (config: ColdConfig): Promise<string[]> =>
  (await ask<{ items: { venue: string }[] }>(config, '/venues')).items.map(one => one.venue).sort();

/** Every lens there is, newest first. */
export const lenses = async (config: ColdConfig): Promise<ListedLens[]> =>
  (await ask<{ items: ListedLens[] }>(config, '/lenses')).items;

/**
 * A venue's partitions that are ready to be stored: nothing of them left to
 * download, and settled — and, where `settledBefore` is given, unchanged in the
 * catalog since. Through a lens where one is given, and otherwise every one the
 * catalog holds.
 *
 * **Asked for exactly what can be acted on.** A partition a run is still adding
 * to can be complete at every moment and still be a fraction of itself, and
 * only the catalog knows which — so one that is not settled is simply not in
 * the answer.
 */
export const readyPartitions = async (
  config:        ColdConfig,
  venue:         string,
  settledBefore: string | null,
  lens:          string | null,
): Promise<CatalogPartition[]> =>
  partitions(config, venue, {
    'downloaded': 'true',
    ...(settledBefore ? { 'settled-before': settledBefore } : { 'settled': 'true' }),
  }, lens);

/**
 * A venue's partitions that hold a file, narrowed by whatever the catalog's
 * endpoint narrows by — and every one of them where nothing is asked.
 */
export const partitions = async (
  config:  ColdConfig,
  venue:   string,
  filters: Record<string, string> = {},
  lens:    string | null = null,
): Promise<CatalogPartition[]> => {
  const query = new URLSearchParams(filters).toString();

  const { items } = await ask<{ items: ListedSlice[] }>(
    config, `/venues/${encodeURIComponent(venue)}/partitions${query ? `?${query}` : ''}`, lens);

  return items.flatMap(slice => slice.partitions
    .filter(one => one.files > 0)
    .map(one => ({
      venue,
      market: slice.market, dataset: slice.dataset, variant: slice.variant,
      grain: slice.grain, bundle: slice.bundle,
      month: one.month, files: one.files, bytes: one.bytes, version: one.version,
    })));
};

/**
 * Ask the catalog something that is not worth waiting for: where it does not
 * answer, this fails at once.
 *
 * For a look taken in the middle of other work — a push that asks again while
 * its tars are uploading. That work goes on with what it already knows, and the
 * look is taken again later; waiting here would stop it for as long as the
 * catalog is away.
 */
export const once = async <T>(look: () => Promise<T>): Promise<T> => {
  patient = false;

  try {
    return await look();
  } finally {
    patient = true;
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Whether a catalog that does not answer is waited for. */
let patient = true;

/**
 * One question to the catalog — waited for, for as long as it is not there.
 *
 * **A catalog that does not answer is restarting, or busy, and will be back.**
 * A command left running for days is not ended by that: it waits, asking again
 * after 5 seconds and then twice as long each time up to a minute, and says so
 * once as the wait begins and once as it ends. A connection that fails and a
 * `5xx` are both that. Any other answer is the catalog's own, and is not asked
 * for twice.
 */
const ask = async <T>(config: ColdConfig, path: string, lens: string | null = null): Promise<T> => {
  let waited = false;

  for (let wait = FIRST_MS; ; wait = Math.min(wait * 2, LONGEST_MS)) {
    let why: string;

    try {
      const res = await fetch(`${config.catalogUrl}${path}`, {
        headers: {
          accept: 'application/json',
          ...(config.catalogToken ? { 'x-catalog-token': config.catalogToken } : {}),
          ...(lens ? { 'x-catalog-lens': lens } : {}),
        },
      });

      if (res.ok) {
        if (waited) info('The catalog is answering again');

        return await res.json() as T;
      }

      if (res.status < 500)
        throw Object.assign(new Error(`The catalog answered ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`), { final: true });

      why = `it answered ${res.status}`;
    } catch (err) {
      if ((err as { final?: boolean }).final) throw err;

      why = (err as Error).message;
    }

    if (! patient) throw new Error(`The catalog is not answering at ${config.catalogUrl} (${why})`);

    if (! waited) warn(`The catalog is not answering at ${config.catalogUrl} (${why}) — waiting for it`);

    waited = true;

    await pause(wait);
  }
};

/** The first wait, and the longest: doubled each time between the two. */
const FIRST_MS   = 5_000;
const LONGEST_MS = 60_000;

let pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// ── Test access ───────────────────────────────────────────────────────────────

/** A stand-in for waiting; null puts the real one back. */
export const _test_pause = (sleeper: ((ms: number) => Promise<void>) | null): void => {
  pause = sleeper ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
};
