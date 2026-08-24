import { logger } from '@devvir/service-kit';
import { isComplete, pending, report } from './catalog';
import { complete, completedAt } from './facts';
import { haul } from './fetch';
import { nameOf, partitionOf } from './naming';
import config from './config';
import type { Offered, Outcome, Partition, Plan, Report } from './types';

/**
 * One venue's worker: everything it wants, oldest month first.
 *
 * ```
 * venue ─┬─ month ─┬─ dataset ─┬─ url page ─┬─ fetch
 *        │         │           │            ├─ fetch
 *        │         │           │            └─ fetch  (concurrent)
 *        │         │           └─ next page…
 *        │         └─ next dataset…
 *        └─ next month…
 * ```
 *
 * **The order is the point, not an implementation detail.** The unit that
 * matters downstream is a `dataset + month` partition, and a partition is only
 * useful once it is *complete* — stocker cannot import half a month.
 * Interleaving datasets or periods would leave many partitions in progress and
 * none finished, which is the slowest possible route to the first usable thing.
 *
 * **Venues share nothing and never wait on each other.** They are unrelated
 * hosts with unrelated limits, so each of these runs on its own.
 */
export const haulVenue = async (
  venue:   string,
  plans:   readonly Plan[],
  stopped: () => boolean,
): Promise<void> => {
  const mine = plans.filter(plan => plan.venue === venue);

  if (mine.length === 0) return;

  for (const month of months(mine)) {
    if (stopped()) return;

    for (const plan of mine) {
      if (stopped()) return;

      // A plan only covers the months its want asked for.
      if (plan.from && month < plan.from) continue;

      if (plan.to && month > plan.to) continue;

      await partition(plan, month, stopped);
    }
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Work one `dataset + month` to the end, then decide whether it finished.
 *
 * **Completion is not hauler deciding it has waited long enough.** It is the two
 * services agreeing: either every file arrived, or the catalog withdrew the
 * claim that it was there. A partition still holding a key that never delivers
 * simply never completes — and a loop that visibly refuses to finish is a far
 * better signal than a partition quietly marked done with a hole in it.
 */
const partition = async (
  plan:    Plan,
  month:   string,
  stopped: () => boolean,
): Promise<void> => {
  if (cooling(plan, month)) return;

  let cursor: string | null | undefined;
  let seen     = 0;
  let disputed = false;

  /**
   * **One listing can still be several partitions.** A plan names one shape, but
   * a shape holding both a venue-wide file and per-instrument ones yields files
   * of each, and binance's liquidation tree holds perpetuals beside dated
   * contracts. So what completes is whatever was actually named, not what was
   * asked for.
   */
  const touched = new Map<string, Partition>();

  do {
    if (stopped()) return;

    const page = await pending(plan, month, cursor ?? undefined);

    if (page.items.length === 0) break;

    const { done, partitions } = await workPage(page.items);

    await report(plan.venue, done);

    for (const one of partitions) touched.set(labelOf(one), one);

    seen     += page.items.length;
    disputed = disputed || done.mismatched.length > 0 || done.failed.length > 0;
    cursor   = page.next;
  } while (cursor);

  if (disputed) {
    /**
     * **Set it aside and spend the time on other partitions.** Prospector may
     * need to go and ask the venue before it can act on what was reported, so
     * the next listing can legitimately arrive carrying the same claim that was
     * just disputed. Nothing is lost by that and the loop converges as soon as
     * the catalog has done its work — the only real failure mode here is
     * impatience.
     */
    setAside(plan, month);

    logger.info({ venue: plan.venue, month, market: plan.market, dataset: plan.dataset },
      'Partition left open — the catalog and the disk disagree about at least one file');

    return;
  }

  if (! await isComplete(plan, month)) return;

  for (const one of touched.values()) close(one, seen);
};

/**
 * Fetch a page's worth of URLs at once and collect what became of each.
 *
 * Concurrency is bounded per venue rather than globally: a slow venue holding a
 * hundred sockets open must not starve a fast one.
 */
const workPage = async (
  items: readonly Offered[],
): Promise<{ done: Report; partitions: Partition[] }> => {
  const done: Report = { downloaded: [], failed: [], mismatched: [] };
  const queue        = [...items];
  const partitions   = new Map<string, Partition>();

  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const file = next;

      /**
       * **A file nothing can name is left where it is.** Naming refuses rather
       * than inventing a directory — a canonical value hauler does not know, or
       * a file the catalog could not place in a series — and a refusal is a gap
       * between the two services, not a fault of the venue's and not something
       * to report as a failed download.
       */
      let outcome: Outcome;

      try {
        const named = nameOf(file);

        partitions.set(labelOf(partitionOf(named)), partitionOf(named));

        outcome = await haul(file, named);
      } catch (err) {
        logger.error({ err, venue: file.venue, market: file.market, dataset: file.dataset },
          'Cannot name this file — skipping it');

        continue;
      }

      record(done, file, outcome);
    }
  };

  await Promise.all(Array.from({ length: config.concurrency }, worker));

  return { done, partitions: [...partitions.values()] };
};

const record = (done: Report, file: Offered, outcome: Outcome): void => {
  if (outcome === 'downloaded' || outcome === 'present') done.downloaded.push(file.key);
  else if (outcome === 'failed') done.failed.push(file.key);
  else done.mismatched.push({ key: file.key, size: file.size, etag: file.etag });
};

/**
 * State that a partition is finished, once.
 *
 * **The one fact hauler publishes**, because everything else is already in the
 * catalog — which files were downloaded, when, their sizes and etags. Copying
 * that here would be a second copy of a live table, free to disagree with it.
 * What is *not* derivable is when hauler considered a partition finished, and
 * that single timestamp is a version: stocker records the one it built against,
 * and a newer one means the partition was reopened and its own output is stale.
 * One value to compare, instead of two lists.
 */
const close = (partition: Partition, seen: number): void => {
  if (completedAt(partition)) return;

  complete(partition);

  logger.info({ ...partition, files: seen }, 'Partition complete');
};

/**
 * The months a shopping list spans, oldest first.
 *
 * A want with no lower bound starts wherever the catalog's earliest holdings
 * are, which is the venue's business rather than hauler's — so it is left to the
 * listing, and only bounded wants contribute months to walk here.
 */
const months = (plans: readonly Plan[]): string[] => {
  const bounds = plans.map(plan => plan.from)
    .filter((one): one is string => Boolean(one)).sort();

  const span: string[] = [];

  /**
   * **A want with no bound starts where the venue's archive does**, which is the
   * catalog's business rather than hauler's — so the walk starts at the earliest
   * bound anybody named, and an unbounded want simply finds nothing before its
   * venue began publishing.
   */
  for (let at = bounds[0] ?? EARLIEST; at <= thisMonth(); at = nextMonth(at)) span.push(at);

  return span;
};

/**
 * Before any of these venues published anything.
 *
 * Binance's archive starts in 2017 and every other venue here is younger, so a
 * walk from here reaches all of them. Months before a venue's own beginning cost
 * one listing each and answer nothing.
 */
const EARLIEST = '201701';

/**
 * How long a partition that reported a discrepancy is left alone before it is
 * asked for again — see the note on `cooling` below. Not a deployment knob: it
 * trades off against nothing a deployment would know to tune, only against how
 * long prospector typically takes to re-probe a venue.
 */
const COOL_OFF_MS = 5 * 60_000;

/** Partitions asked to wait, and until when. */
const asideUntil = new Map<string, number>();

const setAside = (plan: Plan, month: string): void => {
  asideUntil.set(keyOf(plan, month), Date.now() + COOL_OFF_MS);
};

/**
 * Whether a partition is still cooling off.
 *
 * **There is deliberately no counter here.** The tempting rule — "the catalog
 * said the same thing five times, so give up" — is wrong twice over: how many
 * repetitions occur depends on how fast prospector probes and how often hauler
 * asks, neither of which means anything, and it converts a recoverable
 * disagreement into a permanent one at an arbitrary threshold.
 */
const cooling = (plan: Plan, month: string): boolean => {
  const key   = keyOf(plan, month);
  const until = asideUntil.get(key);

  if (until === undefined) return false;

  if (Date.now() < until) return true;

  asideUntil.delete(key);

  return false;
};

const labelOf = (partition: Partition): string =>
  `${partition.venue}|${partition.market}|${partition.dataset}|${partition.month}`;

const keyOf = (plan: Plan, month: string): string =>
  `${plan.venue}|${plan.market}|${plan.dataset}|${plan.variant}|${plan.grain}|${month}`;

const thisMonth = (): string => new Date().toISOString().slice(0, 7).replace('-', '');

const nextMonth = (month: string): string => {
  const year = Number(month.slice(0, 4));
  const at   = Number(month.slice(4, 6));

  return at === 12 ? `${year + 1}01` : `${year}${String(at + 1).padStart(2, '0')}`;
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_months    = months;
export const _test_nextMonth = nextMonth;
export const _test_record    = record;
