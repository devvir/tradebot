import { logger } from '@devvir/service-kit';
import config from './config';
import type { BucketPage, Report, ReportAnswer } from './types';

/**
 * Hauler's whole conversation with the catalog: which venues there are, one
 * page of a venue's listing at a time, and what became of each page.
 *
 * **Only what is still owed is asked for** (`pending=true`), and through the
 * configured lens where there is one — the catalog leaves everything else out
 * of the listing, so nothing here filters. Listings are asked for as JSON; the
 * catalog answers XML otherwise, as S3 does.
 */

/**
 * Every venue the catalog holds files for, and where each one's servers answer.
 *
 * **Asked without the lens.** Only the names and the addresses are wanted, and
 * a venue the lens lets nothing through from simply lists nothing; the lensed
 * answer sizes the lens for every venue, which costs the catalog seconds.
 */
export const venues = async (): Promise<{ venue: string; hosts: Record<string, string[]> }[]> => {
  const body = await ask<{ items: { venue: string; hosts: Record<string, string[]> }[] }>('/venues', {}, false);

  return body.items.map(one => ({ venue: one.venue, hosts: one.hosts }));
};

/** One page of a venue's part of the bucket, after `marker`, of files not yet downloaded. */
export const page = async (venue: string, marker: string | null): Promise<BucketPage> => {
  const query = new URLSearchParams({ prefix: `${venue}/`, pending: 'true', 'max-keys': String(PAGE_KEYS) });

  if (marker !== null) query.set('marker', marker);

  return ask<BucketPage>(`/listings?${query.toString()}`);
};

/**
 * What became of a page.
 *
 * **Waits for a catalog that is away**, as every request does. **A report that
 * fails all the same** — refused, or not delivered as hauler stops — is only
 * logged: the files it named are listed again on the next walk, found on disk,
 * and reported then. **Keys the catalog would not
 * settle** — a `207` naming them — are logged as errors: each is a key the
 * catalog listed and then did not know, or a lens that does not let it through,
 * and neither mends itself by asking again.
 */
export const report = async (venue: string, done: Report): Promise<void> => {
  if (done.downloaded.length + done.failed.length + done.mismatched.length === 0) return;

  try {
    const answer = await ask<ReportAnswer>('/listings/report', { method: 'POST', body: JSON.stringify(done) });

    for (const one of answer.Error ?? [])
      logger.error({ key: one.Key, code: one.Code, reason: one.Message }, 'Report refused');
  } catch (err) {
    logger.warn({ venue, err: (err as Error).message, downloaded: done.downloaded.length, failed: done.failed.length,
      mismatched: done.mismatched.length }, 'Report failed — comes round again');
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** The catalog's largest page. Fetching is what takes the time, never listing. */
const PAGE_KEYS = 1_000;

/** The first wait before asking again, doubled each time up to `MAX_WAIT_MS`. */
const RETRY_MS = 1_000;

const MAX_WAIT_MS = 30_000;

/** Attempts a request is given once hauler is stopping, rather than waiting on. */
const ATTEMPTS = 3;

/**
 * Stop waiting for the catalog: hauler is stopping. A request still gets
 * `ATTEMPTS`, so a report sent on the way out survives a dropped connection.
 */
export const halt = (): void => {
  halted = true;
};

let halted = false;

/** Since when, and why, the catalog has not answered — null while it does. */
let away: { since: number; cause: string } | null = null;

/**
 * One request to the catalog, asked again for as long as the catalog is away.
 *
 * **Away is not a verdict.** A connection that failed — refused, dropped, the
 * name not found while its container restarts, no answer in time — and a `5xx`
 * are the catalog not able to answer, and nothing about the request. It is
 * waited for, a walk pausing where it is, and asked again: both kinds of
 * request are safe to repeat — a listing is a read, and reporting a file twice
 * records it once. A `4xx` is the catalog's answer, and is thrown.
 *
 * **Said once for the whole service**, as the catalog goes and as it comes
 * back, however many venues were waiting on it.
 */
const ask = async <T>(path: string, init: RequestInit = {}, lensed = true): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      const answer = await once<T>(path, init, lensed);

      if (away) {
        logger.info({ afterSeconds: Math.round((Date.now() - away.since) / 1000) }, 'The catalog answers again');

        away = null;
      }

      return answer;
    } catch (err) {
      if (! (err instanceof TypeError || err instanceof Unavailable) || (halted && attempt >= ATTEMPTS)) throw err;

      if (! away) {
        away = { since: Date.now(), cause: causeOf(err) };

        logger.warn({ cause: away.cause }, 'The catalog is not answering — waiting for it');
      }

      await new Promise(done => setTimeout(done, Math.min(MAX_WAIT_MS, RETRY_MS * 2 ** (attempt - 1))));
    }
  }
};

/** A `5xx`: the catalog could not answer, as when it is not there at all. */
class Unavailable extends Error {}

/** Why the catalog did not answer, in a word. */
const causeOf = (err: unknown): string => {
  if (err instanceof Unavailable) return err.message;

  const code = (err as { cause?: { code?: string } }).cause?.code ?? '';

  return CAUSES[code] ?? (code || (err as Error).message);
};

const CAUSES: Record<string, string> = {
  ECONNREFUSED:            'refused',
  ECONNRESET:              'dropped',
  UND_ERR_SOCKET:          'dropped',
  EAI_AGAIN:               'not found',
  ENOTFOUND:               'not found',
  UND_ERR_CONNECT_TIMEOUT: 'no connection in time',
  UND_ERR_HEADERS_TIMEOUT: 'no answer in time',
};

const once = async <T>(path: string, init: RequestInit, lensed: boolean): Promise<T> => {
  const res = await fetch(`${config.catalogApi}${path}`, {
    ...init,
    headers: {
      accept:         'application/json',
      'content-type': 'application/json',
      ...(config.catalogToken ? { 'x-catalog-token': config.catalogToken } : {}),
      ...(config.lens && lensed ? { 'x-catalog-lens': config.lens } : {}),
      ...init.headers,
    },
  });

  if (res.status >= 500) throw new Unavailable(`answered ${res.status}`);

  if (! res.ok)
    throw new Error(`Catalog answered ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);

  return await res.json() as T;
};
