import config from './config';
import { idOf } from './keys';
import type { ListedSlice, Partition, PartitionKey } from './types';

/**
 * A venue's partitions that are ready to be stocked: fully downloaded, and
 * unchanged in the catalog since `settledBefore`.
 *
 * The catalog keeps, for each partition, how many files it has, their total
 * size, how many are still to be downloaded, a version that changes whenever a
 * file of it does, and when that last happened. So it is asked for exactly what
 * a sweep can act on — one request per venue, through the configured lens, for
 * the datasets stocker reads — and what it answers also says what the archives
 * should hold.
 *
 * Nothing is kept between sweeps and nothing is written.
 */
export const listPartitions = async (
  venue:         string,
  datasets:      readonly string[],
  settledBefore: string,
): Promise<Map<string, Partition>> => {
  const query = new URLSearchParams({
    'downloaded':     'true',
    'settled-before': settledBefore,
    'datasets':       datasets.join(','),
  });

  const { items } = await ask<{ items: ListedSlice[] }>(
    `/venues/${encodeURIComponent(venue)}/partitions?${query.toString()}`);
  const found = new Map<string, Partition>();

  for (const slice of items)
    for (const one of slice.partitions) {
      const key: PartitionKey = {
        venue,
        market:  slice.market,
        dataset: slice.dataset,
        variant: slice.variant,
        bundle:  slice.bundle,
        grain:   slice.grain,
        month:   `${one.month.slice(0, 4)}-${one.month.slice(4, 6)}`,
      };

      const id = idOf(key);

      found.set(id, {
        key, id,
        files: one.files, bytes: one.bytes, pending: one.pending,
        version: one.version, updatedAt: one.updatedAt,
      });
    }

  return found;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Attempts at reaching the catalog before a request counts as failed. */
const ATTEMPTS = 4;

/** The wait before trying again, doubled each time. */
const RETRY_MS = 2_000;

/**
 * One request, tried again where the connection failed. An answer — any
 * status — is the catalog's verdict and is not retried.
 */
const ask = async <T>(path: string): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await once<T>(path);
    } catch (err) {
      if (! (err instanceof TypeError) || attempt >= ATTEMPTS) throw err;

      await new Promise(done => setTimeout(done, RETRY_MS * 2 ** (attempt - 1)));
    }
  }
};

const once = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${config.catalogApi}${path}`, {
    headers: {
      accept: 'application/json',
      ...(config.catalogToken ? { 'x-catalog-token': config.catalogToken } : {}),
      ...(config.lens ? { 'x-catalog-lens': config.lens } : {}),
    },
  });

  if (! res.ok)
    throw new Error(`Catalog answered ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);

  return await res.json() as T;
};
