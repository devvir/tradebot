import { logger } from '@devvir/service-kit';
import config from './config';
import { ANY } from './types';
import type { Offered, Page, Plan, Report, Shape } from './types';

/**
 * The catalog, as hauler reaches it.
 *
 * **Hauler asks for a list and fetches what is on it.** Whether those URLs
 * follow an obvious pattern or look random is not its business, and nothing
 * here parses one: a URL is an opaque string that goes to `fetch` and comes back
 * as bytes. Every decision hauler makes is made from the fields beside it.
 *
 * **Hauler reports problems; the catalog rules on them.** Nothing here tells the
 * catalog what is true. A file that would not download, or that arrived weighing
 * something else, is reported as a problem — and prospector re-probes the venue
 * and decides what its own data should say. One service owns what exists, the
 * other owns what is on disk, and neither writes the other's conclusions.
 */

/**
 * One page of files still owed for a partition, oldest first.
 *
 * `after` continues a listing; leaving it out starts one. The cursor is opaque
 * on purpose — reading it would make hauler depend on an ordering that is the
 * catalog's to choose.
 */
export const pending = async (
  plan:   Plan,
  month:  string,
  after?: string,
): Promise<Page> => {
  const body = await ask<{ items: Wire[]; next: string | null }>(
    `/venues/${encodeURIComponent(plan.venue)}/pending?${listing(plan, month, after)}`);

  return { items: body.items.map(item => received(item, plan.venue)), next: body.next };
};

/**
 * What a venue publishes, in canonical terms — one row per
 * `(market, dataset, variant, grain)`.
 *
 * **The question a want is resolved against.** It reads patterns and series
 * rather than files, so asking it every pass costs nothing and the answer is
 * current: a venue that added an interval yesterday says so here today.
 */
export const shapes = async (
  venue:   string,
  market:  string,
  dataset: string,
): Promise<Shape[]> => {
  /**
   * **A wildcard is the absence of the filter**, which is what the catalog
   * already means by omitting it — so `*` needs nothing at the far end.
   */
  const query = new URLSearchParams({
    ...(market  === ANY ? {} : { market }),
    ...(dataset === ANY ? {} : { dataset }),
  });

  const body = await ask<{ items: Shape[] }>(
    `/venues/${encodeURIComponent(venue)}/shapes?${query.toString()}`);

  return body.items;
};

/**
 * Whether a partition has anything outstanding.
 *
 * **The cheap direction of the question.** "Which partitions are complete?" has
 * to examine every one and prove that none of its files is still owed; "is this
 * one complete?" is the same query hauler already asks for work, stopped at the
 * first row. And because it is computed rather than stored, the answer is true
 * at the moment it is asked: a URL prospector found an hour ago simply makes the
 * partition incomplete again, with nothing having to invalidate anything.
 */
export const isComplete = async (plan: Plan, month: string): Promise<boolean> => {
  const body = await ask<{ items: unknown[] }>(
    `/venues/${encodeURIComponent(plan.venue)}/pending?${listing(plan, month, undefined, 1)}`);

  return body.items.length === 0;
};

/**
 * Hand back what happened to a page.
 *
 * **The report says what did not arrive as well as what did**, which is the
 * whole handshake: without the failing half the catalog goes on offering keys
 * that never deliver, and a partition holding one can never finish. With it,
 * prospector re-probes and either confirms the file is there — so hauler tries
 * again — or rules it absent, so nothing is outstanding and the partition
 * completes.
 *
 * A report that cannot be delivered is logged and dropped rather than thrown.
 * Nothing is lost by it: an unreported download comes round in the next listing,
 * where hauler finds the file already on disk, verifies it and reports it then.
 */
export const report = async (venue: string, done: Report): Promise<void> => {
  if (done.downloaded.length === 0 && done.failed.length === 0 && done.mismatched.length === 0)
    return;

  try {
    await ask(`/venues/${encodeURIComponent(venue)}/report`, {
      method: 'POST',
      body:   JSON.stringify(done),
    });
  } catch (err) {
    logger.warn({ err, venue, ...counts(done) },
      'Could not report a finished page — it will come round again');
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * URLs asked for per listing request. Not a deployment knob: it trades off
 * request count against page size, and nothing about a deployment changes that
 * trade-off — only the catalog's own paging limit would.
 */
const PAGE_SIZE = 1_000;

/**
 * **One month at a time, always.** The listing is bounded by a month because the
 * partition is, and because narrowing to one is what lets the catalog answer
 * from an index rather than a scan.
 *
 * **A plan is the query.** Every field of it is one of the catalog's own filters,
 * so nothing is translated on the way out — and a plan narrowed to one variant,
 * one grain or the venue-wide file is narrowed by the catalog rather than by
 * hauler discarding most of what it was sent.
 */
const listing = (plan: Plan, month: string, after?: string, limit?: number): string => {
  const query = new URLSearchParams({
    market:  plan.market,
    dataset: plan.dataset,
    grain:   plan.grain,
    month,
    limit:   String(limit ?? PAGE_SIZE),
  });

  if (plan.variant) query.set('variant', plan.variant);

  /** `@` is the catalog's name for the file carrying every instrument at once. */
  if (plan.buckets) query.set('symbol', '@');

  if (after) query.set('after', after);

  return query.toString();
};

/**
 * One listed file, as JSON carries it.
 *
 * **`null` and absent are the same thing here and not in JSON.** The catalog has
 * columns, so a file whose venue published no size says so with a null; hauler
 * has optional fields, and a null reaching one would compare unequal to every
 * real size and condemn a perfectly good file as mismatched. The seam is where
 * that is reconciled, once.
 */
interface Wire extends Omit<Offered, 'venue' | 'size' | 'etag'> {
  size: number | null;
  etag: string | null;
}

const received = ({ size, etag, ...rest }: Wire, venue: string): Offered => ({
  ...rest,
  venue,
  ...(size === null ? {} : { size }),
  ...(etag === null ? {} : { etag }),
});

const ask = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const res = await fetch(`${config.catalogUrl}${path}`, {
    ...init,
    headers: {
      /** The catalog's own header, not a bearer scheme — see prospector's api/. */
      'x-catalog-token': config.catalogToken,
      'content-type':    'application/json',
      ...init.headers,
    },
  });

  if (! res.ok)
    throw new Error(`Catalog answered ${res.status} for ${path}`);

  return await res.json() as T;
};

const counts = (done: Report): Record<string, number> => ({
  downloaded: done.downloaded.length,
  failed:     done.failed.length,
  mismatched: done.mismatched.length,
});
