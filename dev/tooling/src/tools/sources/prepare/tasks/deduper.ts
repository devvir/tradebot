import crypto from 'node:crypto';
import { debug } from '../../../../shared/ui/logger';
import { getVaultColumns } from '../../tables';
import type { PreparedMessage } from '../types';

const plog = (msg: string): void => { debug(`[${new Date().toISOString()}] ${msg}`); };

type DedupStrategy =
  | { kind: 'hash'       }
  | { kind: 'contiguous' }
  | { kind: 'hybrid'     };

/**
 * Per-table dedup strategy.
 *
 *  - `announcement`, `publicNotifications`, `chat` → full hash (events repeat across ghost subs)
 *  - `liquidation`                                 → hybrid (hash for insert/delete, contiguous for update)
 *  - `connected`, `instrument`, `orderBookL2`      → contiguous (ghost dups land adjacent post-sort)
 *  - unknown table                                 → hash (safe default)
 */
function strategyFor(tableName: string): DedupStrategy {
  switch (tableName) {
    case 'announcement':
    case 'publicNotifications':
    case 'chat':
      return { kind: 'hash' };

    case 'liquidation':
      return { kind: 'hybrid' };

    case 'connected':
    case 'instrument':
    case 'orderBookL2':
      return { kind: 'contiguous' };

    default:
      return { kind: 'hash' };
  }
}

/**
 * DEDUP — remove duplicates from the post-MERGE stream.
 *
 * Strategies:
 *  - `hash`       : full content-hash dedup. Maintains a `Set<string>` of every
 *                   hash seen and drops repeats. No eviction. Used for small
 *                   tables (chat, announcement, publicNotifications) whose
 *                   per-day hash count is small enough to keep in memory.
 *  - `contiguous` : drops a message whose hash matches the immediately
 *                   preceding one. O(1) memory — single `lastHash` string.
 *                   Used for large tables (instrument, orderBookL2) and for
 *                   `connected` (oscillating counters).
 *  - `hybrid`     : `hash` for `insert`/`delete`, `contiguous` for everything
 *                   else (used by `liquidation`).
 *
 * Partials (`action === 'partial'`) are passed through unconditionally — they
 * are ground-truth state snapshots and must never be suppressed.
 *
 * DEDUP is purely CPU-bound: no I/O, no awaiting, no buffering beyond the
 * batch boundary. It can consume everything MERGE emits without becoming a
 * bottleneck.
 */
export async function* dedup(
  source:    AsyncGenerator<PreparedMessage[]>,
  tableName: string,
  onDrop:    (msg: PreparedMessage) => void = () => { /* no-op */ },
): AsyncGenerator<PreparedMessage[]> {
  const strategy = strategyFor(tableName);
  const columns  = getVaultColumns(tableName) ?? [];

  switch (strategy.kind) {
    case 'hash':
      yield* dedupHash(source, columns, onDrop);

      return;

    case 'contiguous':
      yield* dedupContiguous(source, columns, onDrop);

      return;

    case 'hybrid':
      yield* dedupHybrid(source, columns, onDrop);

      return;
  }
}

// ── Internal: SHA-256 content hash ────────────────────────────────────────────

/**
 * SHA-256 over all rows, all columns in column order. `_date_` is blanked so
 * the same exchange event received at different reception times collapses to
 * one hash. Every other column (including `date` in chat — the message
 * creation timestamp) is included verbatim.
 *
 * Key format: `"${action}|${digest}"`.
 */
function computeHash(action: string, rows: Record<string, string>[], columns: string[]): string {
  const hash = crypto.createHash('sha256');

  for (const row of rows) {
    for (const col of columns) {
      const val = col === '_date_' ? '' : (row[col] ?? '');

      hash.update(val);
      hash.update('\x1f');
    }

    hash.update('\n');
  }

  return `${action}|${hash.digest('hex')}`;
}

// ── Hash strategy ────────────────────────────────────────────────────────────

async function* dedupHash(
  source:  AsyncGenerator<PreparedMessage[]>,
  columns: string[],
  onDrop:  (msg: PreparedMessage) => void,
): AsyncGenerator<PreparedMessage[]> {
  const seen         = new Set<string>();
  const out:           PreparedMessage[] = [];
  let   totalDropped = 0;

  for await (const batch of source) {
    let batchDropped = 0;

    for (const msg of batch) {
      if (msg.action === 'partial') {
        out.push(msg);
        continue;
      }

      const hash = computeHash(msg.action, msg.rows, columns);

      if (seen.has(hash)) {
        onDrop(msg);
        batchDropped++;
        totalDropped++;
        continue;
      }

      seen.add(hash);
      out.push(msg);
    }

    plog(`[DEDUP:hash] in: ${batch.length} | out: ${out.length} | dropped: ${batchDropped} | total dropped: ${totalDropped}`);

    if (out.length > 0) {
      yield out.splice(0);
    }
  }

  if (out.length > 0) {
    yield out;
  }
}

// ── Contiguous strategy ──────────────────────────────────────────────────────

async function* dedupContiguous(
  source:  AsyncGenerator<PreparedMessage[]>,
  columns: string[],
  onDrop:  (msg: PreparedMessage) => void,
): AsyncGenerator<PreparedMessage[]> {
  let lastHash:     string | null = null;
  const out:          PreparedMessage[] = [];
  let   totalDropped = 0;

  for await (const batch of source) {
    let batchDropped = 0;

    for (const msg of batch) {
      if (msg.action === 'partial') {
        out.push(msg);
        // A partial does not reset `lastHash` — non-partial dedup remains
        // anchored to the last non-partial we emitted, since partials carry
        // no comparable content.
        continue;
      }

      const hash = computeHash(msg.action, msg.rows, columns);

      if (hash === lastHash) {
        onDrop(msg);
        batchDropped++;
        totalDropped++;
        continue;
      }

      lastHash = hash;
      out.push(msg);
    }

    plog(`[DEDUP:contiguous] in: ${batch.length} | out: ${out.length} | dropped: ${batchDropped} | total dropped: ${totalDropped}`);

    if (out.length > 0) {
      yield out.splice(0);
    }
  }

  if (out.length > 0) {
    yield out;
  }
}

// ── Hybrid strategy (liquidation) ────────────────────────────────────────────

async function* dedupHybrid(
  source:  AsyncGenerator<PreparedMessage[]>,
  columns: string[],
  onDrop:  (msg: PreparedMessage) => void,
): AsyncGenerator<PreparedMessage[]> {
  const seen         = new Set<string>();
  let   lastHash:      string | null = null;
  const out:           PreparedMessage[] = [];
  let   totalDropped = 0;

  for await (const batch of source) {
    let batchDropped = 0;

    for (const msg of batch) {
      if (msg.action === 'partial') {
        out.push(msg);
        continue;
      }

      const hash             = computeHash(msg.action, msg.rows, columns);
      const useHashStrategy  = msg.action === 'insert' || msg.action === 'delete';

      if (useHashStrategy) {
        if (seen.has(hash)) {
          onDrop(msg);
          batchDropped++;
          totalDropped++;
          continue;
        }

        seen.add(hash);
        out.push(msg);
        lastHash = hash;
      } else {
        // contiguous for update
        if (hash === lastHash) {
          onDrop(msg);
          batchDropped++;
          totalDropped++;
          continue;
        }

        lastHash = hash;
        out.push(msg);
      }
    }

    plog(`[DEDUP:hybrid] in: ${batch.length} | out: ${out.length} | dropped: ${batchDropped} | total dropped: ${totalDropped}`);

    if (out.length > 0) {
      yield out.splice(0);
    }
  }

  if (out.length > 0) {
    yield out;
  }
}

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_computeHash = computeHash;
