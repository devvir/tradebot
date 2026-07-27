import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import config from './config';
import { endOfMonth, prevMonth } from './dates';

/**
 * The one thing trucker tells the outside world: the month a venue is collected
 * **through**, and when that was settled.
 *
 *     201802\t2026-08-03T14:22:10.004Z
 *
 * It lives in `@shared`, apart from trucker's own directory, so the split is a
 * mount rather than a convention: everything under `/data/trucker` is trucker
 * tracking its own progress and no consumer should read any of it. Those records
 * answer "where is this symbol up to", which is a question whose answer changes
 * for ever: an active symbol always has more coming. This one answers "which
 * months have stopped changing".
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
 * Same dull format as the ledgers beside it — tab-separated, append-only, later
 * lines superseding earlier ones, one file per venue. The **tip** is forward
 * only: a month, once closed, stays closed. Its timestamp is not.
 */

const DIR = () => join(config.sharedDir, 'complete');

const fileFor = (venue: string): string => join(DIR(), `${venue}.tsv`);

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

/** The month this venue is collected through, or null before any is closed. */
export const tip = async (venue: string): Promise<string | null> => {
  let latest: string | null = null;

  for (const month of (await closings(venue)).keys())
    if (! latest || month > latest) latest = month;

  return latest;
};

/** Later lines supersede earlier ones, so a re-closed month carries its newest time. */
export const load = async (venue: string): Promise<Map<string, string>> => {
  const raw    = await readFile(fileFor(venue), 'utf8').catch(() => '');
  const closed = new Map<string, string>();

  for (const line of raw.split('\n')) {
    const parts = line.split('\t');

    if (parts.length !== 2) continue;

    const month = parts[0]!.trim();

    if (! /^\d{6}$/.test(month)) continue;

    closed.set(month, parts[1]!.trim());
  }

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
  const closed  = await closings(venue);
  const current = await tip(venue);
  const path    = fileFor(venue);

  // One timestamp, written and remembered. Two calls to `now` differ by a
  // millisecond, and a consumer comparing what it read against what this
  // process holds would see a month reopen that never did.
  const at = new Date().toISOString();

  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${month}\t${at}\n`);

  closed.set(month, at);

  return ! current || month > current;
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
export const _test_reset = (): void => memo.clear();
