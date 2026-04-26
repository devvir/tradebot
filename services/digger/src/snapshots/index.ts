import { createDatabase, type Database, type BitmexTable as DBTable } from '@devvir/bitmex-database';
import type { BitmexTable, BitmexFieldType, WsMessage } from '../types';

/**
 * In-memory accumulator that mirrors what consumers of the replay stream
 * have seen. Fed by the streaming engine on every published message; queried
 * by the commands API on subscribe to produce a `partial` reflecting the
 * current state of any already-warm table.
 *
 * On cold subscribe, the backfill helper (commands/backfill.ts) seeds this
 * accumulator from MongoDB by replaying the most recent stored partial and
 * the deltas leading up to the requested clock position — so subscribers
 * always receive a real, up-to-date partial.
 *
 * No MongoDB, no Redis, no clock awareness. Just a stateful wrapper around
 * `@devvir/bitmex-database`.
 */

let db: Database = createDatabase();

// ── Public API ────────────────────────────────────────────────────────────────

/** Apply a published WS message to the accumulator. Called once per message. */
export const feed = (msg: WsMessage): void => {
  db.apply(msg as Parameters<Database['apply']>[0]);
};

/**
 * Return a `partial` WS message representing the current state for `table`.
 * Returns null when the accumulator has not yet seen any message for that table —
 * the caller falls back to the handler's static partial in that case.
 */
export const buildSnapshot = (table: BitmexTable): WsMessage | null => {
  const view = db.view(table as DBTable);

  if (Object.keys(view.types).length === 0) return null;

  return {
    table,
    action: 'partial',
    keys:   view.keys as string[],
    types:  view.types as Record<string, BitmexFieldType>,
    filter: {},
    data:   Array.from(view.data),
  };
};

/**
 * Drop all accumulated state and start over with a fresh database.
 * Called by `POST /set-clock` after the queues have drained — the previous
 * snapshots reflect the old clock position and would be misleading once the
 * stream resumes from a new point in time.
 */
export const reset = (): void => {
  db = createDatabase();
};

// ── Test-only ─────────────────────────────────────────────────────────────────

export const _test_reset = reset;
