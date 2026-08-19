import { logger } from '@devvir/service-kit';
import { keyFor, putFiles } from './catalog';
import { WIDTH, lastSettled, prevPeriod } from './dates';
import { etagOf, fetchHead } from './http';
import { labelOf } from './pace';
import type { Adapter, CatalogFile, Publishing } from './types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Where a series the catalog has never read should start being asked about.
 *
 * **A new series has no tip, and inventing one is a claim.** Saying "everything
 * below `OVERDUE_DAYS` ago is settled" is true of a series we have been
 * generating for — we asked, and nothing came — and false of one discovered this
 * morning, which nobody has asked about at all. This is what earns it: probe the
 * floor, and keep stepping down for as long as the venue keeps answering.
 *
 * **In the ordinary case it costs one request.** An instrument listed since the
 * last pass has nothing below the floor, the first probe is absent, and the tip
 * is the floor — exactly where a flat rule would have put it, with the
 * difference that it was measured.
 *
 * **Where it is not ordinary, it is the only thing that recovers the archive.**
 * A symbol a seed missed, or one relisted after a gap, has history below the
 * floor that nothing else will ever reach: generation never looks under a tip,
 * and okx and bitget have no index to walk. Each period found is settled on the
 * spot — a HEAD carries size, checksum and last-modified, which is the whole of
 * what a file row needs — so the walk pays for itself rather than leaving keys
 * for generation to ask about again.
 *
 * **The tip is the floor either way.** Everything at or below it is settled by
 * the time this returns: the periods walked through by having been recorded, and
 * the one under them by having been answered absent. What the walk changes is
 * what is in `file`, and therefore what reconciliation reads a `first` from.
 */
export const backfill = async (
  db:      DatabaseSync,
  adapter: Adapter,
  series:  Publishing,

  /**
   * The moment the pass covered up to — the newest tip the venue held before
   * this preamble touched anything.
   *
   * **Not the clock.** A pass that has not run for three weeks covered up to
   * three weeks ago, and a series discovered now should start where that pass
   * stopped rather than where today is; otherwise the days nobody looked at fall
   * between the two and are never asked for.
   */
  covered: Date,

  /**
   * How far down the walk may go: the oldest date this venue has ever published
   * anything at.
   *
   * **A bound on being wrong, not on being right.** Nothing published before the
   * venue's own archive begins, so a walk that reaches it has stopped measuring
   * and started running away — which is what a soft `200` looks like, an error
   * page served with the wrong status. Reaching it is a fault to be seen rather
   * than a limit to be respected.
   */
  oldest:  string,
): Promise<{ tip: string; found: number; walked: number }> => {
  const floor = lastSettled(series.grain, covered);
  const found: CatalogFile[] = [];
  const months = new Set<string>();

  let at = floor;

  for (;;) {
    const seen = await fetchHead(adapter, url(adapter, series, at));

    if (seen.status !== 200) break;

    found.push(recorded(series, at, seen.headers));

    /**
     * **Only what is genuinely below the floor.** The floor is where probing was
     * always going to start, so a file there is the expected case and says
     * nothing — a walk that reported it would warn about every series it ever
     * touched. What is worth a line is history *under* it, which is the thing
     * nobody expected to find.
     *
     * **Counted in calendar months at any grain**, because that is the unit
     * somebody reads a log in: an instrument expected to start publishing
     * tomorrow that turns out to have half a year behind it is worth looking at,
     * and a line per day would bury the one line that says so.
     */
    if (at < floor) {
      const month = at.slice(0, 6);

      if (! months.has(month)) {
        months.add(month);

        logger.warn({
          venue: labelOf(adapter), market: series.market, symbol: series.symbol,
          dataset: series.dataset, reached: at, floor, monthsBack: months.size,
        }, 'A newly listed instrument has data below where probing starts — '
         + 'walking back to find where it begins');
      }
    }

    at = prevPeriod(at, series.grain);

    if (at.slice(0, WIDTH[series.grain]) <= oldest.slice(0, WIDTH[series.grain])) {
      logger.error({ venue: labelOf(adapter), market: series.market, symbol: series.symbol, oldest },
        'Walked back to the oldest date this venue publishes and the venue is still answering — '
        + 'treating that as an answer that cannot be believed, and stopping');

      break;
    }
  }

  if (found.length > 0) await putFiles(db, found);

  return { tip: floor, found: found.length, walked: months.size };
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** A URL is built from what the catalog stores, exactly as generation builds it. */
const url = (adapter: Adapter, series: Publishing, at: string): string =>
  `${adapter.base}/${adapter.root}${keyFor(series, at)}`;

/**
 * One period the venue answered for, as a complete file row.
 *
 * **A HEAD is a settlement.** It carries size, checksum and last-modified, which
 * is everything `file` holds about a file — so a period found here is catalogued
 * rather than parked for a probe to ask about all over again.
 */
const recorded = (series: Publishing, at: string, headers: Headers): CatalogFile => {
  // A header that is not there is unknown, not zero, and `Number(null)` is 0 —
  // which would record every answer as an empty file.
  const length   = headers.get('content-length');
  const size     = length === null ? Number.NaN : Number(length);
  const modified = Date.parse(headers.get('last-modified') ?? '');

  return {
    venueId:  series.venueId,
    path:     keyFor(series, at),
    date:     at,
    size:     Number.isFinite(size) ? size : null,
    etag:     etagOf(headers.get('etag')),
    modified: Number.isNaN(modified) ? null : new Date(modified).toISOString(),
    seriesId: series.id!,
    existence: 'confirmed',
    seenAt:   new Date().toISOString(),
  };
};
