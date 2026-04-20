import { createDatabase, BitmexTable } from '@devvir/bitmex-database';
import type { BitmexMessage, PartialMessage } from '@devvir/bitmex-database';
import { logger } from '@devvir/service-kit';
import type { BitmexWsMessage } from '../types';

// ---- Types --------------------------------------------------------------

export type SnapshotResult =
  | { ok: true;  snapshot: BitmexWsMessage; counter: number }
  | { ok: false; reason: 'not-found' };

export interface Snapshots {
  apply: (msg: BitmexMessage | PartialMessage, counter: number) => void;
  get:   (table: string, symbol?: string, account?: string) => SnapshotResult;
}

// ---- Factory ------------------------------------------------------------

/**
 * In-memory snapshot accumulator. Consumes BitMEX-format deltas, maintains
 * per-table state via `@devvir/bitmex-database`, and serves filtered
 * snapshots with an ordering counter for subscription bootstrap.
 */
export const createSnapshots = (): Snapshots => {
  const db       = createDatabase();
  const counters: Record<string, number> = {};
  const tables   = new Set<string>();

  const apply = (msg: BitmexMessage | PartialMessage, counter: number): void => {
    if ('filter' in msg && msg.filter && 'symbol' in msg.filter) {
      logger.error({ table: msg.table, filter: msg.filter }, 'Received pre-filtered partial (not supported)');
      return;
    }

    db.apply(msg, true);

    counters[msg.table] = counter;

    if (msg.action === 'partial') tables.add(msg.table);
  };

  const get = (table: string, symbol?: string, account?: string): SnapshotResult => {
    if (! tables.has(table)) return { ok: false, reason: 'not-found' };

    const view   = db.view(table as BitmexTable);
    const filter: Record<string, string> = {};

    let data: unknown[] = db.snapshot(table as BitmexTable);

    if (symbol && 'symbol' in view.types) {
      filter.symbol = symbol;
      data = data.filter(r => (r as Record<string, unknown>).symbol === symbol);
    }

    if (account && 'account' in view.types) {
      filter.account = account;
      data = data.filter(r => Number((r as Record<string, unknown>).account) === Number(account));
    }

    const snapshot = {
      table,
      action: 'partial',
      keys:   view.keys,
      types:  view.types,
      filter,
      data,
    } as unknown as BitmexWsMessage;

    return { ok: true, snapshot, counter: counters[table] ?? 0 };
  };

  return { apply, get };
};
