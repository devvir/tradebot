import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@devvir/service-kit';
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
 *     <shared>/complete/gate.tsv
 *     201802\t2026-08-03T14:22:10.004Z
 *
 * It arrives through the `@shared` mount rather than from inside trucker's
 * own directory, so the boundary is a mount rather than a convention: stocker
 * never opens anything trucker keeps for itself.
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

const DIR = () => join(config.sharedDir, 'complete');

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
   * Whether the venue is collected through `through` (`yyyymmdd`). The caller
   * owns what that date must be — a month's end for a UTC-aligned series, one
   * bucket past it for a spilling one — so the ledger stays a fact lookup.
   */
  ready(venue: string, through: string): boolean;
}

export const load = async (): Promise<Milestones> => {
  const tips   = new Map<string, string>();
  const closed = new Map<string, string>();
  const files  = await readdir(DIR()).catch(() => null);

  if (files === null)
    logger.warn({ dir: DIR() },
      'No completion tips from the collectors — nothing will be built until they appear');

  for (const file of files ?? []) {
    if (! file.endsWith('.tsv')) continue;

    const venue = file.replace(/\.tsv$/, '');
    const raw   = await readFile(join(DIR(), file), 'utf8').catch(() => '');
    const tip   = newest(raw);

    if (tip) tips.set(venue, tip);

    // Later lines supersede earlier ones, so the last time a month was closed
    // is the one that counts.
    for (const [month, at] of times(raw)) closed.set(`${venue}|${month}`, at);
  }

  logger.info({ through: Object.fromEntries(tips) }, 'Collector tips loaded');

  return {
    covers: (venue) => tips.has(venue),

    closedAt: (venue, month) => closed.get(`${venue}|${month}`) ?? null,

    /**
     * The tip names a month; the caller asks about a day. A month is collected
     * through its last day, so the comparison is against the tip's end — which
     * is what lets a back-spilling series ask for one day past its own month
     * and correctly wait for the next month to close.
     */
    ready: (venue, through) => {
      const tip = tips.get(venue);

      return tip !== undefined && endOfMonth(tip) >= through;
    },
  };
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * The highest month in the file, as stocker's `yyyy-mm` rather than the `yyyymm`
 * trucker writes.
 *
 * Append-only with later lines superseding earlier ones, but taking the maximum
 * rather than the last line means a torn write cannot lower a tip a consumer has
 * already acted on.
 */
/**
 * Every month in the file with the time it was closed, as stocker's `yyyy-mm`.
 *
 * Later lines supersede earlier ones — a month closed a second time is written
 * again rather than edited — so the last time wins. That differs from `newest`
 * on purpose: a tip must never be lowered by a torn write, while a closing time
 * is only ever compared for equality.
 */
const times = (raw: string): [string, string][] => {
  const out: [string, string][] = [];

  for (const line of raw.split('\n')) {
    const [month, at] = line.split('\t');

    if (! month || ! at || ! /^\d{6}$/.test(month.trim())) continue;

    out.push([`${month.slice(0, 4)}-${month.slice(4, 6)}`, at.trim()]);
  }

  return out;
};

const newest = (raw: string): string | null => {
  let tip: string | null = null;

  for (const line of raw.split('\n')) {
    const month = line.split('\t')[0]?.trim();

    if (! month || ! /^\d{6}$/.test(month)) continue;
    if (! tip || month > tip) tip = month;
  }

  return tip && `${tip.slice(0, 4)}-${tip.slice(4, 6)}`;
};
