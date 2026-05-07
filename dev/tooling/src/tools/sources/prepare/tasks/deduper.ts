import { debug } from '../../../../shared/ui/logger';
import type { Action, DedupConfig, DedupHandler, DedupStore, KeyStore, PreparedMessage } from '../types';

const plog = (msg: string): void => { debug(`[${new Date().toISOString()}] ${msg}`); };

/**
 * Per-table dedup rules.
 *
 *   - `globalLimit`: insert/delete key-store size. `Infinity` = unbounded, never evicts.
 *   - `updateLimit`: update key-store size; falls back to `globalLimit`. Size `1` =
 *                    contiguous (drop only if identical to the previous message).
 *   - `updateWindow`: ms time constraint on update matches; `null` = no constraint.
 */
const TABLE_CONFIG: Record<string, DedupConfig> = {
  // No-update tables: every distinct insert is real and unique forever.
  announcement:        { updateWindow: null,  globalLimit: Infinity                 },
  liquidation:         { updateWindow: null,  globalLimit: Infinity                 },
  publicNotifications: { updateWindow: null,  globalLimit: Infinity                 },

  // Chat: sources can lag by seconds (not just ms), so dedup identical updates within a reasonable window.
  chat:                { updateWindow: 60000, globalLimit: Infinity                 },

  // instrument / orderBookL2: same-ms oscillations are real events — only drop
  // adjacent identical updates, no time constraint.
  instrument:          { updateWindow: null,  globalLimit: Infinity, updateLimit: 1 },
  orderBookL2:         { updateWindow: null,  globalLimit: 100,      updateLimit: 1 },

  // connected: ghost-sub dupes arrive within ms; legitimate re-snapshots are ~30 s
  // apart. A 15 s window drops the dupes and keeps the next real snapshot.
  connected:           { updateWindow: 15000, globalLimit: Infinity, updateLimit: 1 },
};

/**
 * Drop duplicate messages per the table's `TABLE_CONFIG` rules. Partials
 * always pass through.
 */
export async function* dedup(
  source:    AsyncGenerator<PreparedMessage[]>,
  tableName: string,
  onDrop:    (msg: PreparedMessage) => void = () => { /* no-op */ },
): AsyncGenerator<PreparedMessage[]> {
  const store = createDedupStore(tableName);
  const out:   PreparedMessage[] = [];

  for await (const batch of source) {
    for (const msg of batch) {
      if (store.isDuplicate(msg)) {
        onDrop(msg);
        plog(`[DEDUP] drop: ts=${msg.ts} action=${msg.action}`);
        continue;
      }

      out.push(msg);
    }

    if (out.length > 0) yield out.splice(0);
  }

  if (out.length > 0) yield out;
}

// ── Dedup store ───────────────────────────────────────────────────────────────

function createDedupStore(tableName: keyof typeof TABLE_CONFIG): DedupStore {
  const { globalLimit, updateLimit, updateWindow } = TABLE_CONFIG[tableName];

  const handlers: Record<Partial<Action>, DedupHandler> = {
    partial: storeHandler(0),
    insert:  storeHandler(globalLimit),
    delete:  storeHandler(globalLimit),
    update:  storeHandler(updateLimit ?? globalLimit, updateWindow),
  };

  return {
    isDuplicate(msg: PreparedMessage) {
      const handler = handlers[msg.action] ?? handlers.partial;

      return handler.isDuplicate(msg);
    },
  };
}

function storeHandler(limit: number, window: number | null = null): DedupHandler {
  if (! limit) return { isDuplicate: () => false };

  const store = createKeyStore(limit);

  /**
   * Entries without timestamp in timestamped tables carry a timestamp === ''
   * (as opposed to timestamp === null for timeless tables). These rows lack a
   * proper unique key, which is a required assumption to identify duplicates in
   * deduping stores with limit > 1 (0: "no dedup", 1: "contiguous dupes only").
   */
  const hasIncompleteKey = (msg: PreparedMessage) => limit > 1 && msg.timestamp === '';

  return {
    isDuplicate(msg: PreparedMessage): boolean {
      const key   = contentKey(msg);
      const minTs = window === null ? undefined : msg.tsMs - window;

      if (store.check(key, minTs)) return true;

      if (! hasIncompleteKey(msg))
        store.store(key, msg.tsMs);

      return false;
    },
  };
}

function contentKey(msg: PreparedMessage): string {
  const firstCommaIdx = msg.rows[0]!.indexOf(',');

  return msg.rows.join('\n').slice(firstCommaIdx);
}

// ── Key store ─────────────────────────────────────────────────────────────────

/**
 * Bounded key store with optional time constraint. `limit = 1` keeps only the
 * last key (contiguous match). `limit > 1` uses a rotating dual-set: retains
 * between `limit` and `2 * limit` keys before evicting the older half.
 */
function createKeyStore(limit: number): KeyStore {
  if (limit === 1) return createContiguousStore();

  const stores: [Set<string>, Set<string>]                 = [new Set(), new Set()];
  const tsMaps: [Map<string, number>, Map<string, number>] = [new Map(), new Map()];
  let current = 0;
  let next    = 1;

  return {
    store(key: string, ts: number): void {
      if (stores[current].size >= limit) {
        [current, next] = [next, current];
        stores[current] = new Set();
        tsMaps[current] = new Map();
      }

      stores[current].add(key);
      tsMaps[current].set(key, ts);
    },

    check(key: string, minTs?: number): boolean {
      const inStore = stores[current].has(key) || stores[next].has(key);
      const ts      = () => tsMaps[current].get(key) ?? tsMaps[next].get(key);
      const inRange = minTs === undefined || (ts() ?? 0) >= minTs;

      return inStore && inRange;
    },
  };
}

function createContiguousStore(): KeyStore {
  let lastKey: string | null = null;
  let lastTs = 0;

  return {
    store(key: string, ts: number): void {
      lastKey = key;
      lastTs  = ts;
    },

    check(key: string, minTs?: number): boolean {
      return lastKey === key && (minTs === undefined || lastTs >= minTs);
    },
  };
}

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_createDedupStore = createDedupStore;
export const _test_TABLE_CONFIG     = TABLE_CONFIG;
