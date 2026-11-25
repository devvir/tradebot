import type { Order, Status } from '../types';

/**
 * Orders given to venues — go or pause — and when the status prospector reports
 * shows one done, or long enough not done that it has lapsed.
 */

/** How often the table is read, and how often while an order is owed an answer. */
export const POLL_MS       = 10_000;
export const ORDER_POLL_MS = 2_000;

/**
 * How long an order is held before it is let go of and said to have lapsed.
 *
 * Prospector reports `starting` from a pass's first second, however long its
 * preamble, so an order still unconfirmed after this is one prospector never
 * began.
 */
export const ORDER_MS = 2 * 60_000;

/** States in which a venue is already going, so asking it to go means nothing. */
export const GOING: ReadonlySet<string> = new Set(['starting', 'walking', 'updating']);

/**
 * Whether the status shows an order done.
 *
 * **A pass that began after the order counts**, not only one still running: a
 * small venue can open and close a whole update between two polls, and waiting
 * for a state it has already left would hold the row until the order lapsed.
 *
 * **Told by the pass's start changing, not by when it began.** Both starts are
 * prospector's own report, so whatever this browser's clock says never enters
 * into it.
 */
export const tookEffect = (order: Order, now: Status): boolean => {
  if (order.kind === 'pause') return now.state === 'paused' || now.state === 'not started';

  if (GOING.has(now.state)) return true;

  /**
   * **A pause lifted is done once the venue has left `paused`.** One paused
   * while waiting goes back to waiting — nothing starts, so waiting for a pass
   * would hold the row until the order lapsed and then report it as ignored.
   */
  if (order.from === 'paused' && now.state !== 'paused' && ! now.stopping) return true;

  return now.lastRun.startedAt !== null && now.lastRun.startedAt !== order.fromStartedAt;
};

/** The orders less those for the given venues; the orders themselves are left as they were. */
export const without = (had: Record<string, Order>, venues: readonly string[]): Record<string, Order> =>
  Object.fromEntries(Object.entries(had).filter(([venue]) => ! venues.includes(venue)));
