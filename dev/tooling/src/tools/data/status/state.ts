import { DayState } from '../scan/types';

/**
 * What "kind of day" we're rendering, relative to wall-clock time.
 *
 *   - `today`   — current UTC day. WS live collection expected.
 *   - `pending` — yesterday during the 1-hour grace window (00:00–00:59 UTC
 *                 of the next day). `data prepare` deliberately waits one
 *                 hour after midnight before finalising a day's bucket, in
 *                 case data arrives late (BitMEX hiccup, queue lag, crash
 *                 recovery, …). A `.tmp` for this day is *expected*, not stalled.
 *   - `past`    — any earlier day. A `.tmp` here is stalled / abnormal.
 */
export type DayKind = 'today' | 'pending' | 'past';

/**
 * Structured per-cell state. Pure data — no presentation strings or colors.
 * The display layer is the only place that decides labels and colors.
 */
export type CellState =
  | { kind: 'absent' }
  | { kind: 'progress' }       // today + a `.tmp` file is present (downloading)
  | { kind: 'pending' }        // yesterday during the 1-hour grace window + a `.tmp` file is present
  | { kind: 'incomplete' }     // past day + a `.tmp` file is present (stalled)
  | { kind: 'mixed' }          // both bucket and source files present locally
  | { kind: 'buckets' }
  | { kind: 'sources' }
  | { kind: 'stored' }
  | { kind: 'missing' };

/**
 * A maximal contiguous date range where every location's state is identical
 * across every real day inside. `isToday` is a separate flag — today is
 * always its own range (it carries live-collection semantics that never
 * merge with past days).
 */
export interface Range {
  startKey: string;            // YYYYMMDD, inclusive
  endKey:   string;            // YYYYMMDD, inclusive
  states:   CellState[];       // one per location (Local, remotes..., Mega)
  isToday:  boolean;
}

// ── Equality ─────────────────────────────────────────────────────────────────

/**
 * Structural comparison for two state tuples. Used to detect range breaks.
 *
 * Every kind is now distinguished by its `kind` alone — none carries fields —
 * so identity of kind is identity of state.
 */
export function statesEqual(a: CellState[], b: CellState[]): boolean {
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    if (a[i]!.kind !== b[i]!.kind) return false;
  }

  return true;
}

// ── Per-day state factories ──────────────────────────────────────────────────

export function localState(ds: DayState | undefined, dayKind: DayKind, isWs: boolean): CellState {
  const hasTmp  = !! ds && (ds.localBucketTmp || ds.localTmpSuffixes.length > 0);
  const hasBkt  = !! ds && ds.localBucket && ! ds.localBucketTmp;
  const hasSrcs = !! ds && ds.localSuffixes.length > 0;

  if (hasTmp)                          return tmpState(dayKind, isWs);
  if (hasBkt && hasSrcs)               return { kind: 'mixed' };
  if (hasBkt)                          return { kind: 'buckets' };
  if (hasSrcs)                         return { kind: 'sources' };
  if (dayKind === 'today' && isWs)     return { kind: 'missing' };

  return { kind: 'absent' };
}

export function remoteState(ds: DayState | undefined, remote: string, dayKind: DayKind, isWs: boolean): CellState {
  const hasTmp  = !! ds && (ds.remoteTmpSuffixes[remote] ?? []).length > 0;
  const hasSrcs = !! ds && (ds.remoteSuffixes[remote]    ?? []).length > 0;

  if (hasTmp)                       return tmpState(dayKind, isWs);
  if (hasSrcs)                      return { kind: 'sources' };
  if (dayKind === 'today' && isWs)  return { kind: 'missing' };

  return { kind: 'absent' };
}

/**
 * Shared `.tmp` classifier used by `localState` and `remoteState`. For REST
 * (`! isWs`) any `.tmp` is `progress` — REST tools backfill historically.
 * For WS, `today` is also `progress`; `pending` (yesterday within grace) is
 * `pending`; any earlier `.tmp` is stalled (`incomplete`).
 */
function tmpState(dayKind: DayKind, isWs: boolean): CellState {
  if (! isWs)                  return { kind: 'progress' };
  if (dayKind === 'today')     return { kind: 'progress' };
  if (dayKind === 'pending')   return { kind: 'pending'  };

  return { kind: 'incomplete' };
}

/**
 * Mega must hold everything from the table's first known day through the
 * last fully-closed day. `today` and `pending` are both still in flight —
 * absence in Mega is *expected* (`absent`), not a gap (`missing`).
 *
 * Takes the presence boolean directly: whether the bucket is in Mega. The
 * caller decides presence uniformly (daily file this year, year-tar before) —
 * this function doesn't care how storage works.
 *
 * **The bucket is the whole expectation**, for every table and whether or not
 * it went through a preparation stage. A second root once held the raw sources
 * a bucket was built from, and a sourced table needed both to read `stored`,
 * with either alone rendering as a split cell. Source backup was retired along
 * with BitMEX collection, so there is one artifact per day and the answer is
 * stored or it is not.
 */
export function megaState(hasBucket: boolean, dayKind: DayKind): CellState {
  if (hasBucket)          return { kind: 'stored' };
  if (dayKind === 'past') return { kind: 'missing' };

  return { kind: 'absent' };
}
