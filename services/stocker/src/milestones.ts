import { join } from 'node:path';
import { logger } from '@devvir/service-kit';
import { FactManager } from '@tradebot/pipeline';
import config from './config';
import { endOfMonth } from './dates';

/**
 * How far each collector has finished, read from the raw tree.
 *
 * A directory of files says which periods arrived, never whether more are
 * coming, and that difference decides whether a month is safe to normalise.
 * Only the collector knows, and it publishes exactly one fact per venue: the
 * month it is collected **through**.
 *
 *     topic=archives  venue=gate  period=201802  fact=complete
 *
 * It arrives through the shared facts store under the `@shared` mount rather
 * than from inside trucker's own directory, so the boundary is a mount rather
 * than a convention: stocker never opens anything trucker keeps for itself.
 *
 * That is the whole contract, and stocker deliberately reads nothing else.
 * Trucker's other ledgers — per-symbol cursors, coverage, the inventory —
 * answer "where is this symbol up to", whose answer changes for ever because an
 * active symbol always has more coming. Consuming them meant mapping every raw
 * path back to trucker's own dataset vocabulary, asking per symbol, and knowing
 * which symbols had delisted: all of it reconstructing a fact the collector can
 * simply state.
 *
 * Read once per sweep and held in memory. Building from a month that is still
 * filling is not wrong — the partition is rebuilt when the rest lands — but it
 * is work done several times over, and it is the thing that makes reclaiming
 * raw safe to do without thinking.
 */

export interface Milestones {
  /** Whether a venue has published a tip at all — an absent file blocks it. */
  covers(venue: string): boolean;

  /**
   * When the collector last closed the month a `yyyy-mm` names, or null if it
   * never has.
   *
   * Recorded against every partition built from that month. A month can reopen —
   * a symbol universe found to have been incomplete, a dataset added, a naming
   * shape discovered — and when it does the collector closes it again with a new
   * time. A partition whose stored time no longer matches was built from a month
   * that has since changed, so it rebuilds itself, without anyone having to
   * remember which partitions came from where.
   */
  closedAt(venue: string, month: string): string | null;

  /**
   * Whether the collector's unbroken run of finished months reaches `through`
   * (`yyyymmdd`). The caller owns what that date must be — a month's end for a
   * UTC-aligned series, one bucket past it for a spilling one — so the ledger
   * stays a fact lookup.
   */
  ready(venue: string, through: string): boolean;
}

export const load = async (): Promise<Milestones> => {
  const tips   = new Map<string, string>();
  const closed = new Map<string, string>();
  const months = new Map<string, string[]>();

  /**
   * Read as `stocker`, which owns nothing here and needs to own nothing. The
   * `archives` topic is trucker's to write and everyone's to read — a consumer
   * needs no permission to find out where a producer has got to.
   */
  const facts = new FactManager({ owner: 'stocker', root: join(config.sharedDir, 'facts') });

  try {
    for (const month of facts.find({ topic: 'archives', fact: 'complete' })) {
      if (! /^\d{6}$/.test(month.period)) continue;

      months.set(month.venue, [...months.get(month.venue) ?? [], month.period]);

      closed.set(`${month.venue}|${dashed(month.period)}`, month.value);
    }
  } finally {
    facts.close();
  }

  if (months.size === 0)
    logger.warn({ root: join(config.sharedDir, 'facts') },
      'No completion tips from the collectors — nothing will be built until they appear');

  for (const [venue, closedMonths] of months) tips.set(venue, covered(closedMonths));

  logger.info({ through: Object.fromEntries(tips) }, 'Collector tips loaded');

  return {
    covers: (venue) => tips.has(venue),

    closedAt: (venue, month) => closed.get(`${venue}|${month}`) ?? null,

    /**
     * The tip names a month; the caller asks about a day. A month is collected
     * through its last day, so the comparison is against the tip's end — which
     * is what lets a back-spilling series ask for one day past its own month
     * and correctly wait for the next month to close.
     *
     * **Raw below the earliest month a collector closed is not covered by this**
     * — nothing has vouched for it — but it passes here all the same, because
     * the comparison has only a ceiling. bybit's earliest closed month is
     * 202001 and 36 partitions were built from files sitting in 2019.
     */
    ready: (venue, through) => {
      const tip = tips.get(venue);

      return tip !== undefined && endOfMonth(tip) >= through;
    },
  };
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** A `yyyymm` as stocker writes it. */
const dashed = (month: string): string => `${month.slice(0, 4)}-${month.slice(4, 6)}`;

/**
 * The **unbroken run** of closed months, as stocker's `yyyy-mm`.
 *
 * A collector closes a month when it finishes it, and a month that failed
 * mid-walk is left open while the ones after it go on closing. So the months a
 * venue has closed are not necessarily a range, and the highest of them is not a
 * claim about everything below it — which is exactly how it was read, and how
 * bybit's open 202402 and 202405 came to be built from underneath a tip of
 * 202501.
 *
 * Taking the run rather than the maximum makes everything up to the answer a
 * month the collector has actually finished.
 */
const covered = (closed: string[]): string => {
  const sorted = [...new Set(closed)].sort();

  let through = sorted[0]!;

  for (const month of sorted.slice(1)) {
    if (month !== monthAfter(through)) break;

    through = month;
  }

  return dashed(through);
};

/** The month after a `yyyymm`, in the same form. */
const monthAfter = (month: string): string => {
  const year  = Number(month.slice(0, 4));
  const index = Number(month.slice(4, 6));

  return index === 12 ? `${year + 1}01` : `${month.slice(0, 4)}${String(index + 1).padStart(2, '0')}`;
};
