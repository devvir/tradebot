import { TableOrigin } from '../scan/tables';
import { DayState } from '../scan/types';

/**
 * What "kind of day" we're rendering, relative to wall-clock time.
 *
 *   - `today`   — current UTC day. WS live collection expected.
 *   - `pending` — yesterday during the 1-hour grace window (00:00–00:59 UTC
 *                 of the next day). `sources prepare` deliberately waits one
 *                 hour after midnight before finalising a day's bucket, in
 *                 case data arrives late (BitMEX hiccup, queue lag, crash
 *                 recovery, …). A `.tmp` for this day is *expected*, not stalled.
 *   - `past`    — any earlier day. A `.tmp` here is stalled / abnormal.
 */
export type DayKind = 'today' | 'pending' | 'past';

/**
 * Structured per-cell state. Pure data — no presentation strings or colors.
 * The display layer is the only place that decides labels and colors.
 *
 * The `half` kind captures Mega's split bucket/sources state for WS tables
 * (one half stored, the other missing); both stored is `stored`, both
 * missing is `missing`.
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
  | { kind: 'missing' }
  | { kind: 'half'; bucket: 'stored' | 'missing'; sources: 'stored' | 'missing' };

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

/** Structural comparison for two state tuples. Used to detect range breaks. */
export function statesEqual(a: CellState[], b: CellState[]): boolean {
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    if (! oneStateEqual(a[i]!, b[i]!)) return false;
  }

  return true;
}

function oneStateEqual(a: CellState, b: CellState): boolean {
  if (a.kind !== b.kind) return false;

  if (a.kind === 'half' && b.kind === 'half') {
    return a.bucket === b.bucket && a.sources === b.sources;
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
 */
export function megaState(
  ds:      DayState | undefined,
  origin:  TableOrigin,
  dayKind: DayKind,
  hasTar:  boolean,
): CellState {
  if (hasTar) return { kind: 'stored' };

  const hasBucket  = !! ds && ds.megaBucket;
  const hasSources = !! ds && ds.megaSources.length > 0;
  const isPastDay  = dayKind === 'past';

  if (origin === 'rest') {
    if (hasBucket) return { kind: 'stored' };
    if (isPastDay) return { kind: 'missing' };

    return { kind: 'absent' };
  }

  // WS
  if (hasBucket && hasSources) return { kind: 'stored' };

  if (! hasBucket && ! hasSources) {
    if (isPastDay) return { kind: 'missing' };

    return { kind: 'absent' };
  }

  return {
    kind:    'half',
    bucket:  hasBucket  ? 'stored' : 'missing',
    sources: hasSources ? 'stored' : 'missing',
  };
}
