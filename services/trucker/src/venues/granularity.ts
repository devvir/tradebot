import { endOfMonth } from '../dates';
import type { ArchiveFile } from '../types';

/**
 * One fixed cutover decides granularity wherever a venue publishes a period
 * twice — once as a month, once as that month's days.
 *
 * Up to and including June 2026 the month is taken; from 1 July 2026 onward the
 * days are. Both sides of the boundary are settled history and neither moves, so
 * the two sets meet exactly and no date is ever covered twice.
 *
 * The rejected alternative was deciding per sweep which months count as
 * "closed", which makes the answer depend on when trucker runs — precisely how
 * the same day ends up fetched at two granularities.
 */
export const MONTHLY_THROUGH = '202606';
export const DAILY_FROM      = '20260701';

/**
 * Apply the cutover to a venue listing.
 *
 * **Which shapes exist is read from the listing, never declared.** A series that
 * publishes only days keeps all of them (Bybit's perp trades go back to 2020 as
 * days and nothing else; so do Binance `metrics` and `bookDepth`). A series that
 * publishes only months keeps all of those (Binance `fundingRate` has no daily
 * form at all, so a blanket date rule would lose every month after the cutover).
 * Only when both are present does the boundary decide between them.
 *
 * Deriving it means the rule cannot drift away from what a venue actually
 * publishes, and adding a series needs no claim about its granularity.
 *
 * Monthly files are re-keyed to the last day of their month, so every period is
 * a `yyyymmdd` the cursor compares directly whatever span it covers.
 */
export const atCutover = (files: readonly ArchiveFile[]): ArchiveFile[] => {
  const hasMonthly = files.some(f => f.period === 'monthly');
  const hasDaily   = files.some(f => f.period === 'daily');
  const both       = hasMonthly && hasDaily;

  return files
    .filter(f => (! both || (f.period === 'monthly'
      ? f.date.slice(0, 6) <= MONTHLY_THROUGH
      : f.date >= DAILY_FROM)))
    .map(f => (f.period === 'monthly' ? { ...f, date: endOfMonth(f.date.slice(0, 6)) } : f))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
};
