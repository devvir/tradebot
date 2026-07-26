import { createDatabase, BitmexTable as DBTable, type BitmexMessage } from '@devvir/bitmex-database';
import type { BitmexTable, BitmexFieldType } from '@tradebot/types';
import type { WsMessage, DataItem } from './types';

/**
 * The snapshot accumulator — digger's one piece of in-memory state. A thin
 * wrapper over `@devvir/bitmex-database` in `wsPartialMode`, fed every emitted
 * message so it mirrors exactly what digger has streamed up to the clock.
 *
 * Serves two things: the **warm partial** sent to a late subscriber of an
 * already-streaming table, and the **state-table REST** endpoints (current
 * orderBookL2 / instrument). It is reset on a clock seek. It never folds cold
 * partials by itself — the reader drives that, applying the provider's partial
 * and catch-up deltas through `feed`.
 */

let db   = createDatabase();
const warm = new Set<string>();

// ── Public API ────────────────────────────────────────────────────────────────

/** Apply one WS message (delta or partial). Tracks which tables have a partial. */
export const feed = (msg: WsMessage): void => {
  db.apply(msg as unknown as BitmexMessage, true);

  if (msg.action === 'partial') warm.add(msg.table);
};

/**
 * Build the current-state `partial` for a warm table, or `null` if cold. Uses the
 * accumulator's own keys/types (from the partial it absorbed) and current data.
 */
export const buildPartial = (table: BitmexTable): WsMessage | null => {
  if (! warm.has(table)) return null;

  const view = db.view(table as unknown as DBTable);

  const msg: WsMessage = {
    table,
    action: 'partial',
    keys:   view.keys as string[],
    types:  view.types as Record<string, BitmexFieldType>,
    filter: {},
    data:   [...view.data] as DataItem[],
  };

  if (table === 'chat') msg.filterKey = 'channelID';

  return msg;
};

/** Drop all state — called on a clock seek. */
export const reset = (): void => {
  db = createDatabase();
  warm.clear();
};

// ── Test-only ─────────────────────────────────────────────────────────────────

export const _test_reset = reset;
