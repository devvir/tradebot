import { join } from 'node:path';
import { FactManager } from '@tradebot/pipeline';
import config from './config';
import { endOfMonth, nextMonth, prevMonth } from './dates';

/**
 * The one thing trucker tells the outside world: the month a venue is collected
 * **through**, and when that was settled.
 *
 *     topic=archives  venue=gate  period=201802  fact=complete
 *     value=2026-08-03T14:22:10.004Z
 *
 * It lives in the shared facts store under `@shared`, apart from trucker's own
 * directory, so the split is a mount rather than a convention: everything under
 * `/data/trucker` is trucker tracking its own progress and no consumer should
 * read any of it. Those records answer "where is this symbol up to", which is a
 * question whose answer changes for ever: an active symbol always has more
 * coming. This one answers "which months have stopped changing".
 *
 * A month is published only when every dataset of the venue finished it with no
 * failures, and only once it is old enough that a late publication cannot still
 * appear. So a consumer needs no notion of symbols, delistings, listing dates or
 * collection order:
 *
 *     is this month ≤ the tip?  →  it is complete.
 *
 * ## Why the timestamp is part of the contract
 *
 * "Complete" is a claim about a symbol universe, a dataset list and a filename
 * shape — and each of those has turned out to be wrong at least once. Bitget's
 * archive reached six years further back than its URLs suggested; its delisted
 * symbols are absent from every version of its instruments API; a whole
 * USDC-margined market was missing. Every such discovery makes months that were
 * honestly closed no longer complete.
 *
 * Trucker does not go looking for that — re-walking closed months on the chance
 * something changed would cost more than it could ever find. The trigger is a
 * person clearing this venue's ledgers, because the reasons are known when they
 * happen. What the ledger guarantees is that the repair **propagates**: a month
 * walked again is closed again, with a new timestamp.
 *
 * A consumer that records the timestamp it acted on can then fix itself. A month
 * whose closing time has moved is a month whose contents may have moved, so it
 * rebuilds — without a human reading a warning, remembering which partitions
 * came from it, or deleting anything downstream by hand.
 *
 * **One fact per venue-month**, so closing a month again replaces its time
 * rather than appending beside it, and the key does the work an append-only file
 * needed a "later line wins" rule for. A month, once closed, stays closed; its
 * timestamp does not.
 */

/**
 * The store, opened once and kept.
 *
 * Trucker owns the `archives` topic, which is what lets it write at all — the
 * ownership check is made against this name rather than against the call site,
 * so a service cannot state facts about a tree it does not fill.
 */
let store: FactManager | null = null;

const facts = (): FactManager =>
  (store ??= new FactManager({ owner: 'trucker', root: join(config.sharedDir, 'facts') }));

/** One in-memory copy per venue; trucker is the only writer. */
const memo = new Map<string, Promise<Map<string, string>>>();

/** Every month closed for this venue, and when each was last closed. */
export const closings = (venue: string): Promise<Map<string, string>> => {
  const held = memo.get(venue);

  if (held) return held;

  const loading = load(venue);

  memo.set(venue, loading);

  return loading;
};

/**
 * The month this venue is collected **through**, or null before any is closed.
 *
 * **The frontier, not the maximum.** The contract is "everything up to here is
 * complete", so it can only reach as far as the first month that is not — a run
 * of closed months broken by an open one ends there, however many closed months
 * sit above the break.
 *
 * The maximum is not that claim and cannot stand in for it. A month left open
 * by a failed pass is stepped over by the months that close after it, and the
 * maximum then names a month with a hole beneath it — which every consumer
 * reads as `month <= tip → complete` and acts on. bybit's 202402 and 202405
 * each failed mid-walk and were passed by; the tip read 202501, and stocker
 * built 2,091 partitions from two months that were never finished.
 *
 * So the break holds the tip back until the hole is filled, which is what
 * [`pending`](sync.ts) now goes back for. Closing the missing month releases
 * every closed month above it at once.
 */
export const tip = async (venue: string): Promise<string | null> => {
  const months = [...(await closings(venue)).keys()].sort();

  if (months.length === 0) return null;

  let frontier = months[0]!;

  for (const month of months.slice(1)) {
    if (month !== nextMonth(frontier)) break;

    frontier = month;
  }

  return frontier;
};

/**
 * Every month closed for a venue, with the time each was last closed.
 *
 * One fact per venue-month, so re-closing replaces the time in place rather than
 * appending beside it — the "later line wins" rule the flat file needed is the
 * key doing its job.
 */
export const load = async (venue: string): Promise<Map<string, string>> => {
  const closed = new Map<string, string>();

  for (const month of facts().find({ topic: 'archives', venue, fact: 'complete' }))
    if (/^\d{6}$/.test(month.period)) closed.set(month.period, month.value);

  return closed;
};

/**
 * Publish that the venue is complete through `month`.
 *
 * Written whenever a month finishes a clean pass, including one that has been
 * closed before — that is the case the timestamp exists for. Re-closing is not
 * free bookkeeping: it is how a repair reaches everything downstream, so it must
 * leave a mark even though the tip does not move.
 *
 * Returns whether the tip advanced, which is what a log line wants to say.
 */
export const publish = async (venue: string, month: string): Promise<boolean> => {
  const closed = await closings(venue);
  const before = await tip(venue);

  // One timestamp, written and remembered. Two calls to `now` differ by a
  // millisecond, and a consumer comparing what it read against what this
  // process holds would see a month reopen that never did.
  const at = new Date().toISOString();

  facts().record({ topic: 'archives', venue, period: month, fact: 'complete', value: at });

  closed.set(month, at);

  /**
   * Compared after the fact rather than against the month just closed, because
   * the frontier can move further than the month that moved it: filling a hole
   * releases every closed month stacked above it in one step.
   */
  const after = await tip(venue);

  return !! after && (! before || after > before);
};

/**
 * Seed the tip for an archive collected before this ledger existed, from a date
 * the venue is known to have been walked through.
 *
 * Without it the first month-major pass would walk nine years of history that
 * is already on disk — every file `skipped` on a `stat`, but every listing paid
 * for again. With it, collection resumes at the first month that was never
 * finished.
 *
 * Only whole months count: a venue walked through the 18th is not complete for
 * that month, so the tip lands on the one before it. Returns the month seeded,
 * or null when there was nothing to seed or a tip already stands.
 */
export const seed = async (venue: string, through: string): Promise<string | null> => {
  if (await tip(venue)) return null;

  const month = whole(through);

  if (! month) return null;

  return await publish(venue, month) ? month : null;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** The latest month that ends on or before `day`. */
const whole = (day: string): string | null => {
  if (! /^\d{8}$/.test(day)) return null;

  const month = day.slice(0, 6);

  return endOfMonth(month) <= day ? month : prevMonth(month);
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_whole = whole;

/**
 * Forget both the cached months and the store they came from.
 *
 * The store holds an open handle on a directory the config names, and a test
 * that moves the config to a fresh temporary directory would otherwise go on
 * reading and writing the previous one.
 */
export const _test_reset = (): void => {
  memo.clear();
  store?.close();
  store = null;
};
