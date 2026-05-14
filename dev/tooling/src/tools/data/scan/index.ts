import { fromDay } from '../options';
import { ALL_TABLES } from './tables';
import { DayState, ScanConfig, TableState, VaultState } from './types';
import { LocalEntry, scanLocal } from './local';
import { MegaScan, scanMega } from './mega';
import { RemoteEntry, scanRemote } from './remote';

/**
 * Re-scans `state.config.localBase` and overlays the fresh local-disk fields
 * onto `state` in place. Remote and Mega data are untouched.
 *
 * Used by the interactive loop right before tasks that consume what earlier
 * tasks may have produced on disk (e.g. backup-bucket after prepare). If a
 * prior task was skipped or failed, its outputs simply don't appear on disk,
 * so the refreshed state reflects reality.
 */
export function refreshLocal(state: VaultState): void {
  for (const table of state.tables) {
    for (const day of table.days.values()) {
      day.localSuffixes    = [];
      day.localTmpSuffixes = [];
      day.localBucket      = false;
      day.localBucketTmp   = false;
    }
  }

  for (const e of scanLocal(state.config.localBase)) {
    const table = state.tables.find(t => t.name === e.table);

    if (! table) continue;

    let day = table.days.get(e.day);

    if (! day) {
      day = emptyDay(e.day);
      table.days.set(e.day, day);
    }

    if (e.suffix !== '') {
      if (e.isTmp) day.localTmpSuffixes.push(e.suffix);
      else         day.localSuffixes.push(e.suffix);
    } else if (e.isTmp) {
      day.localBucketTmp = true;
    } else {
      day.localBucket = true;
    }
  }

  for (const table of state.tables) {
    for (const day of table.days.values()) {
      day.localSuffixes.sort();
      day.localTmpSuffixes.sort();
    }
  }

  applyFromFilter(asMap(state.tables));
}

function emptyDay(day: string): DayState {
  return {
    day,
    localSuffixes:     [],
    localTmpSuffixes:  [],
    remoteSuffixes:    {},
    remoteTmpSuffixes: {},
    megaSources:       [],
    localBucket:       false,
    localBucketTmp:    false,
    megaBucket:        false,
  };
}

function asMap(tables: TableState[]): Map<string, TableState> {
  const m = new Map<string, TableState>();

  for (const t of tables) m.set(t.name, t);

  return m;
}

/**
 * Runs all three sub-scanners and merges their output into a unified `VaultState`.
 *
 * `mega` and each `remote` are scanned in parallel. The local scan is fast and
 * synchronous; remotes and Mega dominate wall time. Caller is expected to have
 * already verified `mega-cmd` availability via `checkMegaAvailable`.
 */
export async function scanAll(config: ScanConfig): Promise<VaultState> {
  const local = scanLocal(config.localBase);

  const [mega, ...remoteResults] = await Promise.all([
    scanMega(config.megaVault, config.megaRaw),
    ...config.remotes.map(r => scanRemote(r)),
  ]);

  const remote: RemoteEntry[] = remoteResults.flat();

  const tables = buildTables(local, remote, mega);

  return {
    config,
    tables,
    scannedAt: new Date(),
  };
}

/**
 * Merges all four entry streams (local, remote, mega-raw, mega-vault) into
 * one `TableState` per known table. Applies the global `--from` filter at the
 * end so day filtering remains consistent across scanners.
 */
function buildTables(
  local:  LocalEntry[],
  remote: RemoteEntry[],
  mega:   MegaScan,
): TableState[] {
  const states = new Map<string, TableState>();

  for (const t of ALL_TABLES) {
    states.set(t.name, {
      name:     t.name,
      origin:   t.origin,
      days:     new Map(),
      megaTars: [],
    });
  }

  for (const e of local) {
    const day = ensureDay(states, e.table, e.day);

    if (e.suffix !== '') {
      if (e.isTmp) day.localTmpSuffixes.push(e.suffix);
      else         day.localSuffixes.push(e.suffix);
    } else if (e.isTmp) {
      day.localBucketTmp = true;
    } else {
      day.localBucket = true;
    }
  }

  for (const e of remote) {
    const day  = ensureDay(states, e.table, e.day);
    const map  = e.isTmp ? day.remoteTmpSuffixes : day.remoteSuffixes;
    const list = map[e.remote] ?? (map[e.remote] = []);

    list.push(e.suffix);
  }

  for (const e of mega.raw) {
    const day = ensureDay(states, e.table, e.day);

    day.megaSources.push(e.suffix);
  }

  for (const e of mega.vault) {
    const day = ensureDay(states, e.table, e.day);

    day.megaBucket = true;
  }

  for (const t of mega.tars) {
    const state = states.get(t.table);

    if (state) state.megaTars.push(t.year);
  }

  for (const state of states.values()) {
    state.megaTars.sort((a, b) => a - b);

    for (const day of state.days.values()) {
      day.localSuffixes.sort();
      day.localTmpSuffixes.sort();
      day.megaSources.sort();

      for (const k of Object.keys(day.remoteSuffixes))    day.remoteSuffixes[k]!.sort();
      for (const k of Object.keys(day.remoteTmpSuffixes)) day.remoteTmpSuffixes[k]!.sort();
    }
  }

  applyFromFilter(states);

  return [...states.values()];
}

function ensureDay(states: Map<string, TableState>, table: string, day: string): DayState {
  const state = states.get(table);

  if (! state) {
    throw new Error(`Internal: unknown table "${table}" in scan output`);
  }

  let entry = state.days.get(day);

  if (! entry) {
    entry = {
      day,
      localSuffixes:     [],
      localTmpSuffixes:  [],
      remoteSuffixes:    {},
      remoteTmpSuffixes: {},
      megaSources:       [],
      localBucket:       false,
      localBucketTmp:    false,
      megaBucket:        false,
    };
    state.days.set(day, entry);
  }

  return entry;
}

function applyFromFilter(states: Map<string, TableState>): void {
  const cut = fromDay();

  if (! cut) return;

  for (const state of states.values()) {
    for (const [day] of state.days) {
      if (day < cut) state.days.delete(day);
    }

    state.megaTars = state.megaTars.filter(y => y >= Number(cut.slice(0, 4)));
  }
}
