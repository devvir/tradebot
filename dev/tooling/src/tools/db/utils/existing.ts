import { getEnv } from '../../../shared/utils/env';
import { syncStatesForCollections } from './sync';
import { pairFilename, pairKey } from '../types';
import type { Pair, ExistingStatus, SyncState } from '../types';

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Check, for every pair, whether the canonical file exists locally (at
 * `<outDir>/<collection>/<key>.archive.gz`) and/or on Mega (at
 * `<DB_DUMP_MEGA_DIR>/<collection>/<key>.archive.gz`).
 *
 * Pass `outDir: null` to skip the local check (purge doesn't care).
 *
 * Returns a map keyed by `pairKey(pair)` projected from the richer
 * `SyncState[]` produced by `utils/sync.ts` — same single mega-ls per
 * collection in parallel, just narrowed to booleans for the legacy
 * existing/skip-prompt callers.
 */
export async function checkExisting(
  pairs:  Pair[],
  outDir: string | null,
): Promise<Map<string, ExistingStatus>> {
  const megaBase    = getEnv('DB_DUMP_MEGA_DIR') ?? null;
  const collections = [...new Set(pairs.map(p => p.collection))];
  const states      = await syncStatesForCollections(collections, outDir, megaBase);

  const stateByKey = new Map<string, SyncState>();

  for (const s of states) stateByKey.set(`${s.collection}|${s.file}`, s);

  const result = new Map<string, ExistingStatus>();

  for (const pair of pairs) {
    const state = stateByKey.get(`${pair.collection}|${pairFilename(pair)}`);

    result.set(pairKey(pair), {
      local: Boolean(state?.local),
      mega:  Boolean(state?.mega),
    });
  }

  return result;
}

/** Pairs whose file is already present locally and/or on Mega. */
export function pairsExisting(
  pairs:    Pair[],
  existing: Map<string, ExistingStatus>,
): Pair[] {
  return pairs.filter(p => {
    const s = existing.get(pairKey(p));

    return Boolean(s && (s.local || s.mega));
  });
}

/** Pairs whose file is NOT backed up on Mega. */
export function pairsNotOnMega(
  pairs:    Pair[],
  existing: Map<string, ExistingStatus>,
): Pair[] {
  return pairs.filter(p => ! existing.get(pairKey(p))?.mega);
}
