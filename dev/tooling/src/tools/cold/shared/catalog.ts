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

// ── Internals ─────────────────────────────────────────────────────────────────

const ask = async <T>(config: ColdConfig, path: string, lens: string | null = null): Promise<T> => {
  let res: Response;

  try {
    res = await fetch(`${config.catalogUrl}${path}`, {
      headers: {
        accept: 'application/json',
        ...(config.catalogToken ? { 'x-catalog-token': config.catalogToken } : {}),
        ...(lens ? { 'x-catalog-lens': lens } : {}),
      },
    });
  } catch (err) {
    throw new Error(`The catalog is not answering at ${config.catalogUrl} — is it running? (${(err as Error).message})`);
  }

  if (! res.ok)
    throw new Error(`The catalog answered ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);

  return await res.json() as T;
};
