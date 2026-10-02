import { logger } from '@devvir/service-kit';
import config from './config';
import type { BucketPage, Report } from './types';

/**
 * Hauler's whole conversation with the catalog: which venues there are, one
 * page of a venue's bucket at a time, and what became of each page.
 *
 * **Only what is still owed is asked for** (`pending=true`), and through the
 * configured lens where there is one — the catalog leaves everything else out
 * of the listing, so nothing here filters. Listings are asked for as JSON; the
 * catalog answers XML otherwise, as S3 does.
 */

/** Every venue the catalog surveys. */
export const venues = async (): Promise<string[]> => {
  const body = await ask<{ items: { venue: string }[] }>('/venues');

  return body.items.map(one => one.venue);
};

/** One page of a venue's bucket, after `marker`, of files not yet downloaded. */
export const page = async (venue: string, marker: string | null): Promise<BucketPage> => {
  const query = new URLSearchParams({ pending: 'true', 'max-keys': String(PAGE_KEYS) });

  if (marker !== null) query.set('marker', marker);

  return ask<BucketPage>(`/buckets/${encodeURIComponent(venue)}?${query.toString()}`);
};

/**
 * What became of a page. A report that fails is only logged: the files it
 * named are listed again on the next walk, found on disk, and reported then.
 */
export const report = async (venue: string, done: Report): Promise<void> => {
  if (done.downloaded.length + done.failed.length + done.mismatched.length === 0) return;

  try {
    await ask(`/buckets/${encodeURIComponent(venue)}/report`, { method: 'POST', body: JSON.stringify(done) });
  } catch (err) {
    logger.warn({ err, venue, downloaded: done.downloaded.length, failed: done.failed.length,
      mismatched: done.mismatched.length }, 'Could not report a page — it will come round again');
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** The catalog's largest page. Fetching is what takes the time, never listing. */
const PAGE_KEYS = 1_000;

/** Attempts at reaching the catalog before a request counts as failed. */
const ATTEMPTS = 3;

/** The wait before trying again, doubled each time. */
const RETRY_MS = 1_000;

/**
 * One request to the catalog, tried again where the connection failed.
 *
 * **Only a connection that failed is retried** — reset, refused, dropped. The
 * catalog closes idle keep-alive connections, so a request now and then lands on
 * one just as it goes; and a catalog restarting is gone for a few seconds. An
 * answer, any answer, is not retried: a `4xx` or `5xx` is the catalog's verdict.
 * Both kinds of request are safe to repeat — a listing is a read, and reporting
 * a file twice records it once.
 */
const ask = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await once<T>(path, init);
    } catch (err) {
      if (! (err instanceof TypeError) || attempt >= ATTEMPTS) throw err;

      await new Promise(done => setTimeout(done, RETRY_MS * 2 ** (attempt - 1)));
    }
  }
};

const once = async <T>(path: string, init: RequestInit): Promise<T> => {
  const res = await fetch(`${config.catalogUrl}${path}`, {
    ...init,
    headers: {
      accept:         'application/json',
      'content-type': 'application/json',
      ...(config.catalogToken ? { 'x-catalog-token': config.catalogToken } : {}),
      ...(config.lens ? { 'x-catalog-lens': config.lens } : {}),
      ...init.headers,
    },
  });

  if (! res.ok)
    throw new Error(`Catalog answered ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);

  return await res.json() as T;
};
