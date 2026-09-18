import { addCounts, venueIdOf } from './catalog';
import type { DatabaseSync } from 'node:sqlite';
import type { Adapter, Counts } from './types';

/**
 * What each host has been asked for and what that actually cost, per job.
 *
 * **Two counts, because only one of them is a property of this service.**
 * `asked` is the work: one per key a probe confirms, one per listing page a walk
 * reads, whatever happens next. `sent` is what went down the wire for it, so a
 * link that drops, a venue that 5xxs and every retry behind them lands there and
 * nowhere else. Comparing a venue's walk against its update needs the first;
 * knowing what a pass cost the venue on the day needs the second, and a single
 * number would be neither.
 *
 * **Counted where they leave, written where the job is.** `send` is the one
 * place every request passes and it has no catalog to hand; the passes have the
 * catalog and never see a request. So both are held here per adapter — a host,
 * since bybit's two are separate rows — and a pass writes them out onto whatever
 * job that host has open.
 *
 * **A count with no job open waits for one.** Mapping an archive is sent before
 * the walk it plans has a row, and it belongs to that walk; held until the job
 * exists, it lands there. Nothing is dropped for having arrived early.
 *
 * **What an instrument listing costs is not here.** Those go through `metadata`
 * rather than through `send`, against an API rather than the archive, and they
 * are a handful of requests a pass — see `fetchJson`.
 */

/** One more request this venue's pass needs, whatever it takes to get an answer. */
export const countAsked = (adapter: Adapter): void => {
  const had = counted(adapter);

  had.asked++;
};

/** One more request actually on the wire, retries included. */
export const countSent = (adapter: Adapter): void => {
  const had = counted(adapter);

  had.sent++;
};

/**
 * Write out what has been counted, for one adapter or for all of them.
 *
 * Answers how many requests were written. Whatever found no open job stays
 * counted and goes with the next flush that finds one.
 *
 * **Called where a run is already being written** — a page of a sweep, a batch
 * of probes, the end of a pass — so the write rides the cadence something else
 * already sets rather than adding one of its own.
 */
export const flushCounts = (db: DatabaseSync, only?: Adapter): number => {
  let written = 0;

  for (const [adapter, count] of pending) {
    if (only !== undefined && adapter !== only) continue;

    if (count.asked === 0 && count.sent === 0) continue;

    if (! addCounts(db, venueIdOf(db, adapter.name, adapter.host ?? ''), count.asked, count.sent))
      continue;

    written += count.sent;

    count.asked = 0;
    count.sent  = 0;
  }

  return written;
};

const counted = (adapter: Adapter): Counts => {
  const had = pending.get(adapter);

  if (had) return had;

  const made = { asked: 0, sent: 0 };

  pending.set(adapter, made);

  return made;
};

const pending = new Map<Adapter, Counts>();

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_pending = pending;
