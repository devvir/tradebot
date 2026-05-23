import { getEnv } from '../../../shared/utils/env';
import { syncStatesForCollections } from '../utils/sync';
import type { Pair, SyncState } from '../types';
import type { RestoreTarget, OverlapConflict } from './types';

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Resolve `Pair[]` from the arg parser into a flat list of `RestoreTarget`s
 * using the shared sync-state helper (one mega-ls per collection in parallel,
 * one local readdir per collection).
 *
 *   - Pair with a date → exact lookup for that single filename.
 *   - Pair without a date → emit one target per archive found on either side.
 *
 * Targets carry both local and mega metadata when each side has the file;
 * either may be null. A target with both null is never emitted (filtered by
 * the sync helper).
 */
export async function discoverTargets(pairs: Pair[], outDir: string): Promise<RestoreTarget[]> {
  const megaBase    = getEnv('DB_DUMP_MEGA_DIR') ?? null;
  const collections = [...new Set(pairs.map(p => p.collection))];
  const states      = await syncStatesForCollections(collections, outDir, megaBase);

  // Index states by collection for per-pair filtering.
  const statesByColl = new Map<string, SyncState[]>();

  for (const s of states) {
    if (! statesByColl.has(s.collection)) statesByColl.set(s.collection, []);

    statesByColl.get(s.collection)!.push(s);
  }

  const targets: RestoreTarget[] = [];
  const seen    = new Set<string>();   // dedupe when the same (coll, file) is requested via multiple pairs

  for (const pair of pairs) {
    const collStates = statesByColl.get(pair.collection) ?? [];

    if (pair.date) {
      const wanted = `${pair.date.key}.archive.gz`;
      const state  = collStates.find(s => s.file === wanted);

      if (state) addUnique(state, targets, seen);
    } else {
      for (const state of collStates) addUnique(state, targets, seen);
    }
  }

  return targets;
}

/**
 * Detect coarser-than-finer overlaps within each collection. The execution
 * step assumes none; this guard runs before any download/restore.
 *
 *   - `all` overlaps with any dated key
 *   - `YYYY` overlaps with any `YYYYMM*` or `YYYYMMDD*` in that year
 *   - `YYYYMM` overlaps with any `YYYYMMDD*` in that month
 */
export function findOverlaps(targets: RestoreTarget[]): OverlapConflict[] {
  const byCollection = new Map<string, string[]>();

  for (const t of targets) {
    if (! byCollection.has(t.collection)) byCollection.set(t.collection, []);

    byCollection.get(t.collection)!.push(t.key);
  }

  const conflicts: OverlapConflict[] = [];

  for (const [collection, keys] of byCollection) {
    const years  = new Set<string>();
    const months = new Set<string>();
    const days   = new Set<string>();
    let   hasAll = false;

    for (const k of keys) {
      if (k === 'all')         hasAll = true;
      else if (k.length === 4) years.add(k);
      else if (k.length === 6) months.add(k);
      else if (k.length === 8) days.add(k);
    }

    if (hasAll) {
      for (const k of keys) {
        if (k !== 'all') conflicts.push({ collection, broader: 'all', narrower: k });
      }
    }

    for (const m of months) {
      const y = m.slice(0, 4);

      if (years.has(y)) conflicts.push({ collection, broader: y, narrower: m });
    }

    for (const d of days) {
      const y = d.slice(0, 4);
      const m = d.slice(0, 6);

      if (years.has(y))  conflicts.push({ collection, broader: y, narrower: d });
      if (months.has(m)) conflicts.push({ collection, broader: m, narrower: d });
    }
  }

  return conflicts;
}

// ── Internals ────────────────────────────────────────────────────────────────

function addUnique(state: SyncState, targets: RestoreTarget[], seen: Set<string>): void {
  const key = `${state.collection}|${state.file}`;

  if (seen.has(key)) return;

  seen.add(key);

  targets.push({
    collection: state.collection,
    key:        state.file.replace(/\.archive\.gz$/, ''),
    filename:   state.file,
    local:      state.local,
    mega:       state.mega,
  });
}
